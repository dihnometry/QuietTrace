// QuietTracE — motor de visualización (render puro, sin datos).
//
// `render(model)` dibuja la PCB (2D planta + 3D stackup) antes/después y las
// gráficas de valor, con animación de construcción.
//
// Tema único "Hybrid": negro + verde neón, bordes nítidos, glow y liquid glass.
// NO usa `backend` ni envía jobs.

const COL = {
  board: '#000000',
  block: '#141414', blockEdge: '#4a4a4a', blockSide: '#0c0c0c', blockSideDark: '#080808',
  grid: '#3a3a3a',
  text: '#e9e9f0', muted: '#a8a8b4',
  L1: '#54ff57', L4: '#ff6fae', conflict: '#ff6b6b',
  coupling: '#54ff57', viaCost: '#ff6fae', conflictCost: '#ff6b6b',
  chartBg: '#0b0b0b', heatLow: '#161616',
  L1fill: '#102010', L2fill: '#171717', L3fill: '#171717', L4fill: '#241420',
};

const fmt = (n, d = 2) => Number(n).toFixed(d);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function hexLerp(a, b, t) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  const p = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${p.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function shade(hex, amt) {
  const p = hex.match(/\w\w/g).map((h) => parseInt(h, 16));
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + 255 * amt)));
  return `#${p.map((v) => f(v).toString(16).padStart(2, '0')).join('')}`;
}

let GID = 0;
const nid = () => `g${GID++}`;
let CHART_IDX = 0;

function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function vGrad(id, color, top, bottom) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${color}" stop-opacity="${top}"/>`
    + `<stop offset="100%" stop-color="${color}" stop-opacity="${bottom}"/></linearGradient>`;
}

function segInter(a, b, c, d) {
  const [x1, y1] = a, [x2, y2] = b, [x3, y3] = c, [x4, y4] = d;
  const dx1 = x2 - x1, dy1 = y2 - y1, dx2 = x4 - x3, dy2 = y4 - y3;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x3 - x1) * dy2 - (y3 - y1) * dx2) / den;
  const u = ((x3 - x1) * dy1 - (y3 - y1) * dx1) / den;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [x1 + t * dx1, y1 + t * dy1] : null;
}

function polyInter(pa, pb) {
  for (let i = 0; i < pa.length - 1; i++) {
    for (let j = 0; j < pb.length - 1; j++) {
      const p = segInter(pa[i], pa[i + 1], pb[j], pb[j + 1]);
      if (p) return p;
    }
  }
  return null;
}

// Ruteo realista de una pista: tramo recto, codo a 45° y tramo recto.
const RX0 = 16, RX1 = 104, LZ = 48;

function route(z1, z2) {
  const dz = z2 - z1, adz = Math.abs(dz), dx = RX1 - RX0;
  if (adz < 0.01) return [[RX0, z1], [RX1, z2]];
  const straight = Math.max(0, (dx - adz) / 2);
  return [[RX0, z1], [RX0 + straight, z1], [RX0 + straight + adz, z2], [RX1, z2]];
}

const zAt = (rank, nNets) => 5 + rank * ((LZ - 10) / (nNets - 1));
const traceDelay = (i) => (0.15 + i * 0.06).toFixed(2);
const lateDelay = (i, base = 0.8) => (base + i * 0.05).toFixed(2);

// --- PCB vista 2D (planta) --------------------------------------------------

function boardSvg(model, maps, assignment, title) {
  const { nidx, rankIn, rankOut } = maps;
  const W = 900, H = 452;
  const sx = (x) => 40 + x * (820 / 120);
  const sz = (z) => 60 + z * 6.25;
  const pt = ([x, z]) => [sx(x), sz(z)];
  const polyStr = (arr) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const nN = model.nets.length;

  let s = '';
  s += `<rect x="16" y="16" width="868" height="360" rx="12" fill="${COL.board}" stroke="${COL.blockEdge}"/>`;
  s += `<rect class="fade-late" x="40" y="120" width="100" height="200" rx="8" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text class="fade-late" x="90" y="215" text-anchor="middle" font-size="14" fill="${COL.text}">ADC08060</text>`;
  s += `<text class="fade-late" x="90" y="234" text-anchor="middle" font-size="10" fill="${COL.muted}">8 bits · 40 MSPS</text>`;
  s += `<rect class="fade-late" x="760" y="120" width="100" height="200" rx="8" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text class="fade-late" x="810" y="215" text-anchor="middle" font-size="14" fill="${COL.text}">FPGA</text>`;
  s += `<text class="fade-late" x="810" y="234" text-anchor="middle" font-size="10" fill="${COL.muted}">receptora</text>`;

  model.nets.forEach((n, i) => {
    const layer = assignment[nidx[n]];
    const color = layer === 0 ? COL.L1 : COL.L4;
    const pts = route(zAt(rankIn[n], nN), zAt(rankOut[n], nN)).map(pt);
    const dly = traceDelay(i);
    s += `<polyline class="trace${layer === 1 ? ' trace-l4' : ''}" style="animation-delay:${dly}s" pathLength="1" points="${polyStr(pts)}" fill="none" stroke="${color}" stroke-width="3.5" opacity="0.95"/>`;
    if (layer === 1) {
      pts.forEach(([x, y]) => { s += `<circle class="fade-late" style="animation-delay:${lateDelay(i)}s" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2.5"/>`; });
    }
    s += `<text class="fade-late" style="animation-delay:${dly}s" x="${(pts[0][0] - 8).toFixed(1)}" y="${(pts[0][1] + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${color}">${n}</text>`;
  });

  const alive = model.conflicts.filter(([a, b]) => assignment[nidx[a]] === assignment[nidx[b]]);
  alive.forEach(([a, b]) => {
    const pa = route(zAt(rankIn[a], nN), zAt(rankOut[a], nN)).map(pt);
    const pb = route(zAt(rankIn[b], nN), zAt(rankOut[b], nN)).map(pt);
    const p = polyInter(pa, pb);
    if (p) {
      s += `<circle class="pop-late" style="animation-delay:1s" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="12" fill="${COL.conflict}" fill-opacity="0.16" stroke="${COL.conflict}" stroke-width="2"/>`;
      s += `<text class="pop-late" style="animation-delay:1s" x="${p[0].toFixed(1)}" y="${(p[1] + 5).toFixed(1)}" text-anchor="middle" font-size="15" fill="${COL.conflict}">✕</text>`;
    }
  });

  const ly = 430;
  s += `<line x1="40" y1="${ly}" x2="70" y2="${ly}" stroke="${COL.L1}" stroke-width="3.5"/>`;
  s += `<text x="78" y="${ly + 4}" font-size="12" fill="${COL.muted}">L1</text>`;
  s += `<line x1="118" y1="${ly}" x2="148" y2="${ly}" stroke="${COL.L4}" stroke-width="3.5" stroke-dasharray="7 5"/>`;
  s += `<text x="156" y="${ly + 4}" font-size="12" fill="${COL.muted}">L4 (oculto)</text>`;
  s += `<circle cx="250" cy="${ly}" r="5" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2.5"/>`;
  s += `<text x="262" y="${ly + 4}" font-size="12" fill="${COL.muted}">vía</text>`;
  s += `<circle cx="322" cy="${ly}" r="9" fill="${COL.conflict}" fill-opacity="0.16" stroke="${COL.conflict}" stroke-width="2"/>`;
  s += `<text x="338" y="${ly + 4}" font-size="12" fill="${COL.muted}">conflicto</text>`;

  s += `<text x="${W / 2}" y="410" text-anchor="middle" font-size="14" fill="${COL.text}">${esc(title)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg>`;
}

// --- PCB vista 3D (stackup isométrico) --------------------------------------

function board3d(model, maps, assignment, title) {
  const { nidx, rankIn, rankOut } = maps;
  const W = 900, H = 620;
  const S = 5.0, OX = 160, OY = 40;
  const EX = { x: 1.0, y: 0.12 }, EZ = { x: -0.42, y: 0.26 };
  const Lx = 120, T = 4;
  const LAYER_H = { L1: 0, L2: 24, L3: 48, L4: 72 };
  const FILL = { L1: COL.L1fill, L2: COL.L2fill, L3: COL.L3fill, L4: COL.L4fill };
  const STROKE = { L1: COL.L1, L2: COL.muted, L3: COL.muted, L4: COL.L4 };
  const nN = model.nets.length;

  const P = (x, z, h) => [OX + (x * EX.x + z * EZ.x) * S, OY + (x * EX.y + z * EZ.y + h) * S];
  const pts = (arr) => arr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const route3 = (n, h) => route(zAt(rankIn[n], nN), zAt(rankOut[n], nN)).map(([x, z]) => P(x, z, h));

  let s = '';
  let traceIdx = 0;

  const slab = (h, fill, stroke, label) => {
    const A = P(0, 0, h), B = P(Lx, 0, h), C = P(Lx, LZ, h), D = P(0, LZ, h);
    const Cb = P(Lx, LZ, h + T), Db = P(0, LZ, h + T), Bb = P(Lx, 0, h + T);
    s += `<polygon points="${pts([D, C, Cb, Db])}" fill="${shade(fill, -0.30)}" stroke="${stroke}" stroke-width="1"/>`;
    s += `<polygon points="${pts([B, C, Cb, Bb])}" fill="${shade(fill, -0.48)}" stroke="${stroke}" stroke-width="1"/>`;
    s += `<polygon points="${pts([A, B, C, D])}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" opacity="0.5"/>`;
    const lp = P(4, LZ - 5, h);
    s += `<text x="${lp[0].toFixed(1)}" y="${lp[1].toFixed(1)}" font-size="12" fill="${stroke}">${label}</text>`;
  };

  const trace = (n, layer) => {
    const h = LAYER_H[layer];
    const color = layer === 'L1' ? COL.L1 : COL.L4;
    const rp = route3(n, h);
    const dly = traceDelay(traceIdx++);
    s += `<polyline class="trace${layer === 'L4' ? ' trace-l4' : ''}" style="animation-delay:${dly}s" pathLength="1" points="${pts(rp)}" fill="none" stroke="${color}" stroke-width="3.5" opacity="0.95"/>`;
    s += `<text class="fade-late" style="animation-delay:${dly}s" x="${(rp[0][0] - 6).toFixed(1)}" y="${(rp[0][1] + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${color}">${n}</text>`;
  };

  const byLayer = { L1: [], L4: [] };
  model.nets.forEach((n) => byLayer[assignment[nidx[n]] === 0 ? 'L1' : 'L4'].push(n));

  slab(LAYER_H.L4, FILL.L4, STROKE.L4, 'L4 · señales');
  byLayer.L4.forEach((n) => trace(n, 'L4'));
  slab(LAYER_H.L3, FILL.L3, STROKE.L3, 'L3 · GND');
  slab(LAYER_H.L2, FILL.L2, STROKE.L2, 'L2 · GND');
  slab(LAYER_H.L1, FILL.L1, STROKE.L1, 'L1 · señales');
  byLayer.L1.forEach((n) => trace(n, 'L1'));

  const box = (x0, x1, z0, z1, h, ht, label, sub) => {
    const B = P(x1, z0, h), C = P(x1, z1, h), D = P(x0, z1, h);
    const Ct = P(x1, z1, h - ht), Dt = P(x0, z1, h - ht), Bt = P(x1, z0, h - ht), At = P(x0, z0, h - ht);
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([D, C, Ct, Dt])}" fill="${COL.blockSide}" stroke="${COL.blockEdge}" stroke-width="1"/>`;
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([B, C, Ct, Bt])}" fill="${COL.blockSideDark}" stroke="${COL.blockEdge}" stroke-width="1"/>`;
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([At, Bt, Ct, Dt])}" fill="${COL.block}" stroke="${COL.blockEdge}" stroke-width="1.2"/>`;
    const c = P((x0 + x1) / 2, (z0 + z1) / 2, h - ht);
    s += `<text class="fade-late" style="animation-delay:0.5s" x="${c[0].toFixed(1)}" y="${(c[1] - 3).toFixed(1)}" text-anchor="middle" font-size="12" fill="${COL.text}">${label}</text>`;
    s += `<text class="fade-late" style="animation-delay:0.5s" x="${c[0].toFixed(1)}" y="${(c[1] + 11).toFixed(1)}" text-anchor="middle" font-size="10" fill="${COL.muted}">${sub}</text>`;
  };
  box(0, 14, 12, 36, LAYER_H.L1, 12, 'ADC08060', '8 bits · 40 MSPS');
  box(106, 120, 12, 36, LAYER_H.L1, 12, 'FPGA', 'receptora');

  let viaIdx = 0;
  byLayer.L4.forEach((n) => {
    [[RX0, zAt(rankIn[n], nN)], [RX1, zAt(rankOut[n], nN)]].forEach(([x, z]) => {
      const a = P(x, z, LAYER_H.L1), b = P(x, z, LAYER_H.L4);
      const dly = lateDelay(viaIdx++);
      s += `<line class="fade-late" style="animation-delay:${dly}s" x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${COL.L4}" stroke-width="2" opacity="0.85"/>`;
      s += `<circle class="fade-late" style="animation-delay:${dly}s" cx="${a[0].toFixed(1)}" cy="${a[1].toFixed(1)}" r="4" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2"/>`;
      s += `<circle class="fade-late" style="animation-delay:${dly}s" cx="${b[0].toFixed(1)}" cy="${b[1].toFixed(1)}" r="4" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2"/>`;
    });
  });

  model.conflicts.forEach(([a, b]) => {
    if (assignment[nidx[a]] !== assignment[nidx[b]]) return;
    const layer = assignment[nidx[a]] === 0 ? 'L1' : 'L4';
    const p = polyInter(route3(a, LAYER_H[layer]), route3(b, LAYER_H[layer]));
    if (p) {
      s += `<circle class="pop-late" style="animation-delay:1s" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="11" fill="${COL.conflict}" fill-opacity="0.18" stroke="${COL.conflict}" stroke-width="2"/>`;
      s += `<text class="pop-late" style="animation-delay:1s" x="${p[0].toFixed(1)}" y="${(p[1] + 5).toFixed(1)}" text-anchor="middle" font-size="14" fill="${COL.conflict}">✕</text>`;
    }
  });

  const ly = 578;
  s += `<line x1="40" y1="${ly}" x2="70" y2="${ly}" stroke="${COL.L1}" stroke-width="3.5"/>`;
  s += `<text x="78" y="${ly + 4}" font-size="12" fill="${COL.muted}">L1 (señales)</text>`;
  s += `<line x1="182" y1="${ly}" x2="212" y2="${ly}" stroke="${COL.L4}" stroke-width="3.5" stroke-dasharray="6 4"/>`;
  s += `<text x="220" y="${ly + 4}" font-size="12" fill="${COL.muted}">L4 (señales)</text>`;
  s += `<line x1="324" y1="${ly}" x2="354" y2="${ly}" stroke="${COL.muted}" stroke-width="3.5"/>`;
  s += `<text x="362" y="${ly + 4}" font-size="12" fill="${COL.muted}">L2/L3 (GND)</text>`;
  s += `<line x1="486" y1="${ly - 8}" x2="486" y2="${ly + 8}" stroke="${COL.L4}" stroke-width="2"/>`;
  s += `<circle cx="486" cy="${ly}" r="4" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2"/>`;
  s += `<text x="498" y="${ly + 4}" font-size="12" fill="${COL.muted}">vía L1↔L4</text>`;
  s += `<circle cx="622" cy="${ly}" r="9" fill="${COL.conflict}" fill-opacity="0.16" stroke="${COL.conflict}" stroke-width="2"/>`;
  s += `<text x="638" y="${ly + 4}" font-size="12" fill="${COL.muted}">conflicto</text>`;

  s += `<text x="${W / 2}" y="606" text-anchor="middle" font-size="14" fill="${COL.text}">${esc(title)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg>`;
}

// --- gráficas ---------------------------------------------------------------

let CHART_SOURCE = '';

function chartCard(title, inner) {
  const dly = (CHART_IDX++ * 0.09).toFixed(2);
  const badge = CHART_SOURCE
    ? `<span class="chart-src${CHART_SOURCE === 'mock' ? ' mock' : ''}">${esc(CHART_SOURCE)}</span>`
    : '';
  return `<div class="chart" style="animation-delay:${dly}s"><h3>${esc(title)} ${badge}</h3>${inner}</div>`;
}

function lineChart({ title, xs, series, xLabel = '', w = 560, h = 306 }) {
  const pad = { l: 60, r: 30, t: 46, b: 54 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const all = series.flatMap((sr) => sr.values);
  let yMin = Math.min(...all), yMax = Math.max(...all);
  const padv = (yMax - yMin) * 0.15 || 1;
  yMin -= padv; yMax += padv;
  const X = (i) => pad.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const Y = (v) => pad.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
  const bottom = pad.t + ih;

  let defs = '';
  let s = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="10" fill="${COL.chartBg}"/>`;
  for (let g = 0; g <= 4; g++) {
    const yv = yMin + (yMax - yMin) * (g / 4);
    const y = Y(yv);
    s += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${COL.grid}" stroke-width="1" stroke-dasharray="2 6" opacity="0.75"/>`;
    s += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${COL.muted}">${fmt(yv, 1)}</text>`;
  }

  const step = Math.max(1, Math.round(xs.length / 6));
  xs.forEach((xv, i) => {
    if (i % step === 0 || i === xs.length - 1) {
      s += `<text x="${X(i).toFixed(1)}" y="${bottom + 20}" text-anchor="middle" font-size="11" fill="${COL.muted}">${xv}</text>`;
    }
  });

  series.forEach((sr, k) => {
    const pts = sr.values.map((v, i) => [X(i), Y(v)]);
    const dly = (0.2 + k * 0.15).toFixed(2);
    if (!sr.dash) {
      const gid = nid();
      defs += vGrad(gid, sr.color, 0.42, 0);
      s += `<path class="chart-area" style="animation-delay:${dly}s" d="${smoothPath(pts)} L ${pts[pts.length - 1][0].toFixed(1)},${bottom} L ${pts[0][0].toFixed(1)},${bottom} Z" fill="url(#${gid})"/>`;
    }
    if (sr.dash) {
      s += `<path class="chart-area" style="animation-delay:${dly}s" d="${smoothPath(pts)}" fill="none" stroke="${sr.color}" stroke-width="2.6" stroke-dasharray="${sr.dash}"/>`;
    } else {
      s += `<path class="chart-line" style="animation-delay:${dly}s" pathLength="1" d="${smoothPath(pts)}" fill="none" stroke="${sr.color}" stroke-width="2.6" stroke-linecap="round"/>`;
    }
    pts.forEach((p) => { s += `<circle class="chart-dot" style="animation-delay:${(Number(dly) + 0.5).toFixed(2)}s" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4" fill="${COL.chartBg}" stroke="${sr.color}" stroke-width="2"/>`; });
    const last = pts[pts.length - 1];
    s += `<text class="fade-late" style="animation-delay:${(Number(dly) + 0.5).toFixed(2)}s" x="${(last[0] + 7).toFixed(1)}" y="${(last[1] - 8).toFixed(1)}" font-size="11" font-weight="700" fill="${sr.color}">${fmt(sr.values[sr.values.length - 1], 2)}</text>`;
  });

  series.forEach((sr, k) => {
    const lx = pad.l + k * 150, lyy = 22;
    s += `<rect x="${lx}" y="${lyy - 9}" width="16" height="10" rx="3" fill="${sr.color}"/>`;
    s += `<text x="${lx + 22}" y="${lyy}" font-size="11" fill="${COL.muted}">${esc(sr.name)}</text>`;
  });

  s += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" font-size="12" fill="${COL.muted}">${esc(xLabel)}</text>`;
  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><defs>${defs}</defs>${s}</svg>`);
}

function stackedBars({ title, rows, w = 560, h = 300 }) {
  const pad = { l: 100, r: 54, t: 46, b: 26 };
  const iw = w - pad.l - pad.r;
  const maxTotal = Math.max(...rows.map((r) => r.total)) || 1;
  const bh = 48, gap = 58;

  let defs = '';
  let s = '';
  rows.forEach((r, ri) => {
    const y = pad.t + ri * (bh + gap);
    s += `<text x="${pad.l - 14}" y="${y + bh / 2 + 5}" text-anchor="end" font-size="13" fill="${COL.text}">${esc(r.label)}</text>`;
    s += `<rect x="${pad.l}" y="${y}" width="${iw}" height="${bh}" rx="${bh / 2}" fill="${COL.chartBg}"/>`;
    let x = pad.l;
    r.segments.forEach((seg, si) => {
      const segW = (seg.value / maxTotal) * iw;
      if (segW <= 0) return;
      const gid = nid();
      defs += vGrad(gid, seg.color, 0.95, 0.65);
      const wSeg = Math.max(0, segW - 3);
      const dly = (0.25 + ri * 0.18 + si * 0.12).toFixed(2);
      s += `<rect class="bar" style="animation-delay:${dly}s" x="${x.toFixed(1)}" y="${y}" width="${wSeg.toFixed(1)}" height="${bh}" rx="7" fill="url(#${gid})"/>`;
      if (segW > 38) {
        s += `<text class="fade-late" style="animation-delay:${(Number(dly) + 0.35).toFixed(2)}s" x="${(x + segW / 2).toFixed(1)}" y="${y + bh / 2 + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#08111c">${fmt(seg.value, 1)}</text>`;
      }
      x += segW;
    });
    s += `<text class="fade-late" style="animation-delay:${(0.25 + ri * 0.18 + 0.4).toFixed(2)}s" x="${(pad.l + (r.total / maxTotal) * iw + 10).toFixed(1)}" y="${y + bh / 2 + 5}" font-size="13" font-weight="600" fill="${COL.text}">${fmt(r.total, 2)}</text>`;
  });

  rows[0].segments.forEach((seg, k) => {
    const lx = pad.l + k * 150, lyy = 22;
    s += `<rect x="${lx}" y="${lyy - 9}" width="16" height="10" rx="3" fill="${seg.color}"/>`;
    s += `<text x="${lx + 22}" y="${lyy}" font-size="11" fill="${COL.muted}">${esc(seg.name)}</text>`;
  });

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><defs>${defs}</defs>${s}</svg>`);
}

function heatmap({ title, nets, weights, conflicts, w = 560, h = 368 }) {
  const n = nets.length;
  const cell = 32, gap = 4;
  const ox = 100, oy = 58;
  const maxW = Math.max(...weights.flat()) || 1;
  const cset = new Set(conflicts.map(([a, b]) => `${nets.indexOf(a)}|${nets.indexOf(b)}`));

  const cbarId = nid();
  const defs = `<linearGradient id="${cbarId}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${COL.heatLow}"/><stop offset="100%" stop-color="${COL.L1}"/></linearGradient>`;

  let s = '';
  nets.forEach((nn, i) => {
    s += `<text x="${ox - 12}" y="${oy + i * cell + cell / 2 + 4}" text-anchor="end" font-size="11" fill="${COL.muted}">${nn}</text>`;
    s += `<text x="${ox + i * cell + cell / 2}" y="${oy - 10}" text-anchor="middle" font-size="11" fill="${COL.muted}">${nn}</text>`;
  });

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = ox + j * cell + gap / 2, y = oy + i * cell + gap / 2;
      const d = cell - gap;
      const dly = ((i * n + j) * 0.006 + 0.2).toFixed(2);
      if (i === j) {
        s += `<rect class="cell" style="animation-delay:${dly}s" x="${x}" y="${y}" width="${d}" height="${d}" rx="6" fill="${COL.grid}" opacity="0.35"/>`;
        continue;
      }
      const isConflict = cset.has(`${i}|${j}`) || cset.has(`${j}|${i}`);
      const t = isConflict ? 0 : weights[i][j] / maxW;
      if (isConflict) {
        s += `<rect class="cell" style="animation-delay:${dly}s" x="${x}" y="${y}" width="${d}" height="${d}" rx="6" fill="${COL.conflict}" fill-opacity="0.22" stroke="${COL.conflict}" stroke-width="1.4" stroke-dasharray="3 2"/>`;
        s += `<text class="pop-late" style="animation-delay:${(Number(dly) + 0.2).toFixed(2)}s" x="${(x + d / 2).toFixed(1)}" y="${(y + d / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12" fill="${COL.conflict}">✕</text>`;
      } else {
        s += `<rect class="cell" style="animation-delay:${dly}s" x="${x}" y="${y}" width="${d}" height="${d}" rx="6" fill="${hexLerp(COL.heatLow, COL.L1, t)}"/>`;
      }
    }
  }

  const cbY = oy + n * cell + 22, cbW = 220;
  s += `<rect x="${ox}" y="${cbY}" width="${cbW}" height="10" rx="5" fill="url(#${cbarId})"/>`;
  s += `<text x="${ox}" y="${cbY + 28}" font-size="10" fill="${COL.muted}">0</text>`;
  s += `<text x="${ox + cbW}" y="${cbY + 28}" text-anchor="end" font-size="10" fill="${COL.muted}">${fmt(maxW, 2)}</text>`;
  s += `<text x="${ox + cbW + 16}" y="${cbY + 10}" font-size="11" fill="${COL.muted}">acoplamiento w_ij (mock)</text>`;
  s += `<circle cx="${ox + cbW + 20}" cy="${cbY + 34}" r="7" fill="${COL.conflict}" fill-opacity="0.22" stroke="${COL.conflict}" stroke-width="1.4" stroke-dasharray="3 2"/>`;
  s += `<text x="${ox + cbW + 34}" y="${cbY + 38}" font-size="11" fill="${COL.muted}">conflicto</text>`;

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><defs>${defs}</defs>${s}</svg>`);
}

function histogram({ title, items, w = 560, h = 330 }) {
  const pad = { l: 56, r: 18, t: 30, b: 82 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const maxP = Math.max(...items.map((d) => d.prob)) || 1;
  const bw = iw / items.length;

  let s = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="10" fill="${COL.chartBg}"/>`;
  for (let g = 0; g <= 4; g++) {
    const yv = maxP * g / 4;
    const y = pad.t + ih - (yv / maxP) * ih;
    s += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${COL.grid}" stroke-width="1" stroke-dasharray="2 6" opacity="0.75"/>`;
    s += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${COL.muted}">${fmt(yv, 2)}</text>`;
  }

  items.forEach((d, i) => {
    const bh = Math.max((d.prob / maxP) * ih, d.prob > 0 ? 2 : 0);
    const x = pad.l + i * bw + bw * 0.16;
    const width = bw * 0.68;
    const y = pad.t + ih - bh;
    const color = d.feasible ? COL.L1 : COL.conflict;
    const dly = (0.2 + i * 0.03).toFixed(2);
    const cx = (x + width / 2).toFixed(1);
    s += `<rect class="fade-late" style="animation-delay:${dly}s" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="${color}" opacity="0.88"><title>${esc(d.label)} · coste ${fmt(d.cost, 2)} · ${d.feasible ? 'factible' : 'NO factible'}</title></rect>`;
    s += `<text x="${cx}" y="${pad.t + ih + 12}" text-anchor="end" font-size="9" fill="${COL.muted}" transform="rotate(-60 ${cx} ${pad.t + ih + 12})">${esc(d.label)}</text>`;
  });

  s += `<rect x="${pad.l}" y="${h - 22}" width="16" height="10" rx="3" fill="${COL.L1}"/>`;
  s += `<text x="${pad.l + 22}" y="${h - 13}" font-size="11" fill="${COL.muted}">factible</text>`;
  s += `<rect x="${pad.l + 104}" y="${h - 22}" width="16" height="10" rx="3" fill="${COL.conflict}"/>`;
  s += `<text x="${pad.l + 126}" y="${h - 13}" font-size="11" fill="${COL.muted}">viola conflicto</text>`;
  s += `<text x="${w - pad.r}" y="${h - 13}" text-anchor="end" font-size="11" fill="${COL.muted}">probabilidad por bitstring (orden D0…CLK)</text>`;

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
}

function baselinesChart({ title, items, exactCost, w = 560, h = 360 }) {
  const pad = { l: 132, r: 104, t: 26, b: 24 };
  const iw = w - pad.l - pad.r;
  const rowH = 30, gap = 12;
  const total = pad.t + items.length * (rowH + gap) + pad.b;
  const H = Math.max(h, total);
  const maxC = Math.max(...items.map((d) => d.cost)) || 1;

  let s = '';
  let y = pad.t;
  items.forEach((d) => {
    const bw = Math.max((d.cost / maxC) * iw, 2);
    const isExact = d.name.indexOf('Exacto') === 0;
    const isQaoa = d.name === 'QAOA';
    const color = isExact ? COL.L4 : (isQaoa ? COL.L1 : COL.muted);
    const weight = isQaoa || isExact ? '700' : '400';
    s += `<text x="${pad.l - 12}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12" font-weight="${weight}" fill="${COL.text}">${esc(d.name)}</text>`;
    s += `<rect class="fade-late" style="animation-delay:${(0.15).toFixed(2)}s" x="${pad.l}" y="${y}" width="${bw.toFixed(1)}" height="${rowH}" rx="5" fill="${color}" opacity="${d.feasible ? 0.9 : 0.35}"/>`;
    if (!d.feasible) {
      s += `<text x="${pad.l + 8}" y="${y + rowH / 2 + 4}" font-size="10" fill="${COL.conflict}">infeasible (${d.violations})</text>`;
    }
    s += `<text x="${(pad.l + bw + 8).toFixed(1)}" y="${y + rowH / 2 - 2}" font-size="11" font-weight="600" fill="${COL.text}">${fmt(d.cost)}</text>`;
    s += `<text x="${(pad.l + bw + 8).toFixed(1)}" y="${y + rowH / 2 + 12}" font-size="9" fill="${COL.muted}">${d.evaluations} eval</text>`;
    y += rowH + gap;
  });

  if (exactCost != null) {
    const xOpt = (exactCost / maxC) * iw;
    s += `<line x1="${(pad.l + xOpt).toFixed(1)}" y1="${pad.t - 8}" x2="${(pad.l + xOpt).toFixed(1)}" y2="${(y - gap + 4).toFixed(1)}" stroke="${COL.L4}" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.7"/>`;
  }

  return chartCard(title, `<svg viewBox="0 0 ${w} ${H}" width="100%" role="img">${s}</svg>`);
}

function combosChart({ title, nMax = 30, w = 560, h = 330 }) {
  const pad = { l: 66, r: 26, t: 30, b: 46 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const yLogMax = nMax * Math.log10(2);
  const X = (n) => pad.l + ((n - 1) / (nMax - 1)) * iw;
  const Y = (v) => pad.t + ih - (Math.log10(v) / yLogMax) * ih;
  const fmtBig = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}e9`
    : v >= 1e6 ? `${(v / 1e6).toFixed(0)}M`
    : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(v));

  let s = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="10" fill="${COL.chartBg}"/>`;
  for (let e = 0; e <= 10; e++) {
    const v = Math.pow(10, e);
    if (v > Math.pow(2, nMax)) break;
    const y = Y(v);
    s += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${COL.grid}" stroke-width="1" stroke-dasharray="2 6" opacity="0.75"/>`;
    s += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${COL.muted}">1e${e}</text>`;
  }
  [1, 5, 9, 13, 18, 23, 27, 30].forEach((n) => {
    if (n > nMax) return;
    s += `<text x="${X(n).toFixed(1)}" y="${pad.t + ih + 18}" text-anchor="middle" font-size="11" fill="${COL.muted}">${n}</text>`;
  });

  let d = '';
  for (let n = 1; n <= nMax; n++) {
    d += `${n === 1 ? 'M' : 'L'} ${X(n).toFixed(1)},${Y(Math.pow(2, n)).toFixed(1)} `;
  }
  s += `<path class="chart-line" pathLength="1" d="${d}" fill="none" stroke="${COL.L1}" stroke-width="2.6" stroke-linecap="round"/>`;

  [9, 18, 27].forEach((n) => {
    if (n > nMax) return;
    const v = Math.pow(2, n);
    s += `<circle class="chart-dot" style="animation-delay:0.8s" cx="${X(n).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4.5" fill="${COL.chartBg}" stroke="${COL.L4}" stroke-width="2.4"/>`;
    s += `<text class="fade-late" style="animation-delay:0.9s" x="${(X(n) + 8).toFixed(1)}" y="${(Y(v) - 8).toFixed(1)}" font-size="11" font-weight="700" fill="${COL.L4}">2^${n} = ${fmtBig(v)}</text>`;
  });

  s += `<text x="${w / 2}" y="${h - 10}" text-anchor="middle" font-size="12" fill="${COL.muted}">nº de líneas (qubits)</text>`;
  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
}

function qubitGraph({ title, nets, weights, conflicts, assignment, w = 560, h = 430 }) {
  const n = nets.length;
  const cx = w / 2, cy = h / 2 + 4;
  const R = Math.min(w, h) / 2 - 74;
  const pos = nets.map((_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
  const maxW = Math.max(...weights.flat()) || 1;
  const cset = new Set(conflicts.map(([a, b]) => `${nets.indexOf(a)}|${nets.indexOf(b)}`));

  let s = `<rect x="8" y="8" width="${w - 16}" height="${h - 16}" rx="10" fill="${COL.chartBg}"/>`;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const conflict = cset.has(`${i}|${j}`) || cset.has(`${j}|${i}`);
      const wv = weights[i][j] / maxW;
      if (!conflict && wv <= 0.002) continue;
      const color = conflict ? COL.conflict : COL.muted;
      const width = conflict ? 2 : 1 + 3.5 * wv;
      const dash = conflict ? 'stroke-dasharray="4 3"' : '';
      s += `<line x1="${pos[i][0].toFixed(1)}" y1="${pos[i][1].toFixed(1)}" x2="${pos[j][0].toFixed(1)}" y2="${pos[j][1].toFixed(1)}" stroke="${color}" stroke-width="${width.toFixed(1)}" opacity="${conflict ? 0.9 : 0.55}" ${dash}/>`;
    }
  }
  nets.forEach((nn, i) => {
    const layer = assignment ? assignment[i] : 0;
    const color = layer === 0 ? COL.L1 : COL.L4;
    const [x, y] = pos[i];
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" fill="${COL.board}" stroke="${color}" stroke-width="2.4"/>`;
    s += `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${color}">${esc(nn)}</text>`;
  });

  s += `<circle cx="40" cy="${h - 22}" r="7" fill="${COL.board}" stroke="${COL.L1}" stroke-width="2"/>`;
  s += `<text x="54" y="${h - 18}" font-size="11" fill="${COL.muted}">L1</text>`;
  s += `<circle cx="104" cy="${h - 22}" r="7" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2"/>`;
  s += `<text x="118" y="${h - 18}" font-size="11" fill="${COL.muted}">L4</text>`;
  s += `<line x1="168" y1="${h - 22}" x2="196" y2="${h - 22}" stroke="${COL.muted}" stroke-width="2.5"/>`;
  s += `<text x="204" y="${h - 18}" font-size="11" fill="${COL.muted}">acoplamiento</text>`;
  s += `<line x1="322" y1="${h - 22}" x2="350" y2="${h - 22}" stroke="${COL.conflict}" stroke-width="2" stroke-dasharray="4 3"/>`;
  s += `<text x="358" y="${h - 18}" font-size="11" fill="${COL.muted}">conflicto</text>`;

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
}

function miniBoard(model, maps, bits, label, sub) {
  const { nidx, rankIn, rankOut } = maps;
  const nN = model.nets.length;
  const W = 380, H = 208;
  const bx = (x) => 70 + ((x - 16) / (104 - 16)) * (310 - 70);
  const bz = (z) => 44 + (z / 48) * (154 - 44);
  const pt = ([x, z]) => [bx(x), bz(z)];
  const str = (arr) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  let s = `<rect x="8" y="8" width="364" height="160" rx="8" fill="${COL.board}" stroke="${COL.blockEdge}"/>`;
  s += `<rect x="18" y="52" width="40" height="72" rx="5" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text x="38" y="91" text-anchor="middle" font-size="9" fill="${COL.text}">ADC</text>`;
  s += `<rect x="322" y="52" width="40" height="72" rx="5" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text x="342" y="91" text-anchor="middle" font-size="9" fill="${COL.text}">FPGA</text>`;

  model.nets.forEach((n) => {
    const layer = bits[nidx[n]];
    const color = layer === 0 ? COL.L1 : COL.L4;
    const pts = route(zAt(rankIn[n], nN), zAt(rankOut[n], nN)).map(pt);
    const dash = layer === 1 ? 'stroke-dasharray="4 3"' : '';
    s += `<polyline points="${str(pts)}" fill="none" stroke="${color}" stroke-width="2.4" opacity="0.95" ${dash}/>`;
    if (layer === 1) {
      pts.forEach(([x, y]) => {
        s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${COL.board}" stroke="${COL.L4}" stroke-width="1.6"/>`;
      });
    }
  });

  model.conflicts.forEach(([a, b]) => {
    if (bits[nidx[a]] !== bits[nidx[b]]) return;
    const p = polyInter(
      route(zAt(rankIn[a], nN), zAt(rankOut[a], nN)).map(pt),
      route(zAt(rankIn[b], nN), zAt(rankOut[b], nN)).map(pt),
    );
    if (p) {
      s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="7" fill="${COL.conflict}" fill-opacity="0.22" stroke="${COL.conflict}" stroke-width="1.6"/>`;
      s += `<text x="${p[0].toFixed(1)}" y="${(p[1] + 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="${COL.conflict}">✕</text>`;
    }
  });

  s += `<text x="${W / 2}" y="186" text-anchor="middle" font-size="11" fill="${COL.text}">${esc(label)} · ${esc(sub)}</text>`;
  return `<figure class="mini"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg></figure>`;
}

function statCard(label, value, sub = '', accent = '') {
  return `<div class="stat"${accent ? ` style="--accent:${accent}"` : ''}>
    <span class="stat-label">${esc(label)}</span>
    <span class="stat-value">${esc(value)}</span>
    <span class="stat-sub">${esc(sub)}</span>
  </div>`;
}

function finishTraces(root) {
  if (!root || !root.querySelectorAll) return;
  const apply = (el) => {
    el.style.animation = 'none';
    el.style.strokeDasharray = '7 5';
    el.style.strokeDashoffset = '0';
  };
  root.querySelectorAll('.trace-l4').forEach((el) => {
    if (reducedMotion()) { apply(el); return; }
    el.addEventListener('animationend', () => apply(el), { once: true });
  });
}

// --- render -----------------------------------------------------------------

export function render(model) {
  const nidx = Object.fromEntries(model.nets.map((n, i) => [n, i]));
  const maps = {
    nidx,
    rankIn: Object.fromEntries(model.in_order.map((n, i) => [n, i])),
    rankOut: Object.fromEntries(model.out_order.map((n, i) => [n, i])),
  };

  const b = model.costs.before;
  const a = model.costs.after;
  const improvement = b.total > 0 ? ((b.total - a.total) / b.total) * 100 : 0;

  const beforeCounts = `${model.assignments.before_layers.L1.length} en L1 · ${b.violations} conflictos`;
  const afterCounts = `L1 ${model.assignments.after_layers.L1.length} · L4 ${model.assignments.after_layers.L4.length} · ${a.violations} conflictos`;

  let view = '3d';
  const drawBoards = () => {
    const fn = view === '2d' ? boardSvg : board3d;
    const elBefore = document.getElementById('board-before');
    const elAfter = document.getElementById('board-after');
    elBefore.innerHTML = fn(model, maps, model.assignments.before, `ANTES · ${beforeCounts}`);
    elAfter.innerHTML = fn(model, maps, model.assignments.after, `DESPUÉS · ${afterCounts}`);
    finishTraces(elBefore);
    finishTraces(elAfter);
  };
  drawBoards();

  document.querySelectorAll('.toolbar .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
    btn.onclick = () => {
      view = btn.dataset.view;
      document.querySelectorAll('.toolbar .tab').forEach((x) => x.classList.toggle('active', x === btn));
      drawBoards();
    };
  });

  const isReal = model.source === 'qaoa';

  const evo = document.getElementById('evolution');
  if (evo) {
    evo.innerHTML = (isReal && Array.isArray(model.solutions) && model.solutions.length)
      ? '<div class="evolution-grid">' + model.solutions.map((sol) =>
          miniBoard(model, maps, sol.x, `iter ${sol.iter}`,
            `costo ${fmt(sol.cost)}${sol.energy != null ? ` · E ${fmt(sol.energy)}` : ''} · ${sol.violations} conflictos`)
        ).join('') + '</div>'
      : '';
  }
  const cards = [
    statCard('Costo antes', fmt(b.total), 'corte + vías + conflictos', COL.coupling),
    statCard('Costo después', fmt(a.total), isReal ? 'mejor solución QAOA factible' : 'solución factible', COL.L4),
    statCard('Mejora', `${fmt(improvement, 1)}%`, 'vs. todas en L1', COL.conflict),
    statCard('Conflictos', `${b.violations} → ${a.violations}`, 'resueltos por capa', COL.conflict),
    statCard('Vías', `${b.vias} → ${a.vias}`, `${model.meta.vias_per_l4} por red a L4`, COL.L4),
  ];
  if (isReal) {
    cards.push(statCard('Qubits', `${model.meta.num_qubits}`, `p=${model.meta.reps} · ${model.meta.num_parameters} params`, COL.coupling));
    cards.push(statCard('Factibilidad', `${fmt(model.meta.feasibility * 100, 1)}%`, 'masa de probabilidad factible', COL.L4));
    cards.push(statCard('Óptimo exacto', fmt(model.exact.cost), `gap ${fmt(model.meta.approx_gap * 100, 1)}%`, COL.conflict));
    cards.push(statCard('Energía QAOA', fmt(model.meta.energy), '⟨H_C⟩ mínima', COL.muted));
    const heur = (model.baselines || []).filter((x) => x.name !== 'QAOA' && x.name.indexOf('Exacto') !== 0 && x.feasible);
    if (heur.length) {
      const bc = Math.min(...heur.map((x) => x.cost));
      const diff = a.total - bc;
      cards.push(statCard('vs mejor heurístico', diff <= 1e-9 ? 'óptimo o mejor' : `+${fmt(diff)}`, `mejor clásico ${fmt(bc)}`, diff <= 1e-9 ? COL.L1 : COL.conflict));
    }
  } else {
    cards.push(statCard('Parámetros', `λv=${model.meta.lambda_v} · M=${model.meta.m_penalty}`, 'mock', COL.muted));
  }
  document.getElementById('stats').innerHTML = cards.join('');

  CHART_IDX = 0;
  const charts = [];

  CHART_SOURCE = isReal ? 'modelo' : 'mock';
  charts.push(stackedBars({
    title: 'Desglose de costo',
    rows: [
      { label: 'Antes', total: b.total, segments: [
        { name: 'Acoplamiento', value: b.coupling, color: COL.coupling },
        { name: 'Vías', value: b.via_cost, color: COL.viaCost },
        { name: 'Conflictos', value: b.conflict_cost, color: COL.conflictCost },
      ] },
      { label: 'Después', total: a.total, segments: [
        { name: 'Acoplamiento', value: a.coupling, color: COL.coupling },
        { name: 'Vías', value: a.via_cost, color: COL.viaCost },
        { name: 'Conflictos', value: a.conflict_cost, color: COL.conflictCost },
      ] },
    ],
  }));

  CHART_SOURCE = 'analítico';
  charts.push(lineChart({
    title: 'Costo vs. λv (costo por vía)',
    xs: model.lambda_sweep.x,
    xLabel: 'λv',
    series: [
      { name: 'Antes', color: COL.conflict, values: model.lambda_sweep.before },
      { name: 'Después', color: COL.L4, values: model.lambda_sweep.after },
    ],
  }));
  charts.push(lineChart({
    title: 'Costo vs. M (penalización de conflicto)',
    xs: model.m_sweep.x,
    xLabel: 'M',
    series: [
      { name: 'Antes', color: COL.conflict, values: model.m_sweep.before },
      { name: 'Después', color: COL.L4, values: model.m_sweep.after },
    ],
  }));

  CHART_SOURCE = isReal ? 'QAOA' : 'mock';
  charts.push(lineChart({
    title: isReal ? 'QAOA · mejor costo factible y factibilidad vs. p' : 'QAOA mock · costo y factibilidad vs. p',
    xs: model.qaoa.x,
    xLabel: 'profundidad p',
    series: [
      { name: 'QAOA (mejor factible)', color: COL.coupling, values: model.qaoa.cost },
      { name: 'Factibilidad', color: COL.L4, values: model.qaoa.feasibility, dash: '5 4' },
      ...(isReal && model.exact
        ? [{ name: 'Óptimo exacto', color: COL.muted, values: model.qaoa.x.map(() => model.exact.cost), dash: '3 3' }]
        : []),
    ],
  }));
  charts.push(lineChart({
    title: isReal ? 'Convergencia QAOA (energía vs. iteración)' : 'Convergencia mock (costo vs. iteración)',
    xs: model.iterations.x,
    xLabel: 'iteración',
    series: [
      { name: isReal ? 'Energía ⟨H_C⟩' : 'Costo', color: COL.coupling, values: model.iterations.cost },
    ],
  }));

  if (isReal && Array.isArray(model.distribution) && model.distribution.length) {
    CHART_SOURCE = 'QAOA';
    charts.push(histogram({ title: 'Distribución QAOA · top bitstrings', items: model.distribution }));
  }

  CHART_SOURCE = 'clásico';
  if (Array.isArray(model.baselines) && model.baselines.length) {
    const sorted = [...model.baselines].sort((x, y) => x.cost - y.cost);
    charts.push(baselinesChart({
      title: 'QAOA vs baselines clásicos (mismo presupuesto)',
      items: sorted,
      exactCost: model.exact ? model.exact.cost : null,
    }));
  }

  CHART_SOURCE = 'teórico';
  charts.push(combosChart({ title: 'Combinaciones posibles (2ⁿ) vs nº de líneas', nMax: 30 }));

  CHART_SOURCE = isReal ? 'modelo' : 'mock';
  charts.push(qubitGraph({
    title: `Qubits y acoplamientos (n = ${model.meta.n_nets})`,
    nets: model.nets,
    weights: model.weights,
    conflicts: model.conflicts,
    assignment: model.assignments.after,
  }));

  CHART_SOURCE = isReal ? 'geométrica' : 'mock';
  charts.push(heatmap({
    title: isReal ? 'Matriz de acoplamiento W (geométrica)' : 'Matriz de acoplamiento (mock)',
    nets: model.nets,
    weights: model.weights,
    conflicts: model.conflicts,
  }));

  CHART_SOURCE = '';
  document.getElementById('charts').innerHTML = charts.join('');
}

// Resultado de una ejecución en el backend (QPU o simulador) elegido en Qollab.
export function renderBackend(q, model) {
  const el = document.getElementById('qpu');
  if (!el) return;
  if (!q || !q.counts) { el.innerHTML = ''; return; }

  const n = model.nets.length;
  const idxOf = Object.fromEntries(model.nets.map((x, i) => [x, i]));
  const decode = (key) => {
    const x = new Array(n).fill(0);
    for (let i = 0; i < n; i++) x[i] = Number(key[n - 1 - i] ?? '0');
    return x;
  };
  const viol = (x) => model.conflicts.reduce((a, [A, B]) => a + (x[idxOf[A]] === x[idxOf[B]] ? 1 : 0), 0);

  const entries = Object.entries(q.counts).map(([key, count]) => ({ key, count, feasible: viol(decode(key)) === 0 }));
  entries.sort((a, b) => b.count - a.count);
  const items = entries.slice(0, 16);
  const total = q.shots || entries.reduce((a, e) => a + e.count, 0);
  const feas = entries.filter((e) => e.feasible).reduce((a, e) => a + e.count, 0);

  const w = 560, h = 330, pad = { l: 56, r: 18, t: 30, b: 82 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const maxC = Math.max(...items.map((e) => e.count)) || 1;
  const bw = iw / items.length;

  let s = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="10" fill="${COL.chartBg}"/>`;
  for (let g = 0; g <= 4; g++) {
    const yv = maxC * g / 4;
    const y = pad.t + ih - (yv / maxC) * ih;
    s += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${COL.grid}" stroke-width="1" stroke-dasharray="2 6" opacity="0.75"/>`;
    s += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${COL.muted}">${Math.round(yv)}</text>`;
  }
  items.forEach((e, i) => {
    const bh = Math.max((e.count / maxC) * ih, e.count > 0 ? 2 : 0);
    const x = pad.l + i * bw + bw * 0.16;
    const width = bw * 0.68;
    const y = pad.t + ih - bh;
    const color = e.feasible ? COL.L1 : COL.conflict;
    const cx = (x + width / 2).toFixed(1);
    s += `<rect class="fade-late" style="animation-delay:${(0.2 + i * 0.03).toFixed(2)}s" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="${color}" opacity="0.88"><title>${esc(e.key)} · ${e.count} shots · ${e.feasible ? 'factible' : 'NO factible'}</title></rect>`;
    s += `<text x="${cx}" y="${pad.t + ih + 12}" text-anchor="end" font-size="9" fill="${COL.muted}" transform="rotate(-60 ${cx} ${pad.t + ih + 12})">${esc(e.key)}</text>`;
  });
  s += `<rect x="${pad.l}" y="${h - 22}" width="16" height="10" rx="3" fill="${COL.L1}"/>`;
  s += `<text x="${pad.l + 22}" y="${h - 13}" font-size="11" fill="${COL.muted}">factible</text>`;
  s += `<rect x="${pad.l + 104}" y="${h - 22}" width="16" height="10" rx="3" fill="${COL.conflict}"/>`;
  s += `<text x="${pad.l + 126}" y="${h - 13}" font-size="11" fill="${COL.muted}">viola conflicto</text>`;

  const feasiblePct = total ? (feas / total) * 100 : 0;
  const title = `Resultado en QPU · ${q.backend_name || 'backend'} · ${q.shots || total} shots · factibilidad ${fmt(feasiblePct, 1)}%`;

  const saved = CHART_SOURCE;
  CHART_SOURCE = 'QPU';
  el.innerHTML = chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
  CHART_SOURCE = saved;
}

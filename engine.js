// QuietTracE — motor de visualización (render puro, sin datos).
//
// `render(model)` dibuja la PCB (vista 2D en planta y vista 3D del stackup)
// antes/después de la optimización, más las gráficas de valor, con animación de
// "construcción" al cargar.
//
// NO implementa la optimización QUBO/Ising/QAOA. No usa `backend` ni envía jobs.

const COL = {
  L1: '#6c8cff',
  L4: '#ffb86c',
  conflict: '#ff5470',
  board: '#0e1630',
  block: '#1b2547',
  blockEdge: '#2b3860',
  grid: '#232f55',
  text: '#e7ecff',
  muted: '#93a0c4',
  coupling: '#6c8cff',
  viaCost: '#ffb86c',
  conflictCost: '#ff5470',
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

// Curva suave (Catmull-Rom -> Bézier) para líneas de gráfica.
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
      s += `<circle class="pop-late" style="animation-delay:1s" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="12" fill="rgba(255,84,112,0.16)" stroke="${COL.conflict}" stroke-width="2"/>`;
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
  s += `<circle cx="322" cy="${ly}" r="9" fill="rgba(255,84,112,0.16)" stroke="${COL.conflict}" stroke-width="2"/>`;
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
  const FILL = { L1: '#33477f', L2: '#3a4056', L3: '#3a4056', L4: '#7a5a2f' };
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
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([D, C, Ct, Dt])}" fill="#22305a" stroke="${COL.blockEdge}" stroke-width="1"/>`;
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([B, C, Ct, Bt])}" fill="#1a2546" stroke="${COL.blockEdge}" stroke-width="1"/>`;
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
      s += `<circle class="pop-late" style="animation-delay:1s" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="11" fill="rgba(255,84,112,0.18)" stroke="${COL.conflict}" stroke-width="2"/>`;
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
  s += `<circle cx="622" cy="${ly}" r="9" fill="rgba(255,84,112,0.16)" stroke="${COL.conflict}" stroke-width="2"/>`;
  s += `<text x="638" y="${ly + 4}" font-size="12" fill="${COL.muted}">conflicto</text>`;

  s += `<text x="${W / 2}" y="606" text-anchor="middle" font-size="14" fill="${COL.text}">${esc(title)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg>`;
}

// --- gráficas ---------------------------------------------------------------

function chartCard(title, inner) {
  const dly = (CHART_IDX++ * 0.09).toFixed(2);
  return `<div class="chart" style="animation-delay:${dly}s"><h3>${esc(title)}</h3>${inner}</div>`;
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
  let s = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="10" fill="#0f1830"/>`;
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
    pts.forEach((p) => { s += `<circle class="chart-dot" style="animation-delay:${(Number(dly) + 0.5).toFixed(2)}s" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4" fill="#0f1830" stroke="${sr.color}" stroke-width="2"/>`; });
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
    s += `<rect x="${pad.l}" y="${y}" width="${iw}" height="${bh}" rx="${bh / 2}" fill="#0f1830"/>`;
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
        s += `<text class="fade-late" style="animation-delay:${(Number(dly) + 0.35).toFixed(2)}s" x="${(x + segW / 2).toFixed(1)}" y="${y + bh / 2 + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#0b1020">${fmt(seg.value, 1)}</text>`;
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
  const defs = `<linearGradient id="${cbarId}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#16203c"/><stop offset="100%" stop-color="${COL.L1}"/></linearGradient>`;

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
      const fill = isConflict ? 'rgba(255,84,112,0.22)' : hexLerp('#16203c', COL.L1, t);
      s += `<rect class="cell" style="animation-delay:${dly}s" x="${x}" y="${y}" width="${d}" height="${d}" rx="6" fill="${fill}" ${isConflict ? `stroke="${COL.conflict}" stroke-width="1.4" stroke-dasharray="3 2"` : ''}/>`;
      if (isConflict) {
        s += `<text class="pop-late" style="animation-delay:${(Number(dly) + 0.2).toFixed(2)}s" x="${(x + d / 2).toFixed(1)}" y="${(y + d / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12" fill="${COL.conflict}">✕</text>`;
      }
    }
  }

  const cbY = oy + n * cell + 22, cbW = 220;
  s += `<rect x="${ox}" y="${cbY}" width="${cbW}" height="10" rx="5" fill="url(#${cbarId})"/>`;
  s += `<text x="${ox}" y="${cbY + 28}" font-size="10" fill="${COL.muted}">0</text>`;
  s += `<text x="${ox + cbW}" y="${cbY + 28}" text-anchor="end" font-size="10" fill="${COL.muted}">${fmt(maxW, 2)}</text>`;
  s += `<text x="${ox + cbW + 16}" y="${cbY + 10}" font-size="11" fill="${COL.muted}">acoplamiento w_ij (mock)</text>`;
  s += `<circle cx="${ox + cbW + 20}" cy="${cbY + 34}" r="7" fill="rgba(255,84,112,0.22)" stroke="${COL.conflict}" stroke-width="1.4" stroke-dasharray="3 2"/>`;
  s += `<text x="${ox + cbW + 34}" y="${cbY + 38}" font-size="11" fill="${COL.muted}">conflicto</text>`;

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><defs>${defs}</defs>${s}</svg>`);
}

function statCard(label, value, sub = '', accent = '') {
  return `<div class="stat"${accent ? ` style="--accent:${accent}"` : ''}>
    <span class="stat-label">${esc(label)}</span>
    <span class="stat-value">${esc(value)}</span>
    <span class="stat-sub">${esc(sub)}</span>
  </div>`;
}

// Convierte las pistas de L4 (dibujadas sólidas) a discontinuas al terminar.
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
    btn.addEventListener('click', () => {
      view = btn.dataset.view;
      document.querySelectorAll('.toolbar .tab').forEach((x) => x.classList.toggle('active', x === btn));
      drawBoards();
    });
  });

  document.getElementById('stats').innerHTML = [
    statCard('Costo antes', fmt(b.total), 'corte + vías + conflictos', COL.coupling),
    statCard('Costo después', fmt(a.total), 'solución factible', COL.L4),
    statCard('Mejora', `${fmt(improvement, 1)}%`, 'vs. todas en L1', COL.conflict),
    statCard('Conflictos', `${b.violations} → ${a.violations}`, 'resueltos por capa', COL.conflict),
    statCard('Vías', `${b.vias} → ${a.vias}`, `${model.meta.vias_per_l4} por red a L4`, COL.L4),
    statCard('Parámetros', `λv=${model.meta.lambda_v} · M=${model.meta.m_penalty}`, 'mock', COL.muted),
  ].join('');

  CHART_IDX = 0;
  document.getElementById('charts').innerHTML = [
    stackedBars({
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
    }),
    lineChart({
      title: 'Costo vs. λv (costo por vía)',
      xs: model.lambda_sweep.x,
      xLabel: 'λv',
      series: [
        { name: 'Antes', color: COL.conflict, values: model.lambda_sweep.before },
        { name: 'Después', color: COL.L4, values: model.lambda_sweep.after },
      ],
    }),
    lineChart({
      title: 'Costo vs. M (penalización de conflicto)',
      xs: model.m_sweep.x,
      xLabel: 'M',
      series: [
        { name: 'Antes', color: COL.conflict, values: model.m_sweep.before },
        { name: 'Después', color: COL.L4, values: model.m_sweep.after },
      ],
    }),
    lineChart({
      title: 'QAOA mock · costo y factibilidad vs. profundidad p',
      xs: model.qaoa.x,
      xLabel: 'profundidad p',
      series: [
        { name: 'Costo esperado', color: COL.coupling, values: model.qaoa.cost },
        { name: 'Factibilidad', color: COL.L4, values: model.qaoa.feasibility, dash: '5 4' },
      ],
    }),
    lineChart({
      title: 'Convergencia mock (costo vs. iteración)',
      xs: model.iterations.x,
      xLabel: 'iteración',
      series: [
        { name: 'Costo', color: COL.coupling, values: model.iterations.cost },
      ],
    }),
    heatmap({
      title: 'Matriz de acoplamiento (mock)',
      nets: model.nets,
      weights: model.weights,
      conflicts: model.conflicts,
    }),
  ].join('');
}

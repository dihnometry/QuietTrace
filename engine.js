// QuietTracE — visualization engine (pure render, no data).
//
// render(model): PCB (2D plan + 3D stackup) before/after, cost breakdown,
// possible-configurations histogram and coupling matrix.
//
// Single theme "Hybrid". Does NOT use `backend` and sends no jobs.

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
let CHART_SOURCE = '';

function vGrad(id, color, top, bottom) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${color}" stop-opacity="${top}"/>`
    + `<stop offset="100%" stop-color="${color}" stop-opacity="${bottom}"/></linearGradient>`;
}

function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
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

// Realistic PCB routing: straight, 45° jog, straight.
const RX0 = 16, RX1 = 104;

function route(z1, z2) {
  const dz = z2 - z1, adz = Math.abs(dz), dx = RX1 - RX0;
  if (adz < 0.01) return [[RX0, z1], [RX1, z2]];
  const straight = Math.max(0, (dx - adz) / 2);
  return [[RX0, z1], [RX0 + straight, z1], [RX0 + straight + adz, z2], [RX1, z2]];
}

const LZ_OF = (n) => Math.min(98, Math.max(48, 5.5 * n));   // corridor depth, grows with n
const zAt = (rank, nNets) => {
  const twoBank = nNets > 9;
  const half = Math.floor(nNets / 2);
  const gap = twoBank ? 10 : 0;                 // visible separation between the two ADC banks
  const step = (LZ_OF(nNets) - 10 - gap) / (nNets - 1);
  let z = 5 + rank * step;
  if (twoBank && rank >= half) z += gap;
  return z;
};
const traceDelay = (i) => (0.15 + i * 0.06).toFixed(2);
const lateDelay = (i, base = 0.8) => (base + i * 0.05).toFixed(2);

// --- PCB 2D view (plan) -----------------------------------------------------

function boardSvg(model, maps, assignment, title) {
  const { nidx, rankIn, rankOut } = maps;
  const W = 900, H = 452;
  const nN = model.nets.length;
  const LZv = LZ_OF(nN);
  const TRACE_W = nN > 12 ? 2 : 3.5;
  const sx = (x) => 40 + x * (820 / 120);
  const sz = (z) => 60 + (z / LZv) * 300;
  const pt = ([x, z]) => [sx(x), sz(z)];
  const polyStr = (arr) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  let s = '';
  s += `<rect x="16" y="16" width="868" height="360" rx="12" fill="${COL.board}" stroke="${COL.blockEdge}"/>`;
  {
    const adcs = (model.meta && model.meta.adcs) || 1;
    const yOf = (r) => sz(zAt(r, nN));
    const fTop = yOf(0) - 18, fBot = yOf(nN - 1) + 18, fc = (fTop + fBot) / 2;
    s += `<rect class="fade-late" x="760" y="${fTop.toFixed(1)}" width="100" height="${(fBot - fTop).toFixed(1)}" rx="8" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
    s += `<text class="fade-late" x="810" y="${(fc).toFixed(1)}" text-anchor="middle" font-size="17" fill="${COL.text}">FPGA</text>`;
    s += `<text class="fade-late" x="810" y="${(fc + 19).toFixed(1)}" text-anchor="middle" font-size="13" fill="${COL.muted}">receiver</text>`;

    if (adcs >= 2) {
      const half = Math.floor(nN / 2);
      [[0, half - 1, 'ADC1'], [half, nN - 1, 'ADC2']].forEach(([a, b, lab]) => {
        const top = yOf(a) - 6, bot = yOf(b) + 6, c = (top + bot) / 2;
        s += `<rect class="fade-late" x="40" y="${top.toFixed(1)}" width="100" height="${(bot - top).toFixed(1)}" rx="8" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
        s += `<text class="fade-late" x="90" y="${(c).toFixed(1)}" text-anchor="middle" font-size="17" fill="${COL.text}">${lab}</text>`;
        s += `<text class="fade-late" x="90" y="${(c + 19).toFixed(1)}" text-anchor="middle" font-size="12" fill="${COL.muted}">8 bits</text>`;
      });
    } else {
      const top = yOf(0) - 18, bot = yOf(nN - 1) + 18, c = (top + bot) / 2;
      s += `<rect class="fade-late" x="40" y="${top.toFixed(1)}" width="100" height="${(bot - top).toFixed(1)}" rx="8" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
      s += `<text class="fade-late" x="90" y="${(c).toFixed(1)}" text-anchor="middle" font-size="17" fill="${COL.text}">ADC08060</text>`;
      s += `<text class="fade-late" x="90" y="${(c + 19).toFixed(1)}" text-anchor="middle" font-size="13" fill="${COL.muted}">8 bits · 40 MSPS</text>`;
    }
  }

  model.nets.forEach((n, i) => {
    const layer = assignment[nidx[n]];
    const color = layer === 0 ? COL.L1 : COL.L4;
    const pts = route(zAt(rankIn[n], nN), zAt(rankOut[n], nN)).map(pt);
    const dly = traceDelay(i);
    s += `<polyline class="trace${layer === 1 ? ' trace-l4' : ''}" style="animation-delay:${dly}s" pathLength="1" points="${polyStr(pts)}" fill="none" stroke="${color}" stroke-width="${TRACE_W}" opacity="0.95"/>`;
    if (layer === 1) {
      pts.forEach(([x, y]) => { s += `<circle class="fade-late" style="animation-delay:${lateDelay(i)}s" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2.5"/>`; });
    }
    s += `<text class="fade-late" style="animation-delay:${dly}s" x="${(pts[0][0] - 8).toFixed(1)}" y="${(pts[0][1] + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="${color}">${n}</text>`;
  });

  const alive = model.conflicts.filter(([a, b]) => assignment[nidx[a]] === assignment[nidx[b]]);
  alive.forEach(([a, b]) => {
    const pa = route(zAt(rankIn[a], nN), zAt(rankOut[a], nN)).map(pt);
    const pb = route(zAt(rankIn[b], nN), zAt(rankOut[b], nN)).map(pt);
    const p = polyInter(pa, pb);
    if (p) {
      s += `<circle class="pop-late" style="animation-delay:1s" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="12" fill="${COL.conflict}" fill-opacity="0.16" stroke="${COL.conflict}" stroke-width="2"/>`;
      s += `<text class="pop-late" style="animation-delay:1s" x="${p[0].toFixed(1)}" y="${(p[1] + 5).toFixed(1)}" text-anchor="middle" font-size="17" fill="${COL.conflict}">✕</text>`;
    }
  });

  const ly = 430;
  s += `<line x1="40" y1="${ly}" x2="70" y2="${ly}" stroke="${COL.L1}" stroke-width="3.5"/>`;
  s += `<text x="78" y="${ly + 4}" font-size="14" fill="${COL.muted}">L1</text>`;
  s += `<line x1="118" y1="${ly}" x2="148" y2="${ly}" stroke="${COL.L4}" stroke-width="3.5" stroke-dasharray="7 5"/>`;
  s += `<text x="156" y="${ly + 4}" font-size="14" fill="${COL.muted}">L4 (hidden)</text>`;
  s += `<circle cx="250" cy="${ly}" r="5" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2.5"/>`;
  s += `<text x="262" y="${ly + 4}" font-size="14" fill="${COL.muted}">via</text>`;
  s += `<circle cx="322" cy="${ly}" r="9" fill="${COL.conflict}" fill-opacity="0.16" stroke="${COL.conflict}" stroke-width="2"/>`;
  s += `<text x="338" y="${ly + 4}" font-size="14" fill="${COL.muted}">conflict</text>`;

  s += `<text x="${W / 2}" y="410" text-anchor="middle" font-size="17" fill="${COL.text}">${esc(title)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg>`;
}

// --- PCB 3D view (isometric stackup) ----------------------------------------

function board3d(model, maps, assignment, title) {
  const { nidx, rankIn, rankOut } = maps;
  const nN = model.nets.length;
  const DZ = LZ_OF(nN);
  const S = 5.0, OY = 40;
  const OX = 60 + DZ * 2.1;
  const W = 900;
  const H = 40 + 5 * (90.4 + 0.26 * DZ) + 96;
  const EX = { x: 1.0, y: 0.12 }, EZ = { x: -0.42, y: 0.26 };
  const Lx = 120, T = 4;
  const TRACE_W = nN > 12 ? 2 : 3.5;
  const LAYER_H = { L1: 0, L2: 24, L3: 48, L4: 72 };
  const FILL = { L1: COL.L1fill, L2: COL.L2fill, L3: COL.L3fill, L4: COL.L4fill };
  const STROKE = { L1: COL.L1, L2: COL.muted, L3: COL.muted, L4: COL.L4 };

  const P = (x, z, h) => [OX + (x * EX.x + z * EZ.x) * S, OY + (x * EX.y + z * EZ.y + h) * S];
  const pts = (arr) => arr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const route3 = (n, h) => route(zAt(rankIn[n], nN), zAt(rankOut[n], nN)).map(([x, z]) => P(x, z, h));

  let s = '';
  let traceIdx = 0;

  const slab = (h, fill, stroke, label) => {
    const A = P(0, 0, h), B = P(Lx, 0, h), C = P(Lx, DZ, h), D = P(0, DZ, h);
    const Cb = P(Lx, DZ, h + T), Db = P(0, DZ, h + T), Bb = P(Lx, 0, h + T);
    s += `<polygon points="${pts([D, C, Cb, Db])}" fill="${shade(fill, -0.30)}" stroke="${stroke}" stroke-width="1"/>`;
    s += `<polygon points="${pts([B, C, Cb, Bb])}" fill="${shade(fill, -0.48)}" stroke="${stroke}" stroke-width="1"/>`;
    s += `<polygon points="${pts([A, B, C, D])}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" opacity="0.5"/>`;
    const lp = P(4, DZ - 5, h);
    s += `<text x="${lp[0].toFixed(1)}" y="${lp[1].toFixed(1)}" font-size="14" fill="${stroke}">${label}</text>`;
  };

  const trace = (n, layer) => {
    const h = LAYER_H[layer];
    const color = layer === 'L1' ? COL.L1 : COL.L4;
    const rp = route3(n, h);
    const dly = traceDelay(traceIdx++);
    s += `<polyline class="trace${layer === 'L4' ? ' trace-l4' : ''}" style="animation-delay:${dly}s" pathLength="1" points="${pts(rp)}" fill="none" stroke="${color}" stroke-width="${TRACE_W}" opacity="0.95"/>`;
    s += `<text class="fade-late" style="animation-delay:${dly}s" x="${(rp[0][0] - 6).toFixed(1)}" y="${(rp[0][1] + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="${color}">${n}</text>`;
  };

  const byLayer = { L1: [], L4: [] };
  model.nets.forEach((n) => byLayer[assignment[nidx[n]] === 0 ? 'L1' : 'L4'].push(n));

  slab(LAYER_H.L4, FILL.L4, STROKE.L4, 'L4 · signals');
  byLayer.L4.forEach((n) => trace(n, 'L4'));
  slab(LAYER_H.L3, FILL.L3, STROKE.L3, 'L3 · GND');
  slab(LAYER_H.L2, FILL.L2, STROKE.L2, 'L2 · GND');
  slab(LAYER_H.L1, FILL.L1, STROKE.L1, 'L1 · signals');
  byLayer.L1.forEach((n) => trace(n, 'L1'));

  const box = (x0, x1, z0, z1, h, ht, label, sub) => {
    const B = P(x1, z0, h), C = P(x1, z1, h), D = P(x0, z1, h);
    const Ct = P(x1, z1, h - ht), Dt = P(x0, z1, h - ht), Bt = P(x1, z0, h - ht), At = P(x0, z0, h - ht);
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([D, C, Ct, Dt])}" fill="${COL.blockSide}" stroke="${COL.blockEdge}" stroke-width="1"/>`;
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([B, C, Ct, Bt])}" fill="${COL.blockSideDark}" stroke="${COL.blockEdge}" stroke-width="1"/>`;
    s += `<polygon class="fade-late" style="animation-delay:0.5s" points="${pts([At, Bt, Ct, Dt])}" fill="${COL.block}" stroke="${COL.blockEdge}" stroke-width="1.2"/>`;
    const c = P((x0 + x1) / 2, (z0 + z1) / 2, h - ht);
    s += `<text class="fade-late" style="animation-delay:0.5s" x="${c[0].toFixed(1)}" y="${(c[1] - 3).toFixed(1)}" text-anchor="middle" font-size="14" fill="${COL.text}">${label}</text>`;
    s += `<text class="fade-late" style="animation-delay:0.5s" x="${c[0].toFixed(1)}" y="${(c[1] + 11).toFixed(1)}" text-anchor="middle" font-size="13" fill="${COL.muted}">${sub}</text>`;
  };
  const adcs = (model.meta && model.meta.adcs) || 1;
  const zOf = (r) => zAt(r, nN);
  if (adcs >= 2) {
    const half = Math.floor(nN / 2);
    box(0, 14, zOf(0) - 2, zOf(half - 1) + 2, LAYER_H.L1, 12, 'ADC1', '8 bits');
    box(0, 14, zOf(half) - 2, zOf(nN - 1) + 2, LAYER_H.L1, 12, 'ADC2', '8 bits');
  } else {
    box(0, 14, zOf(0) - 2, zOf(nN - 1) + 2, LAYER_H.L1, 12, 'ADC08060', '8 bits · 40 MSPS');
  }
  box(106, 120, zOf(0) - 2, zOf(nN - 1) + 2, LAYER_H.L1, 12, 'FPGA', 'receiver');

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
      s += `<text class="pop-late" style="animation-delay:1s" x="${p[0].toFixed(1)}" y="${(p[1] + 5).toFixed(1)}" text-anchor="middle" font-size="17" fill="${COL.conflict}">✕</text>`;
    }
  });

  const ly = H - 44;
  s += `<line x1="40" y1="${ly}" x2="70" y2="${ly}" stroke="${COL.L1}" stroke-width="3.5"/>`;
  s += `<text x="78" y="${ly + 4}" font-size="14" fill="${COL.muted}">L1 (signals)</text>`;
  s += `<line x1="182" y1="${ly}" x2="212" y2="${ly}" stroke="${COL.L4}" stroke-width="3.5" stroke-dasharray="6 4"/>`;
  s += `<text x="220" y="${ly + 4}" font-size="14" fill="${COL.muted}">L4 (signals)</text>`;
  s += `<line x1="324" y1="${ly}" x2="354" y2="${ly}" stroke="${COL.muted}" stroke-width="3.5"/>`;
  s += `<text x="362" y="${ly + 4}" font-size="14" fill="${COL.muted}">L2/L3 (GND)</text>`;
  s += `<line x1="486" y1="${ly - 8}" x2="486" y2="${ly + 8}" stroke="${COL.L4}" stroke-width="2"/>`;
  s += `<circle cx="486" cy="${ly}" r="4" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2"/>`;
  s += `<text x="498" y="${ly + 4}" font-size="14" fill="${COL.muted}">via L1↔L4</text>`;
  s += `<circle cx="622" cy="${ly}" r="9" fill="${COL.conflict}" fill-opacity="0.16" stroke="${COL.conflict}" stroke-width="2"/>`;
  s += `<text x="638" y="${ly + 4}" font-size="14" fill="${COL.muted}">conflict</text>`;

  s += `<text x="${W / 2}" y="${H - 14}" text-anchor="middle" font-size="17" fill="${COL.text}">${esc(title)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg>`;
}

// --- charts -----------------------------------------------------------------

function chartCard(title, inner) {
  const dly = (CHART_IDX++ * 0.09).toFixed(2);
  const badge = CHART_SOURCE
    ? `<span class="chart-src${CHART_SOURCE === 'mock' ? ' mock' : ''}">${esc(CHART_SOURCE)}</span>`
    : '';
  return `<div class="chart" style="animation-delay:${dly}s"><h3><span class="chart-title">${esc(title)}</span> ${badge}<button class="chart-expand" type="button" title="Expand" aria-label="Expand chart">⤢</button></h3>${inner}</div>`;
}

function openChartModal(card) {
  const modal = document.getElementById('chart-modal');
  if (!modal || !card) return;
  const t = card.querySelector('.chart-title');
  const svg = card.querySelector('svg');
  modal.querySelector('.modal-title').textContent = t ? t.textContent : '';
  modal.querySelector('.modal-body').innerHTML = svg ? svg.outerHTML : '';
  modal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeChartModal() {
  const modal = document.getElementById('chart-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  modal.querySelector('.modal-body').innerHTML = '';
}

function energyChart({ title, xs, ys, mark, w = 560, h = 300 }) {
  const pad = { l: 64, r: 30, t: 34, b: 52 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
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
    s += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="${COL.muted}">${fmt(yv, 1)}</text>`;
  }
  const step = Math.max(1, Math.round(xs.length / 6));
  xs.forEach((xv, i) => {
    if (i % step === 0 || i === xs.length - 1) {
      s += `<text x="${X(i).toFixed(1)}" y="${bottom + 18}" text-anchor="middle" font-size="13" fill="${COL.muted}">${xv}</text>`;
    }
  });

  const pts = ys.map((v, i) => [X(i), Y(v)]);
  if (mark != null && Number.isFinite(mark)) {
    const ym = Y(mark);
    s += `<line x1="${pad.l}" y1="${ym.toFixed(1)}" x2="${w - pad.r}" y2="${ym.toFixed(1)}" stroke="${COL.L4}" stroke-width="1.6" stroke-dasharray="5 4"/>`;
    s += `<text x="${(pad.l + 6)}" y="${(ym - 5).toFixed(1)}" font-size="12" fill="${COL.L4}">measured ⟨H_C⟩ ${fmt(mark, 2)}</text>`;
  }
  const gid = nid();
  defs += vGrad(gid, COL.L1, 0.42, 0);
  s += `<path class="chart-area" d="${smoothPath(pts)} L ${pts[pts.length - 1][0].toFixed(1)},${bottom} L ${pts[0][0].toFixed(1)},${bottom} Z" fill="url(#${gid})"/>`;
  s += `<path class="chart-line" pathLength="1" d="${smoothPath(pts)}" fill="none" stroke="${COL.L1}" stroke-width="2.6" stroke-linecap="round"/>`;
  pts.forEach((p) => {
    s += `<circle class="chart-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${COL.chartBg}" stroke="${COL.L1}" stroke-width="2"/>`;
  });
  const last = pts[pts.length - 1];
  s += `<text class="fade-late" x="${(last[0] + 7).toFixed(1)}" y="${(last[1] - 8).toFixed(1)}" font-size="13" font-weight="700" fill="${COL.L1}">${fmt(ys[ys.length - 1], 2)}</text>`;
  s += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" font-size="14" fill="${COL.muted}">iteration</text>`;
  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><defs>${defs}</defs>${s}</svg>`);
}

function stackedBars({ title, rows, w = 560, h = 300 }) {
  const pad = { l: 110, r: 54, t: 46, b: 26 };
  const iw = w - pad.l - pad.r;
  const maxTotal = Math.max(...rows.map((r) => r.total)) || 1;
  const bh = 48, gap = 58;

  let defs = '';
  let s = '';
  rows.forEach((r, ri) => {
    const y = pad.t + ri * (bh + gap);
    s += `<text x="${pad.l - 14}" y="${y + bh / 2 + 5}" text-anchor="end" font-size="15" fill="${COL.text}">${esc(r.label)}</text>`;
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
      if (segW > 42) {
        s += `<text class="fade-late" style="animation-delay:${(Number(dly) + 0.35).toFixed(2)}s" x="${(x + segW / 2).toFixed(1)}" y="${y + bh / 2 + 4}" text-anchor="middle" font-size="13" font-weight="700" fill="#08111c">${fmt(seg.value, 1)}</text>`;
      }
      x += segW;
    });
    s += `<text class="fade-late" style="animation-delay:${(0.25 + ri * 0.18 + 0.4).toFixed(2)}s" x="${(pad.l + (r.total / maxTotal) * iw + 10).toFixed(1)}" y="${y + bh / 2 + 5}" font-size="15" font-weight="600" fill="${COL.text}">${fmt(r.total, 2)}</text>`;
  });

  rows[0].segments.forEach((seg, k) => {
    const lx = pad.l + k * 150, lyy = 22;
    s += `<rect x="${lx}" y="${lyy - 9}" width="16" height="10" rx="3" fill="${seg.color}"/>`;
    s += `<text x="${lx + 22}" y="${lyy}" font-size="13" fill="${COL.muted}">${esc(seg.name)}</text>`;
  });

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><defs>${defs}</defs>${s}</svg>`);
}

function fmtBig(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(v);
}

function combosSvg(scale, w = 560, h = 320, nMax = 27) {
  const pad = { l: 62, r: 20, t: 26, b: 44 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const maxV = Math.pow(2, nMax);
  const maxLog = nMax * Math.log10(2);
  const yFor = (n) => {
    const frac = scale === 'log' ? (n * Math.log10(2)) / maxLog : Math.pow(2, n) / maxV;
    return pad.t + ih - frac * ih;
  };
  const bw = iw / nMax;

  let s = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="10" fill="${COL.chartBg}"/>`;
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + ih - (g / 4) * ih;
    s += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${COL.grid}" stroke-width="1" stroke-dasharray="2 6" opacity="0.75"/>`;
    const lab = scale === 'log' ? `1e${(maxLog * g / 4).toFixed(0)}` : fmtBig(maxV * g / 4);
    s += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="${COL.muted}">${lab}</text>`;
  }
  for (let n = 1; n <= nMax; n++) {
    const top = yFor(n);
    const bh = Math.max((pad.t + ih) - top, 1);
    const x = pad.l + (n - 1) * bw + bw * 0.14;
    const width = bw * 0.72;
    const mark = (n === 9 || n === 18 || n === 27);
    const color = mark ? COL.L4 : COL.L1;
    s += `<rect class="fade-late" style="animation-delay:${(0.1 + n * 0.015).toFixed(2)}s" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${color}" opacity="${mark ? 0.95 : 0.7}"><title>${n} lines · 2^${n} = ${fmtBig(Math.pow(2, n))}</title></rect>`;
    if (n <= 12 || n % 3 === 0 || mark) {
      s += `<text x="${(x + width / 2).toFixed(1)}" y="${pad.t + ih + 15}" text-anchor="middle" font-size="12" fill="${COL.muted}">${n}</text>`;
    }
    if (mark) {
      s += `<text x="${(x + width / 2).toFixed(1)}" y="${(top - 5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${COL.L4}">${fmtBig(Math.pow(2, n))}</text>`;
    }
  }
  s += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" font-size="14" fill="${COL.muted}">number of lines (qubits)</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`;
}

function combosCard(scale) {
  const dly = (CHART_IDX++ * 0.09).toFixed(2);
  return `<div class="chart" style="animation-delay:${dly}s">
    <h3><span class="chart-title">Possible configurations</span> <span class="chart-src">theoretical</span>
      <span class="combos-toggle"><button class="tg${scale === 'log' ? ' active' : ''}" data-s="log" type="button">log</button><button class="tg${scale === 'linear' ? ' active' : ''}" data-s="linear" type="button">linear</button></span>
      <button class="chart-expand" type="button" title="Expand" aria-label="Expand chart">⤢</button>
    </h3>
    <div class="combos-body">${combosSvg(scale)}</div>
  </div>`;
}

function distributionChart({ title, items, ideal, w = 560, h = 340 }) {
  const pad = { l: 56, r: 18, t: 30, b: 84 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const key = (d) => (d.x || []).join('');

  const map = new Map();
  (ideal || []).forEach((d) => map.set(key(d), { label: key(d), ideal: d.prob, backend: 0, feasible: d.feasible }));
  (items || []).forEach((d) => {
    const k = key(d);
    const e = map.get(k) || { label: k, ideal: 0, backend: 0, feasible: d.feasible };
    e.backend = d.prob;
    e.feasible = d.feasible;
    map.set(k, e);
  });

  const grouped = Array.isArray(ideal) && ideal.length > 0;
  let rows = [...map.values()];
  rows.sort((a, b) => Math.max(b.ideal, b.backend) - Math.max(a.ideal, a.backend));
  rows = rows.slice(0, 16);
  const maxP = Math.max(...rows.map((r) => Math.max(r.ideal, r.backend)), 1e-6);
  const slot = iw / Math.max(rows.length, 1);

  let s = `<rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="10" fill="${COL.chartBg}"/>`;
  for (let g = 0; g <= 4; g++) {
    const yv = maxP * g / 4;
    const y = pad.t + ih - (yv / maxP) * ih;
    s += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="${COL.grid}" stroke-width="1" stroke-dasharray="2 6" opacity="0.75"/>`;
    s += `<text x="${pad.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="${COL.muted}">${fmt(yv, 2)}</text>`;
  }

  const bar = (x, width, val, color, i) => {
    const bh = Math.max((val / maxP) * ih, val > 0 ? 2 : 0);
    const y = pad.t + ih - bh;
    s += `<rect class="fade-late" style="animation-delay:${(0.2 + i * 0.02).toFixed(2)}s" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${color}" opacity="0.9"/>`;
  };

  rows.forEach((r, i) => {
    const x0 = pad.l + i * slot;
    if (grouped) {
      const bw = slot * 0.38;
      bar(x0 + slot * 0.12, bw, r.ideal, COL.muted, i);
      bar(x0 + slot * 0.5, bw, r.backend, COL.L1, i);
    } else {
      bar(x0 + slot * 0.16, slot * 0.68, r.backend || r.ideal, r.feasible ? COL.L1 : COL.conflict, i);
    }
    const cx = (x0 + slot / 2).toFixed(1);
    s += `<text x="${cx}" y="${pad.t + ih + 12}" text-anchor="end" font-size="11" fill="${COL.muted}" transform="rotate(-60 ${cx} ${pad.t + ih + 12})">${esc(r.label)}</text>`;
  });

  const ly = h - 22;
  if (grouped) {
    s += `<rect x="${pad.l}" y="${ly}" width="16" height="10" rx="3" fill="${COL.muted}"/>`;
    s += `<text x="${pad.l + 22}" y="${ly + 10}" font-size="13" fill="${COL.muted}">ideal</text>`;
    s += `<rect x="${pad.l + 92}" y="${ly}" width="16" height="10" rx="3" fill="${COL.L1}"/>`;
    s += `<text x="${pad.l + 114}" y="${ly + 10}" font-size="13" fill="${COL.muted}">backend</text>`;
  } else {
    s += `<rect x="${pad.l}" y="${ly}" width="16" height="10" rx="3" fill="${COL.L1}"/>`;
    s += `<text x="${pad.l + 22}" y="${ly + 10}" font-size="13" fill="${COL.muted}">valid</text>`;
    s += `<rect x="${pad.l + 104}" y="${ly}" width="16" height="10" rx="3" fill="${COL.conflict}"/>`;
    s += `<text x="${pad.l + 126}" y="${ly + 10}" font-size="13" fill="${COL.muted}">conflict</text>`;
  }
  s += `<text x="${w - pad.r}" y="${ly + 10}" text-anchor="end" font-size="12" fill="${COL.muted}">probability per bitstring</text>`;

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
}

function heatmap({ title, nets, weights, conflicts, w = 560 }) {
  const n = nets.length;
  const cell = Math.max(14, Math.min(32, Math.floor((w - 132) / n)));
  const gap = Math.max(2, Math.round(cell * 0.12));
  const ox = 100, oy = 54;
  const h = oy + n * cell + 78;
  const maxW = Math.max(...weights.flat()) || 1;
  const cset = new Set(conflicts.map(([a, b]) => `${nets.indexOf(a)}|${nets.indexOf(b)}`));

  const cbarId = nid();
  const defs = `<linearGradient id="${cbarId}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${COL.heatLow}"/><stop offset="100%" stop-color="${COL.L1}"/></linearGradient>`;

  let s = '';
  nets.forEach((nn, i) => {
    s += `<text x="${ox - 12}" y="${oy + i * cell + cell / 2 + 4}" text-anchor="end" font-size="13" fill="${COL.muted}">${nn}</text>`;
    s += `<text x="${ox + i * cell + cell / 2}" y="${oy - 10}" text-anchor="middle" font-size="13" fill="${COL.muted}">${nn}</text>`;
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
        s += `<text class="pop-late" style="animation-delay:${(Number(dly) + 0.2).toFixed(2)}s" x="${(x + d / 2).toFixed(1)}" y="${(y + d / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="14" fill="${COL.conflict}">✕</text>`;
      } else {
        s += `<rect class="cell" style="animation-delay:${dly}s" x="${x}" y="${y}" width="${d}" height="${d}" rx="6" fill="${hexLerp(COL.heatLow, COL.L1, t)}"/>`;
      }
    }
  }

  const cbY = oy + n * cell + 22, cbW = 220;
  s += `<rect x="${ox}" y="${cbY}" width="${cbW}" height="10" rx="5" fill="url(#${cbarId})"/>`;
  s += `<text x="${ox}" y="${cbY + 28}" font-size="13" fill="${COL.muted}">0</text>`;
  s += `<text x="${ox + cbW}" y="${cbY + 28}" text-anchor="end" font-size="13" fill="${COL.muted}">${fmt(maxW, 2)}</text>`;
  s += `<text x="${ox + cbW + 16}" y="${cbY + 10}" font-size="13" fill="${COL.muted}">coupling strength</text>`;
  s += `<circle cx="${ox + cbW + 20}" cy="${cbY + 34}" r="7" fill="${COL.conflict}" fill-opacity="0.22" stroke="${COL.conflict}" stroke-width="1.4" stroke-dasharray="3 2"/>`;
  s += `<text x="${ox + cbW + 34}" y="${cbY + 38}" font-size="13" fill="${COL.muted}">conflict</text>`;

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><defs>${defs}</defs>${s}</svg>`);
}

// 2D preview of the ADC->FPGA order (input left, FPGA slots right; straight lines).
export function routingPreview(nets, order) {
  const n = nets.length;
  const W = 360, H = Math.max(240, 26 * n + 40);
  const xL = 78, xR = W - 78, y0 = 26, y1 = H - 26;
  const y = (i) => y0 + (n <= 1 ? 0 : (i / (n - 1)) * (y1 - y0));
  const rank = Object.fromEntries(order.map((nn, i) => [nn, i]));

  let s = `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="10" fill="${COL.chartBg}"/>`;
  for (let i = 0; i < n; i++) {
    const a = [xL, y(i)], b = [xR, y(rank[nets[i]] ?? i)];
    s += `<line x1="${a[0]}" y1="${a[1].toFixed(1)}" x2="${b[0]}" y2="${b[1].toFixed(1)}" stroke="${COL.L1}" stroke-width="1.6" opacity="0.7"/>`;
  }
  for (let i = 0; i < n; i++) {
    const a = [xL, y(i)];
    s += `<circle cx="${a[0]}" cy="${a[1].toFixed(1)}" r="3.5" fill="${COL.L1}"/>`;
    s += `<text x="${xL - 8}" y="${(a[1] + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${COL.muted}">${esc(nets[i])}</text>`;
  }
  for (let j = 0; j < n; j++) {
    const b = [xR, y(j)];
    s += `<circle cx="${b[0]}" cy="${b[1].toFixed(1)}" r="3.5" fill="${COL.L4}"/>`;
    s += `<text x="${xR + 8}" y="${(b[1] + 4).toFixed(1)}" font-size="11" fill="${COL.muted}">${esc(order[j])}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg>`;
}

function miniBoard(model, maps, bits, label, sub) {
  const { nidx, rankIn, rankOut } = maps;
  const nN = model.nets.length;
  const W = 380, H = 208;
  const bx = (x) => 70 + ((x - 16) / (104 - 16)) * (310 - 70);
  const bz = (z) => 44 + (z / LZ_OF(nN)) * (154 - 44);
  const pt = ([x, z]) => [bx(x), bz(z)];
  const str = (arr) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  let s = `<rect x="8" y="8" width="364" height="160" rx="8" fill="${COL.board}" stroke="${COL.blockEdge}"/>`;
  s += `<rect x="18" y="52" width="40" height="72" rx="5" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text x="38" y="91" text-anchor="middle" font-size="12" fill="${COL.text}">ADC</text>`;
  s += `<rect x="322" y="52" width="40" height="72" rx="5" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text x="342" y="91" text-anchor="middle" font-size="12" fill="${COL.text}">FPGA</text>`;

  model.nets.forEach((n) => {
    const layer = bits[nidx[n]];
    const color = layer === 0 ? COL.L1 : COL.L4;
    const pts = route(zAt(rankIn[n], nN), zAt(rankOut[n], nN)).map(pt);
    const dash = layer === 1 ? 'stroke-dasharray="4 3"' : '';
    s += `<polyline points="${str(pts)}" fill="none" stroke="${color}" stroke-width="${nN > 12 ? 1.6 : 2.4}" opacity="0.95" ${dash}/>`;
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
      s += `<text x="${p[0].toFixed(1)}" y="${(p[1] + 3).toFixed(1)}" text-anchor="middle" font-size="12" fill="${COL.conflict}">✕</text>`;
    }
  });

  s += `<text x="${W / 2}" y="186" text-anchor="middle" font-size="13" fill="${COL.text}">${esc(label)} · ${esc(sub)}</text>`;
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

function loadingBoard(title) {
  const W = 900, H = 452;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    <rect x="16" y="16" width="868" height="360" rx="12" fill="${COL.board}" stroke="${COL.blockEdge}"/>
    <text x="${W / 2}" y="205" text-anchor="middle" font-size="24" fill="${COL.muted}">Running QAOA…</text>
    <text x="${W / 2}" y="410" text-anchor="middle" font-size="17" fill="${COL.text}">${esc(title)}</text>
  </svg>`;
}

function loadingCard(title, text = 'Running QAOA…') {
  return chartCard(title, '<div style="height:170px;display:flex;align-items:center;justify-content:center;color:' + COL.muted + '">' + text + '</div>');
}

// Fast pre-QAOA view: BEFORE + things that do not depend on QAOA; AFTER/QAOA = loading.
let currentView = '3d';

function drawBoards(model, maps, loading) {
  const fn = currentView === '2d' ? boardSvg : board3d;
  const b = model.costs.before;
  const elBefore = document.getElementById('board-before');
  const elAfter = document.getElementById('board-after');
  const beforeCounts = `${model.assignments.before_layers.L1.length} on L1 · ${b.violations} conflicts`;
  elBefore.innerHTML = fn(model, maps, model.assignments.before, `BEFORE · ${beforeCounts}`);
  if (loading) {
    const t = model.status === 'running' ? 'AFTER · running QAOA…' : 'AFTER · press ▶ Run';
    elAfter.innerHTML = loadingBoard(t);
  } else {
    const a = model.costs.after;
    const afterCounts = `L1 ${model.assignments.after_layers.L1.length} · L4 ${model.assignments.after_layers.L4.length} · ${a.violations} conflicts`;
    elAfter.innerHTML = fn(model, maps, model.assignments.after, `AFTER · ${afterCounts}`);
    finishTraces(elAfter);
  }
  finishTraces(elBefore);
}

function wireViewTabs(model, maps, loading) {
  document.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === currentView);
    btn.onclick = () => {
      currentView = btn.dataset.view;
      document.querySelectorAll('button[data-view]').forEach((x) => x.classList.toggle('active', x === btn));
      drawBoards(model, maps, loading);
    };
  });
}

function renderLoading(model) {
  const maps = {
    nidx: Object.fromEntries(model.nets.map((n, i) => [n, i])),
    rankIn: Object.fromEntries(model.in_order.map((n, i) => [n, i])),
    rankOut: Object.fromEntries(model.out_order.map((n, i) => [n, i])),
  };
  const b = model.costs.before;

  drawBoards(model, maps, true);
  wireViewTabs(model, maps, true);

  const evo = document.getElementById('evolution');
  if (evo) evo.innerHTML = `<p class="note">${model.status === 'running' ? 'Running QAOA…' : 'Press ▶ Run'}</p>`;

  document.getElementById('stats').innerHTML = [
    statCard('Qubits', String(model.meta.num_qubits || model.meta.n_nets), '', COL.coupling),
    statCard('Circuit cost (lower is better)', `${fmt(b.total)} → …`, 'baseline (all L1) → after QAOA', COL.L4),
  ].join('');

  CHART_IDX = 0;
  const charts = [];
  CHART_SOURCE = 'model';
  charts.push(stackedBars({
    title: 'Cost breakdown',
    rows: [{ label: 'Baseline', total: b.total, segments: [
      { name: 'Coupling', value: b.coupling, color: COL.coupling },
      { name: 'Vias', value: b.via_cost, color: COL.viaCost },
      { name: 'Conflicts', value: b.conflict_cost, color: COL.conflictCost },
    ] }],
  }));
  CHART_SOURCE = 'QAOA';
  charts.push(loadingCard('Circuit distribution', model.status === 'running' ? 'Running QAOA…' : 'Press ▶ Run'));
  charts.push(loadingCard('QAOA convergence · energy ⟨H_C⟩', model.status === 'running' ? 'Running QAOA…' : 'Press ▶ Run'));
  CHART_SOURCE = 'theoretical';
  charts.push(combosCard('log'));
  CHART_SOURCE = 'geometric';
  charts.push(heatmap({ title: 'Coupling matrix', nets: model.nets, weights: model.weights, conflicts: model.conflicts }));
  CHART_SOURCE = '';
  document.getElementById('charts').innerHTML = charts.join('');
  wireChartInteractions();
}

// --- render -----------------------------------------------------------------

export function render(model) {
  if (model.loading) { renderLoading(model); return; }
  const nidx = Object.fromEntries(model.nets.map((n, i) => [n, i]));
  const maps = {
    nidx,
    rankIn: Object.fromEntries(model.in_order.map((n, i) => [n, i])),
    rankOut: Object.fromEntries(model.out_order.map((n, i) => [n, i])),
  };

  const b = model.costs.before;
  const a = model.costs.after;
  const improvement = b.total > 0 ? ((b.total - a.total) / b.total) * 100 : 0;
  const isReal = model.source === 'qaoa';

  drawBoards(model, maps, false);
  wireViewTabs(model, maps, false);

  // solution evolution (best-so-far per iteration)
  const evo = document.getElementById('evolution');
  if (evo) {
    evo.innerHTML = (isReal && Array.isArray(model.solutions) && model.solutions.length)
      ? '<div class="evolution-grid">' + model.solutions.map((sol) =>
          miniBoard(model, maps, sol.x, `iter ${sol.iter}`,
            `cost ${fmt(sol.cost)} · ${sol.violations ? 'invalid' : 'valid'}`)
        ).join('') + '</div>'
      : '';
  }

  // summary chips
  const qubits = model.meta.num_qubits || model.meta.n_nets;
  const cards = [
    statCard('Qubits', String(qubits), isReal ? `p=${model.meta.reps} · ${model.meta.num_parameters} params` : '', COL.coupling),
  ];
  cards.push(`<div class="stat" style="--accent:${COL.coupling}">
    <span class="stat-label">Circuit cost (lower is better)</span>
    <span class="stat-value"><span class="dash">${fmt(b.total)}</span> → ${fmt(a.total)}</span>
    <span class="stat-sub">baseline (all L1) → after QAOA</span>
  </div>`);
  cards.push(`<div class="stat" style="--accent:${COL.L4}">
    <span class="stat-label">Cost reduction</span>
    <span class="stat-value">−${fmt(improvement, 1)}%</span>
    <div class="stat-bar"><span style="width:${Math.max(0, Math.min(100, improvement)).toFixed(0)}%"></span></div>
    <span class="stat-sub">vs baseline</span>
  </div>`);
  const pct = (v) => (v == null ? '—' : `${fmt(v * 100, 1)}%`);
  if (model.tvd != null) {
    cards.push(statCard('Model distance (TVD)', fmt(model.tvd, 3), 'ideal vs backend', COL.conflict));
    cards.push(statCard('Success rate', `${pct(model.success_ideal)} → ${pct(model.success_backend)}`, 'ideal → backend', COL.coupling));
    cards.push(statCard('Valid', `${pct(model.valid_ideal)} → ${pct(model.valid_backend)}`, 'ideal → backend', COL.L4));
  } else if (model.success_ideal != null) {
    cards.push(statCard('Success rate', pct(model.success_ideal), 'on the optimum', COL.coupling));
    cards.push(statCard('Valid', pct(model.valid_mass), 'feasible samples', COL.L4));
  }
  document.getElementById('stats').innerHTML = cards.join('');

  // charts
  CHART_IDX = 0;
  const charts = [];

  CHART_SOURCE = isReal ? 'model' : 'mock';
  charts.push(stackedBars({
    title: 'Cost breakdown',
    rows: [
      { label: 'Baseline', total: b.total, segments: [
        { name: 'Coupling', value: b.coupling, color: COL.coupling },
        { name: 'Vias', value: b.via_cost, color: COL.viaCost },
        { name: 'Conflicts', value: b.conflict_cost, color: COL.conflictCost },
      ] },
      { label: 'After QAOA', total: a.total, segments: [
        { name: 'Coupling', value: a.coupling, color: COL.coupling },
        { name: 'Vias', value: a.via_cost, color: COL.viaCost },
        { name: 'Conflicts', value: a.conflict_cost, color: COL.conflictCost },
      ] },
    ],
  }));

  const idealDist = Array.isArray(model.ideal_distribution) ? model.ideal_distribution : null;
  CHART_SOURCE = idealDist ? 'ideal vs backend'
    : (model.distribution_source === 'backend' ? 'backend' : (isReal ? 'ideal' : 'mock'));
  if (Array.isArray(model.distribution) && model.distribution.length) {
    charts.push(distributionChart({
      title: idealDist ? 'Circuit distribution · ideal vs backend' : 'Circuit distribution',
      items: model.distribution,
      ideal: idealDist,
    }));
  }

  CHART_SOURCE = 'ideal · local';
  if (model.convergence && Array.isArray(model.convergence.energy)) {
    charts.push(energyChart({
      title: 'QAOA convergence · energy ⟨H_C⟩ (ideal, local optimization)',
      xs: model.convergence.x,
      ys: model.convergence.energy,
      mark: model.measured_energy,
    }));
  }

  charts.push(combosCard('log'));

  CHART_SOURCE = isReal ? 'geometric' : 'mock';
  charts.push(heatmap({
    title: 'Coupling matrix',
    nets: model.nets,
    weights: model.weights,
    conflicts: model.conflicts,
  }));

  CHART_SOURCE = '';
  document.getElementById('charts').innerHTML = charts.join('');

  wireChartInteractions();
}

function wireChartInteractions() {
  document.querySelectorAll('.combos-toggle .tg').forEach((btn) => {
    btn.onclick = () => {
      const body = document.querySelector('.combos-body');
      if (body) body.innerHTML = combosSvg(btn.dataset.s);
      document.querySelectorAll('.combos-toggle .tg').forEach((x) => x.classList.toggle('active', x === btn));
    };
  });
  document.querySelectorAll('.chart-expand').forEach((btn) => {
    btn.onclick = () => openChartModal(btn.closest('.chart'));
  });
  const modal = document.getElementById('chart-modal');
  if (modal && !modal.dataset.wired) {
    modal.dataset.wired = '1';
    modal.querySelector('.modal-close').onclick = closeChartModal;
    modal.addEventListener('click', (e) => { if (e.target === modal) closeChartModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChartModal(); });
  }
}

// Result of a run on the backend selected in Qollab (QPU or simulator).
export function renderBackend(q, model) {
  const el = document.getElementById('qpu');
  if (!el) return;
  if (!q || !q.counts) { el.innerHTML = ''; return; }

  const valid = model.valid_mass != null ? fmt(model.valid_mass * 100, 1) : null;

  let ops = '';
  if (q.circuit) {
    ops = Object.entries(q.circuit.ops || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(' · ');
  }

  el.innerHTML = `
    <p class="qpu-line"><strong>${esc(q.backend_name || 'backend')}</strong> · ${q.shots || 0} shots · 1 job${valid != null ? ` · valid ${valid}%` : ''}</p>
    ${q.circuit ? `<p class="note">Executed circuit: <strong>${q.circuit.num_qubits} qubits</strong> · depth ${q.circuit.depth} · ${q.circuit.size} gates${ops ? ` · ${esc(ops)}` : ''}</p>` : ''}`;
}

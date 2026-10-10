// QuietTracE — motor de visualización (render puro, sin datos).
//
// `render(model)` dibuja la PCB antes/después y las gráficas de valor a partir
// de un modelo con la forma que devuelve `quantum/pcb.py`.
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

function hexLerp(a, b, t) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  const p = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${p.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
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

function boardSvg(model, maps, assignment, title) {
  const { nidx, rankIn, rankOut } = maps;
  const W = 900, H = 452;
  const x0 = 215, x1 = 700;
  const yin = (n) => 50 + rankIn[n] * 40;
  const yout = (n) => 50 + rankOut[n] * 40;
  const via = (cx, cy) =>
    `<circle cx="${cx}" cy="${cy}" r="5.5" fill="${COL.board}" stroke="${COL.L4}" stroke-width="2.5"/>`;

  let s = '';
  s += `<rect x="16" y="16" width="868" height="360" rx="12" fill="${COL.board}" stroke="${COL.blockEdge}"/>`;
  s += `<rect x="40" y="110" width="130" height="220" rx="8" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text x="105" y="212" text-anchor="middle" font-size="15" fill="${COL.text}">ADC08060</text>`;
  s += `<text x="105" y="232" text-anchor="middle" font-size="11" fill="${COL.muted}">8 bits · 40 MSPS</text>`;
  s += `<rect x="730" y="110" width="130" height="220" rx="8" fill="${COL.block}" stroke="${COL.blockEdge}"/>`;
  s += `<text x="795" y="212" text-anchor="middle" font-size="15" fill="${COL.text}">FPGA</text>`;
  s += `<text x="795" y="232" text-anchor="middle" font-size="11" fill="${COL.muted}">receptora</text>`;

  model.nets.forEach((n) => {
    const layer = assignment[nidx[n]];
    const color = layer === 0 ? COL.L1 : COL.L4;
    const dash = layer === 0 ? '' : 'stroke-dasharray="7 5"';
    const op = layer === 0 ? 0.95 : 0.82;
    const y1 = yin(n), y2 = yout(n);
    s += `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y2}" stroke="${color}" stroke-width="3.5" opacity="${op}" ${dash}/>`;
    if (layer === 1) s += via(x0, y1) + via(x1, y2);
    s += `<text x="${x0 - 10}" y="${y1 + 4}" text-anchor="end" font-size="12" fill="${color}">${n}</text>`;
    s += `<text x="${x1 + 10}" y="${y2 + 4}" font-size="12" fill="${color}">${n}</text>`;
  });

  const alive = model.conflicts.filter(([a, b]) => assignment[nidx[a]] === assignment[nidx[b]]);
  alive.forEach(([a, b]) => {
    const p = segInter([x0, yin(a)], [x1, yout(a)], [x0, yin(b)], [x1, yout(b)]);
    if (p) {
      s += `<circle cx="${p[0]}" cy="${p[1]}" r="12" fill="rgba(255,84,112,0.16)" stroke="${COL.conflict}" stroke-width="2"/>`;
      s += `<text x="${p[0]}" y="${p[1] + 5}" text-anchor="middle" font-size="15" fill="${COL.conflict}">✕</text>`;
    }
  });

  const ly = 430;
  s += `<line x1="40" y1="${ly}" x2="70" y2="${ly}" stroke="${COL.L1}" stroke-width="3.5"/>`;
  s += `<text x="78" y="${ly + 4}" font-size="12" fill="${COL.muted}">L1</text>`;
  s += `<line x1="118" y1="${ly}" x2="148" y2="${ly}" stroke="${COL.L4}" stroke-width="3.5" stroke-dasharray="7 5"/>`;
  s += `<text x="156" y="${ly + 4}" font-size="12" fill="${COL.muted}">L4 (oculto)</text>`;
  s += via(220, ly);
  s += `<text x="232" y="${ly + 4}" font-size="12" fill="${COL.muted}">vía</text>`;
  s += `<circle cx="292" cy="${ly}" r="9" fill="rgba(255,84,112,0.16)" stroke="${COL.conflict}" stroke-width="2"/>`;
  s += `<text x="308" y="${ly + 4}" font-size="12" fill="${COL.muted}">conflicto</text>`;

  s += `<text x="${W / 2}" y="410" text-anchor="middle" font-size="14" fill="${COL.text}">${esc(title)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${s}</svg>`;
}

function chartCard(title, inner) {
  return `<div class="chart"><h3>${esc(title)}</h3>${inner}</div>`;
}

function lineChart({ title, xs, series, xLabel = '', w = 560, h = 290 }) {
  const pad = { l: 58, r: 18, t: 30, b: 52 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const all = series.flatMap((s) => s.values);
  let yMin = Math.min(...all), yMax = Math.max(...all);
  const padv = (yMax - yMin) * 0.12 || 1;
  yMin -= padv; yMax += padv;
  const X = (i) => pad.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const Y = (v) => pad.t + ih - ((v - yMin) / (yMax - yMin)) * ih;

  let s = '';
  for (let g = 0; g <= 4; g++) {
    const yv = yMin + (yMax - yMin) * (g / 4);
    const y = Y(yv);
    s += `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="${COL.grid}" stroke-width="1"/>`;
    s += `<text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${COL.muted}">${fmt(yv, 1)}</text>`;
  }

  const step = Math.max(1, Math.round(xs.length / 6));
  xs.forEach((xv, i) => {
    if (i % step === 0 || i === xs.length - 1) {
      s += `<text x="${X(i)}" y="${pad.t + ih + 18}" text-anchor="middle" font-size="11" fill="${COL.muted}">${xv}</text>`;
    }
  });

  series.forEach((sr) => {
    const pts = sr.values.map((v, i) => `${X(i)},${Y(v)}`).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="${sr.color}" stroke-width="2.5" ${sr.dash ? `stroke-dasharray="${sr.dash}"` : ''}/>`;
    sr.values.forEach((v, i) => {
      s += `<circle cx="${X(i)}" cy="${Y(v)}" r="3" fill="${sr.color}"/>`;
    });
  });

  series.forEach((sr, k) => {
    const lx = pad.l + 4 + k * 132, lyy = pad.t + 2;
    s += `<line x1="${lx}" y1="${lyy}" x2="${lx + 20}" y2="${lyy}" stroke="${sr.color}" stroke-width="3"/>`;
    s += `<text x="${lx + 26}" y="${lyy + 4}" font-size="11" fill="${COL.muted}">${esc(sr.name)}</text>`;
  });

  s += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" font-size="12" fill="${COL.muted}">${esc(xLabel)}</text>`;
  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
}

function stackedBars({ title, rows, w = 560, h = 290 }) {
  const pad = { l: 96, r: 28, t: 40, b: 28 };
  const iw = w - pad.l - pad.r;
  const maxTotal = Math.max(...rows.map((r) => r.total)) || 1;
  const bh = 46, gap = 54;

  let s = '';
  rows.forEach((r, ri) => {
    const y = pad.t + ri * (bh + gap);
    s += `<text x="${pad.l - 12}" y="${y + bh / 2 + 5}" text-anchor="end" font-size="13" fill="${COL.text}">${esc(r.label)}</text>`;
    let x = pad.l;
    r.segments.forEach((seg) => {
      const segW = (seg.value / maxTotal) * iw;
      if (segW <= 0) return;
      s += `<rect x="${x}" y="${y}" width="${segW}" height="${bh}" fill="${seg.color}" opacity="0.9"/>`;
      if (segW > 34) {
        s += `<text x="${x + segW / 2}" y="${y + bh / 2 + 4}" text-anchor="middle" font-size="11" fill="#0b1020">${fmt(seg.value, 1)}</text>`;
      }
      x += segW;
    });
    s += `<text x="${x + 8}" y="${y + bh / 2 + 5}" font-size="13" fill="${COL.text}">${fmt(r.total, 2)}</text>`;
  });

  rows[0].segments.forEach((seg, k) => {
    const lx = pad.l + k * 150, lyy = 20;
    s += `<rect x="${lx}" y="${lyy - 8}" width="12" height="12" fill="${seg.color}"/>`;
    s += `<text x="${lx + 18}" y="${lyy + 2}" font-size="11" fill="${COL.muted}">${esc(seg.name)}</text>`;
  });

  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
}

function heatmap({ title, nets, weights, conflicts, w = 560, h = 340 }) {
  const n = nets.length;
  const cell = 30;
  const ox = 96, oy = 56;
  const maxW = Math.max(...weights.flat()) || 1;
  const cset = new Set(conflicts.map(([a, b]) => `${nets.indexOf(a)}|${nets.indexOf(b)}`));

  let s = '';
  nets.forEach((nn, i) => {
    s += `<text x="${ox - 10}" y="${oy + i * cell + cell / 2 + 4}" text-anchor="end" font-size="11" fill="${COL.muted}">${nn}</text>`;
    s += `<text x="${ox + i * cell + cell / 2}" y="${oy - 10}" text-anchor="middle" font-size="11" fill="${COL.muted}">${nn}</text>`;
  });

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = ox + j * cell, y = oy + i * cell;
      if (i === j) {
        s += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${COL.grid}" opacity="0.4"/>`;
        continue;
      }
      const isConflict = cset.has(`${i}|${j}`) || cset.has(`${j}|${i}`);
      const t = isConflict ? 0 : weights[i][j] / maxW;
      const fill = isConflict ? COL.conflict : hexLerp('#16203c', COL.L1, t);
      s += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${cell - 1}" height="${cell - 1}" fill="${fill}" opacity="${isConflict ? 0.35 : 0.9}" stroke="${isConflict ? COL.conflict : 'none'}"/>`;
      if (isConflict) {
        s += `<text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" font-size="12" fill="${COL.conflict}">✕</text>`;
      }
    }
  }
  s += `<text x="${ox + 2}" y="${oy + n * cell + 30}" font-size="11" fill="${COL.muted}">color = acoplamiento w_ij (mock) · ✕ = conflicto geométrico</text>`;
  return chartCard(title, `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img">${s}</svg>`);
}

function statCard(label, value, sub = '', accent = '') {
  return `<div class="stat"${accent ? ` style="--accent:${accent}"` : ''}>
    <span class="stat-label">${esc(label)}</span>
    <span class="stat-value">${esc(value)}</span>
    <span class="stat-sub">${esc(sub)}</span>
  </div>`;
}

export function render(model) {
  const nidx = Object.fromEntries(model.nets.map((n, i) => [n, i]));
  const rankIn = Object.fromEntries(model.in_order.map((n, i) => [n, i]));
  const rankOut = Object.fromEntries(model.out_order.map((n, i) => [n, i]));
  const maps = { nidx, rankIn, rankOut };

  const b = model.costs.before;
  const a = model.costs.after;
  const improvement = b.total > 0 ? ((b.total - a.total) / b.total) * 100 : 0;

  const beforeCounts = `${model.assignments.before_layers.L1.length} en L1 · ${b.violations} conflictos`;
  const afterCounts = `L1 ${model.assignments.after_layers.L1.length} · L4 ${model.assignments.after_layers.L4.length} · ${a.violations} conflictos`;

  document.getElementById('board-before').innerHTML =
    boardSvg(model, maps, model.assignments.before, `ANTES · ${beforeCounts}`);
  document.getElementById('board-after').innerHTML =
    boardSvg(model, maps, model.assignments.after, `DESPUÉS · ${afterCounts}`);

  document.getElementById('stats').innerHTML = [
    statCard('Costo antes', fmt(b.total), 'corte + vías + conflictos', COL.coupling),
    statCard('Costo después', fmt(a.total), 'solución factible', COL.L4),
    statCard('Mejora', `${fmt(improvement, 1)}%`, 'vs. todas en L1', COL.conflict),
    statCard('Conflictos', `${b.violations} → ${a.violations}`, 'resueltos por capa', COL.conflict),
    statCard('Vías', `${b.vias} → ${a.vias}`, `${model.meta.vias_per_l4} por red a L4`, COL.L4),
    statCard('Parámetros', `λv=${model.meta.lambda_v} · M=${model.meta.m_penalty}`, 'mock', COL.muted),
  ].join('');

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

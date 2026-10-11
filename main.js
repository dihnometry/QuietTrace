// QuietTracE — JS entry point (Qollab, and the local dev server via a shim).
//
// Problem (1 ADC / 2 ADC) and the ADC->FPGA connection order are chosen in the UI.
// The pipeline always optimizes locally; if Qollab injects `backend`, ONE QAOA
// circuit is sent and the charts use that backend's counts.

import * as pipeline from 'quantum.pipeline'; // Pyodide in Qollab; shim locally
import { render, renderBackend, routingPreview } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };
const setQpu = (html) => { const el = document.getElementById('qpu'); if (el) el.innerHTML = html; };
const hasBackendNow = () => (typeof backend !== 'undefined') && !!backend;

// In the Qollab export the tuning knobs are LOCKED (depth 5, conflict ×5, COMSOL
// weights); the local dev preview (dev/app-local.html) sets window.__QT_DEV__ to
// unlock them. The locked values follow the notebook sweeps (sections 9-10).
const DEV = !!window.__QT_DEV__;
const LOCKED = { wsource: 'comsol', reps: 5, cmult: 5 };
// Team name shown in the console banner (edit this if it should read differently).
const TEAM = 'QuietTracE';

const SHOTS = 3072;

const clamp = (v, lo, hi, dflt) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt;
};

let currentKind = '1adc';
let currentModel = 'full';   // 'full' (n qubits) | 'reduced' (k qubits, componentes)
let currentW = DEV ? 'geom' : LOCKED.wsource;   // weight source: 'geom' | 'comsol' (locked in the export)
let MODEL = null;

async function refreshProblem() {
  setStatus('Updating problem…');
  try {
    const p = (await pipeline.get_problem.callPromising(currentKind, currentOrder(), currentW, currentC())).toJs();
    p.status = 'idle';
    render(p);   // BEFORE + non-QAOA now; AFTER/QAOA show "press ▶ Run"
    setStatus('Settings changed — press ▶ Run to run QAOA.');
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e}`);
  }
}

let problemTimer = null;
function scheduleProblem(immediate) {
  clearTimeout(problemTimer);
  if (immediate) refreshProblem();
  else problemTimer = setTimeout(refreshProblem, 350);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function randomOrder() {
  try {
    const r = (await pipeline.random_order.callPromising(currentKind)).toJs();
    const el = orderEl();
    if (el) el.value = r.order.join(',');
    scheduleProblem(true);
  } catch (e) { console.error(e); setStatus(`Error: ${e}`); }
}

const orderEl = () => document.getElementById('order');
const currentOrder = () => {
  const el = orderEl();
  const v = el ? el.value.trim() : '';
  return v || null;   // comma-separated ADC->FPGA order, or null = default
};

const cmultEl = () => document.getElementById('cmult');
const currentC = () => {
  if (!DEV) return LOCKED.cmult;                 // locked in the export
  const el = cmultEl();
  const v = el ? Number(el.value) : 1;
  return Number.isFinite(v) && v > 0 ? v : 1;   // conflict-penalty multiplier
};

const repsEl = () => document.getElementById('reps');
const currentP = () => {
  if (!DEV) return LOCKED.reps;                  // locked in the export (depth 5)
  const el = repsEl();
  const v = el ? Number(el.value) : 3;
  return Number.isInteger(v) && v >= 1 ? v : 3;  // QAOA depth (reps)
};

// Dev-only: recommended (p, M) per problem from the sweeps (notebook 9-10).
// 25q is experimental: reps=1 and a capped COBYLA (dense 2^25 statevector).
const PRESETS = {
  '1adc': { reps: 3, cmult: 1 },
  '2adc': { reps: 3, cmult: 5 },
  '25': { reps: 1, cmult: 5 },
  'syn9': { reps: 3, cmult: 5, model: 'reduced' },
  'syn18': { reps: 3, cmult: 5, model: 'reduced' },
  'synv': { reps: 3, cmult: 5, model: 'reduced' },
};

function applyPreset(kind) {
  if (!DEV) return;   // the export uses the locked values, not the presets
  const pre = PRESETS[kind] || PRESETS['1adc'];
  const r = repsEl(); if (r) r.value = String(pre.reps);
  const c = cmultEl(); if (c) c.value = String(pre.cmult);
  if (pre.model) {
    currentModel = pre.model;
    modelTabs.forEach((x) => x.classList.toggle('active', x.dataset.model === currentModel));
  }
}

function reportOrder() {
  const el = orderEl();
  const st = document.getElementById('order-status');
  if (!el || !st || !MODEL) return;
  const applied = (MODEL.out_order || []).join(',');
  const req = el.value.trim();
  if (!req) { el.value = applied; st.textContent = ''; return; }
  const parts = req.split(',').map((s) => s.trim()).filter(Boolean);
  const same = parts.length === (MODEL.out_order || []).length
    && parts.every((p, i) => p === MODEL.out_order[i]);
  st.textContent = same ? '' : 'not 2-colorable → using default';
}

async function runPipeline() {
  const hasBackend = hasBackendNow();
  setStatus('Building problem…');
  const problem = (await pipeline.get_problem.callPromising(currentKind, currentOrder(), currentW, currentC())).toJs();
  problem.status = 'running';
  render(problem);   // fast: BEFORE + non-QAOA charts; AFTER & QAOA = Running
  setStatus('Running QAOA… this may take a few seconds (18 qubits is slower).');

  const model = (await pipeline.get_model.callPromising(currentKind, null, currentOrder(), currentW, currentC(), currentP(), currentModel)).toJs();

  if (hasBackend) {
    setStatus('Optimized locally. Sending 1 QAOA circuit to the selected backend…');
    try {
      const q = (await pipeline.run_backend.callPromising(
        backend, SHOTS, currentP(), 150, currentKind, null, currentOrder(), currentW, currentC())).toJs();
      const over = q.derived;
      model.ideal_distribution = model.distribution;
      model.distribution = over.distribution;
      model.distribution_source = over.distribution_source;
      model.costs.after = over.costs_after;
      model.assignments.after = over.assignments_after;
      model.assignments.after_layers = over.assignments_after_layers;
      model.tvd = over.tvd;
      model.success_ideal = over.success_ideal;
      model.success_backend = over.success_backend;
      model.valid_ideal = over.valid_ideal;
      model.valid_backend = over.valid_backend;
      model.measured_energy = over.measured_energy;
      // QAOA timing: local optimization + circuit execution on the backend
      const qrow = (model.benchmark && Array.isArray(model.benchmark.methods))
        ? model.benchmark.methods.find((m) => m.id === 'qaoa') : null;
      if (qrow) {
        if (q.opt_ms != null) qrow.time_opt_ms = q.opt_ms;
        qrow.time_exec_ms = (q.exec_ms != null) ? q.exec_ms : null;
        qrow.time_ms = (qrow.time_opt_ms || 0) + (qrow.time_exec_ms || 0);
      }
      render(model);
      renderBackend(q, model);
      setStatus(`Done · job ran on ${q.backend_name || 'the backend'} (${q.shots} shots, 1 job) · charts from that backend.`);
    } catch (errJob) {
      console.error(errJob);
      render(model);
      setQpu(`<p class="qpu-line" style="color:#ff6b6b">QPU run did not complete: ${String(errJob)}</p>
        <p class="note">The local QAOA result above is unaffected. If you picked IonQ, it must be
        online and Qollab allows one job per run. A <code>401</code> is the platform's IonQ key
        (report it via Share feedback); a <code>Failed to fetch</code> is the sandbox blocking
        the request.</p>`);
      setStatus(`Local QAOA ready · QPU run did not complete: ${errJob}`);
    }
  } else {
    render(model);
    setQpu(`<p class="note">No backend in this environment (local preview). In Qollab,
      open <strong>Select QPU</strong> and press ▶ Run to send one QAOA circuit.</p>`);
    const opt = model.exact && model.exact.cost != null ? ` (optimal ${Number(model.exact.cost).toFixed(3)})` : '';
    setStatus(`Local QAOA ready · ${model.meta.num_qubits} qubits · p=${model.meta.reps} · cost ${Number(model.costs.after.total).toFixed(3)}${opt}`);
  }
  MODEL = model;
  reportOrder();
  return model;
}

// --- controls ---------------------------------------------------------------

const problemTabs = Array.from(document.querySelectorAll('.problem-tab'));
problemTabs.forEach((b) => {
  b.onclick = () => {
    if (b.dataset.problem === currentKind) return;
    currentKind = b.dataset.problem;
    problemTabs.forEach((x) => x.classList.toggle('active', x === b));
    const el = orderEl();
    if (el) el.value = '';   // new problem -> default order
    applyPreset(currentKind);  // recommended (p, conflict weight) for this problem
    scheduleProblem(true);
  };
});

const modelTabs = Array.from(document.querySelectorAll('.model-tab'));
modelTabs.forEach((b) => {
  b.onclick = () => {
    if (b.dataset.model === currentModel) return;
    currentModel = b.dataset.model;
    modelTabs.forEach((x) => x.classList.toggle('active', x === b));
    setStatus('Model changed — press ▶ Run to run QAOA.');
  };
});

const wTabs = Array.from(document.querySelectorAll('.w-tab'));
wTabs.forEach((b) => {
  b.onclick = () => {
    if (!DEV) return;   // weights are locked to COMSOL in the export
    if (b.dataset.w === currentW) return;
    currentW = b.dataset.w;
    wTabs.forEach((x) => x.classList.toggle('active', x === b));
    scheduleProblem(true);
  };
});

{
  const el = orderEl();
  if (el) { el.oninput = () => scheduleProblem(false); el.onchange = () => scheduleProblem(true); }
  const cm = cmultEl();
  if (cm) cm.onchange = () => scheduleProblem(true);
  const reset = document.getElementById('order-reset');
  if (reset) reset.onclick = () => { const el2 = orderEl(); if (el2) el2.value = ''; scheduleProblem(true); };
  const rnd = document.getElementById('random');
  if (rnd) rnd.onclick = randomOrder;
  const run = document.getElementById('run');
  if (run) run.onclick = async () => {
    try { await runPipeline(); }
    catch (e) { console.error(e); setStatus(`Error: ${e}`); }
  };
}

// --- connections editor -----------------------------------------------------

let connNets = [];
let connOrder = [];

function parseOrderList(value, nets) {
  if (!value) return null;
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === nets.length && new Set(parts).size === nets.length
      && parts.every((p) => nets.includes(p))) return parts;
  return null;
}

function renderConnPreview() {
  const el = document.getElementById('conn-preview');
  if (el) el.innerHTML = routingPreview(connNets, connOrder);
}

function reorderConn(from, to) {
  if (from === to || from < 0 || to < 0 || from >= connOrder.length) return;
  const [x] = connOrder.splice(from, 1);
  connOrder.splice(to, 0, x);
  renderConnList();
  renderConnPreview();
}

function moveConn(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= connOrder.length) return;
  reorderConn(i, j);
}

function renderConnList() {
  const el = document.getElementById('conn-list');
  if (!el) return;
  el.innerHTML = '';
  connOrder.forEach((nn, i) => {
    const li = document.createElement('li');
    li.className = 'conn-item';
    li.draggable = true;
    li.innerHTML = `<span class="conn-handle">⠿</span><span class="conn-name">${nn}</span>`
      + `<span class="conn-move"><button class="tg mini" data-dir="-1" type="button">▲</button>`
      + `<button class="tg mini" data-dir="1" type="button">▼</button></span>`;
    li.querySelectorAll('.conn-move button').forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); moveConn(i, Number(b.dataset.dir)); };
    });
    li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => { e.preventDefault(); reorderConn(Number(e.dataTransfer.getData('text/plain')), i); });
    el.appendChild(li);
  });
  const hint = document.getElementById('conn-hint');
  if (hint) hint.textContent = `${connOrder.length} nets`;
}

async function openConnections() {
  let nets, order;
  try {
    if (MODEL && MODEL.nets && MODEL.nets.length) {
      nets = MODEL.nets.slice();
      order = parseOrderList(currentOrder(), nets) || MODEL.out_order || nets.slice();
    } else {
      setStatus('Loading problem…');
      const p = (await pipeline.get_problem.callPromising(currentKind, null, currentW, currentC())).toJs();
      nets = p.nets.slice();
      order = parseOrderList(currentOrder(), nets) || p.out_order || nets.slice();
    }
  } catch (e) { console.error(e); setStatus(`Error: ${e}`); return; }

  connNets = nets;
  connOrder = order.filter((nn) => nets.includes(nn));
  if (connOrder.length !== nets.length) connOrder = nets.slice();

  renderConnList();
  renderConnPreview();
  const modal = document.getElementById('conn-modal');
  if (modal) modal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeConnections() {
  const modal = document.getElementById('conn-modal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function applyConnections() {
  const el = orderEl();
  if (el) el.value = connOrder.join(',');
  closeConnections();
  scheduleProblem(true);
}

{
  const btn = document.getElementById('connections');
  if (btn) btn.onclick = openConnections;
  const c = document.getElementById('conn-close'); if (c) c.onclick = closeConnections;
  const ca = document.getElementById('conn-cancel'); if (ca) ca.onclick = closeConnections;
  const ap = document.getElementById('conn-apply'); if (ap) ap.onclick = applyConnections;
  const rs = document.getElementById('conn-reset');
  if (rs) rs.onclick = () => { connOrder = connNets.slice(); renderConnList(); renderConnPreview(); };
  const rd = document.getElementById('conn-random');
  if (rd) rd.onclick = async () => {
    try {
      const r = (await pipeline.random_order.callPromising(currentKind)).toJs();
      connOrder = r.order.filter((nn) => connNets.includes(nn));
      if (connOrder.length !== connNets.length) connOrder = connNets.slice();
      renderConnList();
      renderConnPreview();
    } catch (e) { console.error(e); }
  };
  const modal = document.getElementById('conn-modal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeConnections(); });
  document.addEventListener('keydown', (e) => {
    const m = document.getElementById('conn-modal');
    if (e.key === 'Escape' && m && !m.hidden) closeConnections();
  });
}

// --- bootstrap --------------------------------------------------------------

(async () => {
  problemTabs.forEach((x) => x.classList.toggle('active', x.dataset.problem === currentKind));
  modelTabs.forEach((x) => x.classList.toggle('active', x.dataset.model === currentModel));
  wTabs.forEach((x) => x.classList.toggle('active', x.dataset.w === currentW));

  // In the export the tuning knobs are locked: hide them (dev preview keeps them).
  if (!DEV) document.querySelectorAll('.dev-only').forEach((el) => { el.hidden = true; });
  applyPreset(currentKind);   // dev only; no-op in the export

  let backendLabel = 'none (local preview)';
  try {
    if (hasBackendNow()) {
      const n = backend && backend.name;
      backendLabel = String(typeof n === 'function' ? n() : (n ?? 'backend'));
    }
  } catch (e) { backendLabel = 'backend'; }

  // Banner in the Qollab console (like the reference project).
  console.log(
    `QuietTracE ready · ${TEAM} · quantum layer assignment for an ADC–FPGA PCB (QAOA) · ` +
    `p=${currentP()} · weights=${currentW()} · conflict x${currentC()} · backend ${backendLabel}`
  );

  setStatus('Choose the problem and connections, then press ▶ Run.');
})();

// Keep the run alive: Qollab tears down the runtime (and its authenticated backend)
// as soon as the top-level script finishes, so a job submitted later — from the ▶ Run
// button — would run outside the run and fail. Holding the run open keeps Python and
// `backend` available until the user presses Stop, exactly as the Qollab docs imply.
// (Same trick as the Optogenetic Quantum Brain project.)
await new Promise(() => {});

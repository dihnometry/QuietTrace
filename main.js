// QuietTracE — JS entry point (Qollab, and the local dev server via a shim).
//
// Problem (1 ADC / 2 ADC) and the ADC->FPGA connection order are chosen in the UI.
// The pipeline always optimizes locally; if Qollab injects `backend`, ONE QAOA
// circuit is sent and the charts use that backend's counts.

import * as pipeline from 'quantum.pipeline'; // Pyodide in Qollab; shim locally
import { render, renderBackend, renderCircuit, routingPreview } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };
const setQpu = (html) => { const el = document.getElementById('qpu'); if (el) el.innerHTML = html; };
const hasBackendNow = () => (typeof backend !== 'undefined') && !!backend;

const SHOTS = 1024;

function backendName() {
  try {
    const n = backend && backend.name;
    if (n == null) return '';
    return String(typeof n === 'function' ? n() : n);
  } catch (e) { return ''; }
}

function safeJobId(job) {
  try {
    const jid = job && job.job_id ? job.job_id() : null;
    return jid == null ? '' : String(jid);
  } catch (e) { return ''; }
}

// Build the QAOA circuit in JS (Qiskit in the browser) from the gate list that
// Python returned. Running the job from JS is REQUIRED on Qollab: the remote
// (IonQ) backends cannot be reached from Python (the sandbox blocks the POST).
async function buildCircuit(cd) {
  const { QuantumCircuit } = await import('qiskit');
  const info = cd.info || {};
  const qc = QuantumCircuit(info.num_qubits, info.num_clbits);
  for (const g of cd.gates || []) {
    const q = g.q || []; const c = g.c || []; const p = g.p || [];
    switch (g.g) {
      case 'barrier': qc.barrier(); break;
      case 'h': qc.h(q[0]); break;
      case 'x': qc.x(q[0]); break;
      case 'y': qc.y(q[0]); break;
      case 'z': qc.z(q[0]); break;
      case 'ry': qc.ry(p[0], q[0]); break;
      case 'rx': qc.rx(p[0], q[0]); break;
      case 'rz': qc.rz(p[0], q[0]); break;
      case 'rzz': qc.rzz(p[0], q[0], q[1]); break;
      case 'cx': qc.cx(q[0], q[1]); break;
      case 'cz': qc.cz(q[0], q[1]); break;
      case 'measure': qc.measure(q[0], c[0]); break;
      default: break;   // ignore anything unexpected
    }
  }
  return qc;
}

// Send the circuit to the selected backend and return its counts.
async function runOnBackend(cd) {
  const bname = backendName();
  let qc = null;
  try {
    qc = await buildCircuit(cd);
  } catch (eBuild) {
    console.warn('JS circuit build failed; falling back to the Python run_backend path', eBuild);
  }
  if (qc) {
    const job = await backend.run(qc, { shots: SHOTS });
    const jobId = safeJobId(job);
    const counts = (await job.result()).get_counts().toJs();
    return { counts, job_id: jobId, backend_name: bname };
  }
  // Fallback (works on local simulators; IonQ still needs the JS path).
  const q = (await pipeline.run_backend.callPromising(
    backend, SHOTS, 3, 150, currentKind, null, currentOrder(), currentW)).toJs();
  return { counts: q.counts, job_id: q.job_id || '', backend_name: q.backend_name || bname };
}

const clamp = (v, lo, hi, dflt) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt;
};

let currentKind = '1adc';
let currentW = 'geom';   // weight source: 'geom' | 'comsol'
let MODEL = null;

async function refreshProblem() {
  setStatus('Updating problem…');
  try {
    const p = (await pipeline.get_problem.callPromising(currentKind, currentOrder(), currentW)).toJs();
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
  const problem = (await pipeline.get_problem.callPromising(currentKind, currentOrder(), currentW)).toJs();
  problem.status = 'running';
  render(problem);   // fast: BEFORE + non-QAOA charts; AFTER & QAOA = Running
  setStatus('Running QAOA… this may take a few seconds (18 qubits is slower).');

  const model = (await pipeline.get_model.callPromising(currentKind, null, currentOrder(), currentW)).toJs();

  // QAOA circuit diagram (independent of the backend): Python draws it, JS shows it.
  let cd = null;
  try {
    setStatus('Drawing the QAOA circuit…');
    cd = (await pipeline.qaoa_circuit.callPromising(currentKind, currentOrder(), currentW)).toJs();
    renderCircuit(cd);
  } catch (eDraw) {
    console.error('circuit diagram failed:', eDraw);
  }

  if (hasBackend) {
    setStatus('Optimized locally. Sending 1 QAOA circuit to the selected backend…');
    try {
      const res = await runOnBackend(cd);
      const over = (await pipeline.model_from_counts.callPromising(
        res.counts, currentKind, currentOrder(), currentW)).toJs();
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
      render(model);
      renderBackend({ counts: res.counts, shots: SHOTS, backend_name: res.backend_name,
        job_id: res.job_id, circuit: cd ? cd.info : null }, model);
      setStatus(`Done · job ran on ${res.backend_name || 'the backend'} (${SHOTS} shots, 1 job) · charts from that backend.`);
    } catch (errJob) {
      console.error(errJob);
      render(model);
      setQpu(`<p class="qpu-line" style="color:#ff6b6b">QPU run did not complete: ${String(errJob)}</p>
        <p class="note">The local QAOA result above is unaffected. The job is sent from JavaScript
        (required by Qollab for remote backends); if you picked IonQ, it must be online and
        Qollab allows one job per run.</p>`);
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
    scheduleProblem(true);
  };
});

const wTabs = Array.from(document.querySelectorAll('.w-tab'));
wTabs.forEach((b) => {
  b.onclick = () => {
    if (b.dataset.w === currentW) return;
    currentW = b.dataset.w;
    wTabs.forEach((x) => x.classList.toggle('active', x === b));
    scheduleProblem(true);
  };
});

{
  const el = orderEl();
  if (el) { el.oninput = () => scheduleProblem(false); el.onchange = () => scheduleProblem(true); }
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
      const p = (await pipeline.get_problem.callPromising(currentKind, null, currentW)).toJs();
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
  wTabs.forEach((x) => x.classList.toggle('active', x.dataset.w === currentW));
  setStatus('Choose the problem and connections, then press ▶ Run.');
})();

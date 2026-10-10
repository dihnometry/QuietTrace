// QuietTracE — JS entry point (Qollab, and the local dev server via a shim).
//
// Problem (1 ADC / 2 ADC) and the ADC->FPGA connection order are chosen in the UI.
// The pipeline always optimizes locally; if Qollab injects `backend`, ONE QAOA
// circuit is sent and the charts use that backend's counts.

import * as pipeline from 'quantum.pipeline'; // Pyodide in Qollab; shim locally
import { render, renderBackend, renderSampling } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };
const hasBackend = (typeof backend !== 'undefined') && !!backend;

const clamp = (v, lo, hi, dflt) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt;
};

let currentKind = '1adc';
let MODEL = null;

const shotsEl = () => document.getElementById('shots-num') || document.getElementById('shots-range');
const readShots = () => clamp(shotsEl() ? shotsEl().value : 1024, 0, 2000, 1024);

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
  setStatus('Running the pipeline (model + QAOA)… this may take a few seconds.');
  const model = (await pipeline.get_model.callPromising(currentKind, null, currentOrder())).toJs();

  if (hasBackend) {
    setStatus('Optimized locally. Sending 1 QAOA circuit to the selected backend…');
    try {
      const q = (await pipeline.run_backend.callPromising(
        backend, readShots(), 3, 150, currentKind, null, currentOrder())).toJs();
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
      render(model);
      renderBackend(q, model);
      setStatus(`Done · job ran on ${q.backend_name || 'the backend'} (${q.shots} shots, 1 job) · charts from that backend.`);
    } catch (errJob) {
      console.error(errJob);
      render(model);
      setStatus(`Local QAOA ready · QPU run did not complete: ${errJob}`);
    }
  } else {
    render(model);
    const opt = model.exact && model.exact.cost != null ? ` (optimal ${Number(model.exact.cost).toFixed(3)})` : '';
    setStatus(`Local QAOA ready · ${model.meta.num_qubits} qubits · p=${model.meta.reps} · cost ${Number(model.costs.after.total).toFixed(3)}${opt}`);
  }
  MODEL = model;
  reportOrder();
  return model;
}

async function resample() {
  if (!MODEL) return;
  try {
    const r = (await pipeline.resample_ideal.callPromising(readShots(), null, currentKind, null, currentOrder())).toJs();
    renderSampling(r, MODEL);
  } catch (e) { console.error(e); }
}

// --- controls ---------------------------------------------------------------

const problemTabs = Array.from(document.querySelectorAll('.problem-tab'));
problemTabs.forEach((b) => {
  b.onclick = async () => {
    if (b.dataset.problem === currentKind) return;
    currentKind = b.dataset.problem;
    problemTabs.forEach((x) => x.classList.toggle('active', x === b));
    const el = orderEl();
    if (el) el.value = '';   // new problem -> default order
    try {
      await runPipeline();
      await resample();
    } catch (e) {
      console.error(e);
      setStatus(`Error switching problem: ${e}`);
    }
  };
});

let orderTimer = null;
function scheduleOrders(immediate) {
  clearTimeout(orderTimer);
  const go = async () => {
    try { await runPipeline(); await resample(); }
    catch (e) { console.error(e); setStatus(`Error: ${e}`); }
  };
  if (immediate) go(); else orderTimer = setTimeout(go, 400);
}
{
  const el = orderEl();
  if (el) {
    el.oninput = () => scheduleOrders(false);
    el.onchange = () => scheduleOrders(true);
  }
  const reset = document.getElementById('order-reset');
  if (reset) reset.onclick = () => { const el2 = orderEl(); if (el2) el2.value = ''; scheduleOrders(true); };
}

const shotsRange = document.getElementById('shots-range');
const shotsNum = document.getElementById('shots-num');
const shotsVal = document.getElementById('shots-val');
let shotsTimer = null;
function setShots(v, immediate) {
  const s = clamp(v, 0, 2000, 1024);
  if (shotsRange) shotsRange.value = String(s);
  if (shotsNum) shotsNum.value = String(s);
  if (shotsVal) shotsVal.textContent = `${s} shots`;
  clearTimeout(shotsTimer);
  if (immediate) resample(); else shotsTimer = setTimeout(resample, 180);
}
if (shotsRange) shotsRange.oninput = () => setShots(shotsRange.value);
if (shotsNum) shotsNum.onchange = () => setShots(shotsNum.value, true);

// --- bootstrap --------------------------------------------------------------

(async () => {
  try {
    problemTabs.forEach((x) => x.classList.toggle('active', x.dataset.problem === currentKind));
    if (shotsVal) shotsVal.textContent = `${readShots()} shots`;
    await runPipeline();
    await resample();
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e}. ¿Arrancaste scripts/dev.sh con un Python con qiskit/scipy/numpy?`);
  }
})();

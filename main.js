// QuietTracE — JS entry point (Qollab).
//
// Problem (1 ADC / 2 ADC) and initial state are chosen in the UI. The pipeline
// always optimizes locally; if Qollab injects `backend`, ONE QAOA circuit is sent
// and the charts use that backend's counts.

import * as pipeline from 'quantum.pipeline'; // -> quantum/pipeline.py
import { render, renderBackend, renderSampling } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };
const hasBackend = (typeof backend !== 'undefined') && !!backend;

const clamp = (v, lo, hi, dflt) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt;
};

let currentKind = '1adc';
let currentInit = 90;   // degrees; 90 = |+> (Hadamard)
let MODEL = null;

const shotsEl = () => document.getElementById('shots-num') || document.getElementById('shots-range');
const readShots = () => clamp(shotsEl() ? shotsEl().value : 1024, 0, 2000, 1024);

async function runPipeline() {
  setStatus('Running the pipeline (model + QAOA)… this may take a few seconds.');
  const model = (await pipeline.get_model.callPromising(currentKind, currentInit)).toJs();

  if (hasBackend) {
    setStatus('Optimized locally. Sending 1 QAOA circuit to the selected backend…');
    try {
      const q = (await pipeline.run_backend.callPromising(
        backend, readShots(), 3, 150, currentKind, currentInit)).toJs();
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
  window.__qt_model = model;
  return model;
}

async function resample() {
  if (!MODEL) return;
  try {
    const r = (await pipeline.resample_ideal.callPromising(readShots(), null, currentKind, currentInit)).toJs();
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
    await runPipeline();
    await resample();
  };
});

const initRange = document.getElementById('init-range');
const initNum = document.getElementById('init-num');
const initVal = document.getElementById('init-val');
let initTimer = null;
function syncInit() {
  if (initRange) initRange.value = String(currentInit);
  if (initNum) initNum.value = String(currentInit);
  if (initVal) initVal.textContent = currentInit === 90 ? '90° (= |+⟩)' : `${currentInit}°`;
}
function setInit(v, immediate) {
  currentInit = clamp(v, 0, 180, 90);
  syncInit();
  clearTimeout(initTimer);
  const go = async () => { await runPipeline(); await resample(); };
  if (immediate) go(); else initTimer = setTimeout(go, 250);
}
if (initRange) initRange.oninput = () => setInit(initRange.value);
if (initNum) initNum.onchange = () => setInit(initNum.value, true);

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
  problemTabs.forEach((x) => x.classList.toggle('active', x.dataset.problem === currentKind));
  syncInit();
  if (shotsVal) shotsVal.textContent = `${readShots()} shots`;
  await runPipeline();
  await resample();
})();

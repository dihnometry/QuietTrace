// QuietTracE — JS entry point (Qollab).
//
// 1) Optimizes locally (model + QAOA). 2) If Qollab injects `backend`, it sends
// ONE QAOA circuit and waits for the result BEFORE painting (the local view is
// not shown); charts then come from that backend. Otherwise it paints locally.

import * as pipeline from 'quantum.pipeline'; // -> quantum/pipeline.py
import { render, renderBackend, renderSampling } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };

const hasBackend = (typeof backend !== 'undefined') && !!backend;

setStatus('Preparing the pipeline (model + QAOA)…');

try {
  const model = (await pipeline.get_model.callPromising()).toJs();
  console.log('QuietTracE · pipeline', JSON.stringify(model.meta));

  if (hasBackend) {
    // No local view: wait for the backend, then paint from its result.
    setStatus('Optimized locally. Sending 1 QAOA circuit to the selected backend…');
    try {
      const q = (await pipeline.run_backend.callPromising(backend, 1024)).toJs();
      const over = q.derived;

      model.ideal_distribution = model.distribution;   // keep ideal to compare
      model.distribution = over.distribution;
      model.distribution_source = over.distribution_source;
      model.costs.after = over.costs_after;
      model.assignments.after = over.assignments_after;
      model.assignments.after_layers = over.assignments_after_layers;
      // comparison metrics (ideal vs backend)
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
      render(model);  // fall back to the local view if the job failed
      setStatus(`Local QAOA ready · QPU run did not complete: ${errJob}`);
    }
  } else {
    render(model);
    setStatus(
      model.source === 'qaoa'
        ? `Local QAOA ready · ${model.meta.num_qubits} qubits · p=${model.meta.reps} · `
          + `cost ${Number(model.costs.after.total).toFixed(3)} (optimal ${Number(model.exact.cost).toFixed(3)})`
        : 'Model ready.'
    );
  }

  // Local sampling control (ideal resample; no QPU job).
  const rangeEl = document.getElementById('shots-range');
  const numEl = document.getElementById('shots-num');
  const shotsVal = document.getElementById('shots-val');
  if (rangeEl || numEl) {
    const clamp = (v) => Math.max(0, Math.min(2000, Math.round(Number(v) || 0)));
    let timer = null;
    const runSample = async (s) => {
      try {
        const r = (await pipeline.resample_ideal.callPromising(s)).toJs();
        renderSampling(r, model);
      } catch (e) { console.error(e); }
    };
    const apply = (v, immediate) => {
      const s = clamp(v);
      if (rangeEl) rangeEl.value = String(s);
      if (numEl) numEl.value = String(s);
      if (shotsVal) shotsVal.textContent = `${s} shots`;
      clearTimeout(timer);
      if (immediate) runSample(s);
      else timer = setTimeout(() => runSample(s), 180);
    };
    if (rangeEl) rangeEl.oninput = () => apply(rangeEl.value);
    if (numEl) numEl.onchange = () => apply(numEl.value, true);
    await apply(rangeEl ? rangeEl.value : 1024, true);
  }
} catch (err) {
  setStatus(`Pipeline error: ${err}`);
  console.error(err);
}

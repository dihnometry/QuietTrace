// QuietTracE — JS entry point (Qollab).
//
// 1) Optimizes locally: model (quantum/modelo.py) + QAOA (quantum/fastqaoa.py).
// 2) Renders the result with engine.js.
// 3) If Qollab injects `backend` (the one chosen in Select QPU), sends ONE final
//    QAOA circuit to it and renders the measured counts (one job per run).

import * as pipeline from 'quantum.pipeline'; // -> quantum/pipeline.py
import { render, renderBackend } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };

setStatus('Running the pipeline (model + QAOA)… this may take a few seconds.');

try {
  const model = (await pipeline.get_model.callPromising()).toJs();
  render(model);

  setStatus(
    model.source === 'qaoa'
      ? `Local QAOA ready · ${model.meta.num_qubits} qubits · p=${model.meta.reps} · `
        + `cost ${Number(model.costs.after.total).toFixed(3)} (optimal ${Number(model.exact.cost).toFixed(3)}) · `
        + `gap ${(Number(model.meta.approx_gap) * 100).toFixed(1)}%`
      : 'Model ready.'
  );
  console.log('QuietTracE · pipeline', JSON.stringify(model.meta));

  if (typeof backend !== 'undefined' && backend) {
    setStatus('Local optimization done. Sending 1 QAOA circuit to the selected backend…');
    try {
      const q = (await pipeline.run_backend.callPromising(backend, 1024)).toJs();
      renderBackend(q, model);
      setStatus(`Local QAOA ready · job ran on ${q.backend_name || 'the backend'} (${q.shots} shots, 1 job).`);
    } catch (errJob) {
      console.error(errJob);
      setStatus(`Local QAOA ready · QPU run did not complete: ${errJob}`);
    }
  } else {
    setStatus('Local QAOA ready · (no backend injected: local preview).');
  }
} catch (err) {
  setStatus(`Pipeline error: ${err}`);
  console.error(err);
}

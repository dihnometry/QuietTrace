// QuietTracE — punto de entrada JS (Qollab).
//
// 1) Optimiza localmente: modelo (quantum/modelo.py) + QAOA (quantum/fastqaoa.py).
// 2) Dibuja el resultado con engine.js.
// 3) Si Qollab inyecta `backend` (el elegido en Select QPU), envía UN circuito
//    QAOA final al backend y dibuja los conteos medidos (un solo job por run).

import * as pipeline from 'quantum.pipeline'; // -> quantum/pipeline.py
import { render, renderBackend } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };

setStatus('Ejecutando el pipeline (modelo + QAOA)… puede tardar unos segundos.');

try {
  const model = (await pipeline.get_model.callPromising()).toJs();
  render(model);

  setStatus(
    model.source === 'qaoa'
      ? `QAOA local listo · ${model.meta.num_qubits} qubits · p=${model.meta.reps} · `
        + `costo ${Number(model.costs.after.total).toFixed(3)} (óptimo ${Number(model.exact.cost).toFixed(3)}) · `
        + `gap ${(Number(model.meta.approx_gap) * 100).toFixed(1)}%`
      : 'Modelo listo.'
  );
  console.log('QuietTracE · pipeline', JSON.stringify(model.meta));

  // Ejecución en el backend elegido en Qollab.
  if (typeof backend !== 'undefined' && backend) {
    setStatus('Optimización local lista. Enviando 1 circuito QAOA al backend seleccionado…');
    try {
      const q = (await pipeline.run_backend.callPromising(backend, 1024)).toJs();
      renderBackend(q, model);
      setStatus(`QAOA local OK · job ejecutado en ${q.backend_name || 'el backend'} (${q.shots} shots, 1 job).`);
    } catch (errJob) {
      console.error(errJob);
      setStatus(`QAOA local OK · la ejecución en QPU no completó: ${errJob}`);
    }
  } else {
    setStatus('QAOA local OK · (sin backend inyectado: vista local).');
  }
} catch (err) {
  setStatus(`Error en el pipeline: ${err}`);
  console.error(err);
}

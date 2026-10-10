// QuietTracE — punto de entrada JS (Qollab).
//
// Corre el pipeline real: modelo (quantum/modelo.py) + QAOA (quantum/fastqaoa.py)
// y dibuja el resultado con engine.js. `backend` no se usa (optimización local
// con statevector); no se envían jobs ni se gastan créditos.

import * as pipeline from 'quantum.pipeline'; // -> quantum/pipeline.py
import { render } from './engine.js';

const status = document.getElementById('status');
const setStatus = (t) => { if (status) status.textContent = t; };

setStatus('Ejecutando el pipeline (modelo + QAOA)… puede tardar unos segundos.');

try {
  const model = (await pipeline.get_model.callPromising()).toJs();
  render(model);

  setStatus(
    model.source === 'qaoa'
      ? `QAOA listo · ${model.meta.num_qubits} qubits · p=${model.meta.reps} · `
        + `costo ${Number(model.costs.after.total).toFixed(3)} (óptimo ${Number(model.exact.cost).toFixed(3)}) · `
        + `gap ${(Number(model.meta.approx_gap) * 100).toFixed(1)}%`
      : 'Modelo listo.'
  );
  console.log('QuietTracE · pipeline', JSON.stringify(model.meta));
} catch (err) {
  setStatus(`Error en el pipeline: ${err}`);
  console.error(err);
}

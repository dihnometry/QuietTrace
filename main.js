// QuietTracE — punto de entrada JS.
//
// `backend` es inyectado por Qollab (elegido en el diálogo Select QPU).
// NO crear ni hardcodear backends, proveedores o API keys.
//
// El trabajo cuántico vive en Python (quantum/bell.py) y se llama con
// `.callPromising` — necesario en IonQ, seguro en todos los backends.

import * as bell from 'quantum.bell'; // -> quantum/bell.py

const SHOTS = 1024;

const output = document.getElementById('counts');

try {
  // Un solo job por run: en IonQ solo se admite un backend.run por ejecución.
  const counts = (await bell.run_bell.callPromising(backend, SHOTS)).toJs();

  output.textContent = JSON.stringify(counts, null, 2);
  console.log('counts', JSON.stringify(counts));
} catch (error) {
  output.textContent = `Error: ${error}`;
  console.error(error);
}

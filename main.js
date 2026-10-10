// QuietTracE — punto de entrada JS (Qollab).
//
// `backend` existe (Qollab lo inyecta) pero este motor solo visualiza: NO envía
// jobs ni gasta créditos. La optimización QUBO/Ising/QAOA la hace el equipo de
// física; aquí solo se pintan datos mock.
//
// El modelo lo genera el módulo Python `quantum/pcb.py` y lo dibuja `engine.js`.

import * as pcb from 'quantum.pcb'; // -> quantum/pcb.py
import { render } from './engine.js';

// `.callPromising` es la forma correcta de llamar funciones Python propias (y
// obligatoria en IonQ). `.toJs()` convierte el dict de Python a datos JS.
const model = (await pcb.get_model.callPromising()).toJs();

render(model);
console.log('QuietTracE · modelo mock', JSON.stringify(model.meta));

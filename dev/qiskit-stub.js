// Local preview stub for Qollab's `qiskit` module.
//
// `main.js` does a STATIC `import { QuantumCircuit } from 'qiskit'` (the form the
// Qollab docs use). In the local preview there is no Qiskit, so this stub keeps
// the module loadable. It is never actually used: the local preview has no
// `backend`, so the QPU path (which builds and runs the circuit) is skipped.

export class QuantumCircuit {
  constructor() {
    throw new Error('qiskit stub: QuantumCircuit is only available in Qollab');
  }
}

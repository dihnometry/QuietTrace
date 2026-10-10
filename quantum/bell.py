"""Núcleo cuántico de QuietTracE (Python / Qiskit).

Este módulo recibe el `backend` pre-creado por Qollab y devuelve datos planos
que `main.js` puede consumir con `.toJs()`.

Reglas del contrato (AGENTS.md):
- No crear backends ni proveedores: usar el `backend` recibido.
- Un solo `backend.run` por run cuando el backend sea IonQ.
- Sin estado persistente.
"""

from qiskit import QuantumCircuit

DEFAULT_SHOTS = 1024


def run_bell(backend, shots: int = DEFAULT_SHOTS) -> dict:
    """Prepara un estado de Bell y devuelve los conteos de medición."""
    circuit = QuantumCircuit(2, 2)
    circuit.h(0)
    circuit.cx(0, 1)
    circuit.measure([0, 1], [0, 1])

    job = backend.run(circuit, shots=shots)
    return job.result().get_counts()

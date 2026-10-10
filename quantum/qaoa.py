"""QAOA de QuietTracE.

Movido desde `main.py` (misma estructura y mismas llamadas) y generalizado:

  - el operador de costo se construye a partir de las matrices J, h del modelo
    (`quantum/modelo.py`) en lugar de la matriz de ejemplo de 4 qubits;
  - N (número de qubits) es el del modelo (9), no fijo en 4;
  - `reps` y `maxiter` son parámetros.

Los imports de qiskit/scipy se hacen DENTRO de las funciones para no ralentizar
la carga de la página (importar qiskit en Pyodide tarda varios segundos).
"""

import numpy as np


def cost_operator(J, h):
    """Operador de Ising  H = sum_{i<j} J_ij Z_i Z_j + sum_i h_i Z_i."""
    from qiskit.quantum_info import SparsePauliOp

    n = len(h)
    pauli_list = []
    for i in range(n):
        for j in range(i + 1, n):
            if abs(J[i][j]) > 1e-12:
                pauli_list.append(("ZZ", [i, j], float(J[i][j])))
    for i in range(n):
        if abs(h[i]) > 1e-12:
            pauli_list.append(("Z", [i], float(h[i])))
    return SparsePauliOp.from_sparse_list(pauli_list, num_qubits=n)


def run_qaoa(J, h, reps=3, maxiter=150, theta0_value=0.5):
    """Corre QAOA (QAOAAnsatz + Statevector + COBYLA) y devuelve resultados.

    Réplica de `main.py`:
        M_cost = SparsePauliOp...
        ansatz = QAOAAnsatz(cost_operator=M_cost, reps=reps)
        energy(theta) -> Statevector.from_instruction(...).expectation_value(M_cost)
        minimize(energy, theta0, method="COBYLA", ...)
    """
    from qiskit.circuit.library import QAOAAnsatz
    from qiskit.quantum_info import Statevector
    from scipy.optimize import minimize

    J = np.asarray(J, dtype=float)
    h = np.asarray(h, dtype=float)

    M_cost = cost_operator(J, h)

    ansatz = QAOAAnsatz(cost_operator=M_cost, reps=reps)
    parameters = list(ansatz.parameters)

    history = []

    def energy(theta):
        values = dict(zip(parameters, theta))
        circuit = ansatz.assign_parameters(values)
        psi = Statevector.from_instruction(circuit)
        val = float(np.real(psi.expectation_value(M_cost)))
        history.append(val)
        return val

    theta0 = np.full(ansatz.num_parameters, theta0_value)
    result = minimize(energy, theta0, method="COBYLA", options={"maxiter": maxiter})

    # distribución final sobre los 2**N bitstrings
    bound = ansatz.assign_parameters(dict(zip(parameters, result.x)))
    psi = Statevector.from_instruction(bound)
    probs = np.real(psi.probabilities())

    return {
        "reps": reps,
        "num_qubits": int(len(h)),
        "num_parameters": int(ansatz.num_parameters),
        "energy": float(result.fun),
        "theta": [float(t) for t in result.x],
        "history": [float(v) for v in history],
        "probabilities": [float(p) for p in probs],
    }

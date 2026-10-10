"""QAOA exacto y rápido para QuietTracE (NumPy puro, sin Qiskit/Statevector).

Es un reemplazo 1:1 de `quantum/qaoa.py::run_qaoa`: mismo contrato de entrada y
la MISMA forma de salida (mismas claves), pero sin construir ni simular un
circuito de Qiskit. La evolución de la QAOA se evalúa directamente sobre el
vector de amplitudes de tamaño 2**n, que para n=9 (512 amplitudes) es trivial y
evita el coste por evaluación de `Statevector.from_instruction` en Pyodide.

Semántica replicada de `QAOAAnsatz` (Qiskit 2.5.2) como se usa en `qaoa.py`:

  - Convención de base: Z|0> = +|0>, Z|1> = -|1>. Para un índice computacional
    k en [0, 2**n): x_i = (k >> i) & 1 y s_i = 1 - 2*x_i.
  - Costo clásico por estado: C(k) = sum_{i<j} J_ij s_i s_j + sum_i h_i s_i.
    (La constante Ising global no entra: el operador de `qaoa.py` tampoco la
    incluye.)
  - Estado inicial |+>^n: psi = ones(2**n) / sqrt(2**n).
  - Por capa l: fase diagonal  psi *= exp(-1j * gamma_l * C),  seguida del
    mixer exp(-i * beta_l * sum_i X_i), que es producto de G(beta_l) por qubit
    con G(b) = [[cos b, -1j sin b], [-1j sin b, cos b]]  (equivale a RX(2b)).
  - Energía(theta) = real( sum_k |psi_k|^2 * C(k) ).
  - Optimizador idéntico: scipy COBYLA, theta0 = full(2*reps, theta0_value).

Orden de parámetros: `QAOAAnsatz` de Qiskit 2.5.2 expone primero las betas y
después las gammas -> ['beta[0]', ..., 'gamma[0]', ...]. Se replica ese orden
para que COBYLA recorra exactamente la misma trayectoria que en `qaoa.py`.
"""

import numpy as np


def _cost_vector(J, h):
    """Vector C(k) para todos los k en [0, 2**n) (precalculado una sola vez).

    La diagonal de J se ignora porque el operador de costo sólo incluye i < j.
    """
    J = np.asarray(J, dtype=float)
    h = np.asarray(h, dtype=float)
    n = len(h)

    # índice entero de cada estado base y sus bits (bit i = (k >> i) & 1)
    k = np.arange(1 << n, dtype=np.int64)
    x = ((k[:, None] >> np.arange(n)) & 1).astype(float)   # (2**n, n)
    s = 1.0 - 2.0 * x                                     # (+1 / -1)

    # sum_i h_i s_i
    cost = s @ h
    # sum_{i<j} J_ij s_i s_j = 0.5 * s^T J s  (J simétrica y sin diagonal)
    J_off = J.copy()
    np.fill_diagonal(J_off, 0.0)
    cost = cost + 0.5 * np.einsum("ki,ij,kj->k", s, J_off, s)
    return cost


def _apply_mixer(psi, beta, n):
    """Aplica exp(-i beta sum_i X_i) = producto de G(beta) sobre cada qubit."""
    c = np.cos(beta)
    m = -1j * np.sin(beta)
    psi = psi.reshape((2,) * n)
    for ax in range(n):
        psi = np.moveaxis(psi, ax, 0)
        a0 = psi[0].copy()
        a1 = psi[1].copy()
        # [[c, m], [m, c]] @ [a0, a1]
        psi[0] = c * a0 + m * a1
        psi[1] = m * a0 + c * a1
        psi = np.moveaxis(psi, 0, ax)
    return psi.reshape(-1)


def _statevector(theta, reps, cost, n):
    """Estado final |psi(theta)> tras las `reps` capas (betas primero)."""
    betas = theta[:reps]
    gammas = theta[reps:]
    size = 1 << n
    psi = np.full(size, 1.0 / np.sqrt(size), dtype=complex)
    for layer in range(reps):
        psi = psi * np.exp(-1j * gammas[layer] * cost)   # fase de costo
        psi = _apply_mixer(psi, betas[layer], n)         # mixer
    return psi


def run_qaoa(J, h, reps=3, maxiter=150, theta0_value=0.5):
    """Corre QAOA (costo Ising + mixer X) con NumPy puro y COBYLA.

    Devuelve el mismo dict y la misma forma que `quantum/qaoa.py::run_qaoa`.
    """
    # scipy se importa aquí para no pagar el coste de carga al abrir la página.
    from scipy.optimize import minimize

    J = np.asarray(J, dtype=float)
    h = np.asarray(h, dtype=float)
    n = len(h)

    cost = _cost_vector(J, h)   # precalculado una sola vez

    history = []
    argmax_history = []

    def energy(theta):
        psi = _statevector(theta, reps, cost, n)
        probs = np.abs(psi) ** 2
        val = float(np.real(np.sum(probs * cost)))
        history.append(val)
        argmax_history.append(int(np.argmax(probs)))
        return val

    num_parameters = 2 * reps
    theta0 = np.full(num_parameters, theta0_value)
    result = minimize(energy, theta0, method="COBYLA",
                      options={"maxiter": maxiter})

    # distribución final sobre los 2**n bitstrings
    psi = _statevector(result.x, reps, cost, n)
    probs = np.abs(psi) ** 2

    return {
        "reps": reps,
        "num_qubits": int(n),
        "num_parameters": int(num_parameters),
        "energy": float(result.fun),
        "theta": [float(t) for t in result.x],
        "history": [float(v) for v in history],
        "argmax_history": argmax_history,
        "probabilities": [float(p) for p in probs],
    }

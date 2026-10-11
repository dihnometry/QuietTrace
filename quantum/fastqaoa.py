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
  - Estado inicial |+>^n: psi = ones(2**n) / sqrt(2**n). Si se pasa `init`, el
    estado inicial es el producto ⊗_i Ry(init[i])|0>, con amplitud por bit
    cos(init[i]/2) si x_i=0 y sin(init[i]/2) si x_i=1. `init=None` equivale a
    `init=[π/2]*n` (Hadamard).
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


def _cost_vector(J, h, chunk=1 << 20):
    """Vector C(k) para todos los k en [0, 2**n) (precalculado una sola vez).

    Se calcula por TROZOS para no materializar la matriz (2**n, n) de bits: a
    n=25 (33.5M estados) esa matriz en float64 pediria ~6.25 GiB. La diagonal de
    J se ignora porque el operador de costo solo incluye i < j.
    """
    J = np.asarray(J, dtype=float)
    h = np.asarray(h, dtype=float)
    n = len(h)
    size = 1 << n

    J_off = J.copy()
    np.fill_diagonal(J_off, 0.0)

    cost = np.empty(size, dtype=float)
    bits = np.arange(n)
    for lo in range(0, size, chunk):
        hi = min(lo + chunk, size)
        k = np.arange(lo, hi, dtype=np.int64)
        s = 1.0 - 2.0 * ((k[:, None] >> bits) & 1).astype(float)   # (trozo, n)
        t = s @ J_off                                              # BLAS (trozo, n)
        cost[lo:hi] = s @ h + 0.5 * np.einsum("ki,ki->k", t, s)
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


def _initial_statevector(n, init):
    """Estado inicial ⊗_i Ry(init[i])|0>.

    `init=None` -> |+>^n = ones(2**n)/sqrt(2**n) (Hadamard sobre cada qubit).
    Para que `init=[π/2]*n` sea BIT-IDÉNTICO a `init=None` (Ry(π/2)|0> = |+>),
    el caso constante π/2 se normaliza a None.
    """
    size = 1 << n
    if init is not None:
        init = np.asarray(init, dtype=float)
        if init.shape != (n,):
            raise ValueError(f"init debe tener longitud n={n}, tiene {init.size}")
        if np.all(init == np.pi / 2.0):
            init = None
    if init is None:
        return np.full(size, 1.0 / np.sqrt(size), dtype=complex)

    k = np.arange(size, dtype=np.int64)
    x = (k[:, None] >> np.arange(n)) & 1                    # (size, n) bits 0/1
    amp = np.where(x == 0, np.cos(init / 2.0), np.sin(init / 2.0))
    return np.prod(amp, axis=1).astype(complex)


def _statevector(theta, reps, cost, n, init=None):
    """Estado final |psi(theta)> tras las `reps` capas (betas primero)."""
    betas = theta[:reps]
    gammas = theta[reps:]
    psi = _initial_statevector(n, init)
    for layer in range(reps):
        psi = psi * np.exp(-1j * gammas[layer] * cost)   # fase de costo
        psi = _apply_mixer(psi, betas[layer], n)         # mixer
    return psi


def run_qaoa(J, h, reps=3, maxiter=150, theta0_value=0.5, init=None):
    """Corre QAOA (costo Ising + mixer X) con NumPy puro y COBYLA.

    `init`: secuencia opcional de n ángulos (radianes) que fija el estado inicial
    como ⊗_i Ry(init[i])|0>. `init=None` (por defecto) mantiene el estado inicial
    |+>^n por Hadamard; `init=[π/2]*n` es equivalente.

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
        psi = _statevector(theta, reps, cost, n, init=init)
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
    psi = _statevector(result.x, reps, cost, n, init=init)
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

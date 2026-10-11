"""Reduccion exacta por componentes del grafo de conflictos (experimento).

Idea: las restricciones "estas dos pistas NO pueden compartir capa" son un XOR
(`x_i != x_j`). Si el grafo de conflictos es bipartito con `k` componentes
conexas, TODAS las asignaciones factibles son las 2**k coloraciones (una por
componente, eligiendo su orientacion). Entonces basta **una variable binaria por
componente** `y_c` en vez de una por pista `x_i`:

    x_i = base_i XOR y_{comp(i)}          (base = una coloracion de referencia)

Ventajas:
  - k qubits en vez de n (k = componentes, no pistas).
  - NO hacen falta penalizaciones por conflicto: el espacio reducido ya es
    factible por construccion.
  - Se conservan los pesos de acoplamiento (p. ej. COMSOL) y el coste de vias,
    reexpresados en funcion de las y.

Coste reducido (para k pequeno se evalua sobre los 2**k estados):
    C_red(y) = acoplamiento(x) + coste_vias(x)     (sin termino de conflicto)
"""

from __future__ import annotations

import numpy as np

from . import classical as C
from . import fastqaoa as fq


def reduce_problem(prob):
    """(base, groups, comp_of, k): coloracion de referencia, componentes y mapa pista->componente."""
    n = len(prob["nets"])
    conflicts = prob["conflicts"]
    base = C.feasible_coloring(n, conflicts)
    groups = C.components(n, conflicts)
    comp_of = np.empty(n, dtype=int)
    for ci, g in enumerate(groups):
        comp_of[g] = ci
    return base, groups, comp_of, len(groups)


def x_from_y(base, comp_of, y):
    """Reconstruye la asignacion por pista x a partir de las variables de componente y."""
    y = np.asarray(y, dtype=np.int8)
    return np.array([int(base[i]) ^ int(y[comp_of[i]]) for i in range(len(base))], dtype=np.int8)


def reduced_cost_vector(prob, base, comp_of, k, chunk=1 << 16):
    """C_red(y) para los 2**k estados de las variables de componente (por trozos).

    Vectorizado con BLAS para que k=25 (33.5M estados) sea viable.
    """
    W = np.asarray(prob["W"], dtype=float)
    W_off = W.copy()
    np.fill_diagonal(W_off, 0.0)
    b = float(prob["lam_v"]) * np.asarray(prob["vias"], dtype=float)
    base = np.asarray(base, dtype=np.int8)
    comp_of = np.asarray(comp_of, dtype=int)
    w_sum = 0.25 * float(W_off.sum())
    b_sum = 0.5 * float(b.sum())

    size = 1 << k
    cost = np.empty(size, dtype=float)
    kbits = np.arange(k)
    for lo in range(0, size, chunk):
        hi = min(lo + chunk, size)
        kk = np.arange(lo, hi, dtype=np.int64)
        Y = ((kk[:, None] >> kbits) & 1).astype(np.int8)         # (trozo, k)
        X = base[None, :] ^ Y[:, comp_of]                        # (trozo, n) pistas
        S = 1.0 - 2.0 * X.astype(float)
        coupling = w_sum + 0.25 * np.einsum("ki,ki->k", S @ W_off, S)
        via = b_sum - 0.5 * (S @ b)
        cost[lo:hi] = coupling + via
    return cost


def synthetic_instance(k, per=2):
    """Instancia sintetica con k COMPONENTES (n = k*per pistas).

    Cada bloque de `per` pistas se invierte en el orden de salida -> cada par del
    bloque entra en conflicto (componente conexa). Entre bloques el orden se
    conserva -> sin cruces -> sin conflictos. Con per=2, el grafo son k aristas
    disjuntas -> k componentes -> el problema REDUCIDO tiene k qubits.
    """
    from . import modelo as M

    nets = [f"N{i}" for i in range(k * per)]
    order = []
    for blk in range(k):
        order.extend(reversed(nets[blk * per:(blk + 1) * per]))
    routes = M.make_routes(nets, order)
    conflicts = M.find_conflicts(nets, routes)
    W = M.geometric_weights(nets, routes, conflicts)
    vias = np.full(len(nets), 2.0, dtype=float)
    lam_v = 0.5
    return {
        "nets": nets, "in_order": list(nets), "out_order": list(order),
        "conflicts": conflicts, "W": W, "vias": vias, "lam_v": lam_v,
    }


def _bits(m, k):
    return [int((m >> c) & 1) for c in range(k)]


def run_reduced(prob, reps=3, maxiter=150):
    """QAOA sobre las k variables de componente + reconstruccion de las n pistas."""
    base, groups, comp_of, k = reduce_problem(prob)
    n = len(prob["nets"])
    cost = reduced_cost_vector(prob, base, comp_of, k)
    qa = fq.run_qaoa_cost(cost, reps=reps, maxiter=maxiter)
    probs = np.asarray(qa["probabilities"], dtype=float)

    best_m = int(np.argmin(cost))            # optimo reducido exacto (2**k es trivial)
    qa_m = int(np.argmax(probs))             # argmax de la distribucion QAOA

    return {
        "n": n, "k": k,
        "states_reduced": int(1 << k), "states_full": int(1 << n),
        "groups": [[int(i) for i in g] for g in groups],
        "comp_of": [int(c) for c in comp_of],
        "base": [int(b) for b in base],
        "reduced_opt_cost": round(float(cost[best_m]), 6),
        "reduced_opt_y": _bits(best_m, k),
        "reduced_opt_x": [int(v) for v in x_from_y(base, comp_of, _bits(best_m, k))],
        "qaoa_reduced": {
            "cost": round(float(cost[qa_m]), 6),
            "y": _bits(qa_m, k),
            "x": [int(v) for v in x_from_y(base, comp_of, _bits(qa_m, k))],
            "prob": round(float(probs[qa_m]), 6),
            "energy": round(float(qa["energy"]), 6),
            "evals": len(qa["history"]),
            "reps": reps,
            "valid_mass": 1.0,   # el espacio reducido es factible por construccion
        },
    }


def report(prob, reps=3, maxiter=150):
    """Compara QAOA reducido (k qubits) contra QAOA completo (n qubits)."""
    red = run_reduced(prob, reps=reps, maxiter=maxiter)

    # QAOA completo: distribucion ideal y su masa factible
    n = len(prob["nets"])
    qa_full = fq.run_qaoa(prob["J"], prob["h"], reps=reps, maxiter=maxiter)
    P = np.asarray(qa_full["probabilities"], dtype=float)
    X = ((np.arange(1 << n)[:, None] >> np.arange(n)) & 1).astype(np.int8)
    viol = np.zeros(1 << n, dtype=np.int32)
    for (i, j) in prob["conflicts"]:
        viol += (X[:, i] == X[:, j]).astype(np.int32)
    feasible = viol == 0
    best_full = int(np.argmax(P))
    red["qaoa_full"] = {
        "cost_at_argmax": round(float(C.cost(X[best_full], np.asarray(prob["W"], float),
                                             float(prob["lam_v"]) * np.asarray(prob["vias"], float))), 6),
        "argmax_feasible": bool(feasible[best_full]),
        "valid_mass": round(float(P[feasible].sum()), 6),
        "evals": len(qa_full["history"]),
    }
    return red

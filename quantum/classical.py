"""Clasicos de referencia para comparar con QAOA (mismo C(x) penalizado).

Los metodos clasicos estan RESTRINGIDOS a asignaciones factibles (flips por
componente conexa del grafo de conflictos); QAOA no lo esta. Lo usan el chart
"Classical benchmark" de la UI y `scripts/benchmark.py` (que importa de aqui
para no duplicar codigo).

Convencion de bits: x_i = 0 -> capa L1, x_i = 1 -> capa L4 (igual que el resto
del pipeline). A = W con la penalizacion M sumada en las parejas en conflicto;
b_i = lambda_v * v_i (coste por via).
"""
from __future__ import annotations

import numpy as np


def cost(bits, A, b):
    """C(x) = sum_{i<j} A_ij [x_i = x_j] + b . x (A ya lleva la penalizacion M)."""
    bits = np.asarray(bits, dtype=np.int8)
    return float(np.triu(A * (bits[:, None] == bits[None, :]), 1).sum() + b @ bits)


def num_violations(bits, conflicts):
    return int(sum(int(bits[i] == bits[j]) for i, j in conflicts))


def feasible_coloring(n, conflicts):
    """Una 2-coloracion factible (o ValueError si el grafo no es bipartito)."""
    adj = [[] for _ in range(n)]
    for i, j in conflicts:
        adj[i].append(j)
        adj[j].append(i)
    bits = np.full(n, -1, dtype=np.int8)
    for root in range(n):
        if bits[root] >= 0:
            continue
        bits[root] = 0
        queue = [root]
        for u in queue:
            for v in adj[u]:
                if bits[v] < 0:
                    bits[v] = 1 - bits[u]
                    queue.append(v)
                elif bits[v] == bits[u]:
                    raise ValueError("conflict graph is not bipartite")
    return bits


def components(n, conflicts):
    """Componentes conexas del grafo de conflictos (sus flips preservan la factibilidad)."""
    adj = [[] for _ in range(n)]
    for i, j in conflicts:
        adj[i].append(j)
        adj[j].append(i)
    seen = set()
    out = []
    for root in range(n):
        if root in seen:
            continue
        seen.add(root)
        queue = [root]
        for u in queue:
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    queue.append(v)
        out.append(np.asarray(queue, dtype=int))
    return out


def greedy_local(A, b, conflicts, rng, budget):
    """Reinicios aleatorios factibles + descenso por flip de componente.

    `budget` es el numero de evaluaciones de C(x). Devuelve (best_cost, bits, evals).
    """
    n = len(b)
    groups = components(n, conflicts)
    best = np.inf
    best_bits = None
    evals = 0
    while evals < budget:
        x = feasible_coloring(n, conflicts)
        for group in groups:
            if rng.random() < 0.5:
                x[group] ^= 1
        value = cost(x, A, b)
        evals += 1
        changed = True
        while changed and evals < budget:
            changed = False
            move = None
            newval = value
            for j in rng.permutation(len(groups)):
                if evals >= budget:
                    break
                y = x.copy()
                y[groups[j]] ^= 1
                c = cost(y, A, b)
                evals += 1
                if c < newval - 1e-12:
                    move = y
                    newval = c
            if move is not None:
                x = move
                value = newval
                changed = True
        if value < best:
            best = float(value)
            best_bits = x.copy()
    return best, best_bits, evals


def simulated_annealing(A, b, conflicts, rng, budget, steps_per_run=150):
    """Simulated annealing solo-factible con reinicios (budget = evaluaciones de C)."""
    n = len(b)
    groups = components(n, conflicts)
    adj = [[] for _ in range(n)]
    for i, j in conflicts:
        adj[i].append(j)
        adj[j].append(i)
    best = np.inf
    best_bits = None
    evals = 0
    while evals < budget:
        x = feasible_coloring(n, conflicts)
        for group in groups:
            if rng.random() < 0.5:
                x[group] ^= 1
        value = cost(x, A, b)
        evals += 1
        if value < best:
            best = value
            best_bits = x.copy()
        for step in range(min(steps_per_run, budget - evals)):
            t = step / max(1, steps_per_run - 1)
            temp = max(0.005, 2.0 * (0.005 / 2.0) ** t)
            root = int(rng.integers(n))
            queue = [root]
            seen = {root}
            for u in queue:
                for v in adj[u]:
                    if v not in seen:
                        seen.add(v)
                        queue.append(v)
            y = x.copy()
            y[list(seen)] ^= 1
            c = cost(y, A, b)
            evals += 1
            if c < value or rng.random() < np.exp(np.clip((value - c) / temp, -700, 0)):
                x = y
                value = c
                if value < best:
                    best = value
                    best_bits = x.copy()
    return float(best), best_bits, evals


def exact(n, A, b, conflicts, chunk=8192):
    """Optimo exacto por enumeracion en trozos.

    Devuelve (costs, feasible_mask, opt, opt_mask) para todos los 2**n estados,
    como los necesita el benchmark para puntuar QAOA sobre todo el vector.
    """
    size = 1 << n
    costs = np.empty(size, dtype=np.float64)
    feasible = np.ones(size, dtype=bool)
    edge_i, edge_j = np.triu_indices(n, k=1)
    w = A[edge_i, edge_j]
    good = w != 0
    ei, ej, ew = edge_i[good], edge_j[good], w[good]
    for lo in range(0, size, chunk):
        hi = min(lo + chunk, size)
        k = np.arange(lo, hi, dtype=np.uint32)
        X = ((k[:, None] >> np.arange(n)) & 1).astype(np.int8)
        value = X @ b
        for i, j, ww in zip(ei, ej, ew):
            value = value + ww * (X[:, i] == X[:, j])
        costs[lo:hi] = value
        for i, j in conflicts:
            feasible[lo:hi] &= (X[:, i] != X[:, j])
    if not np.any(feasible):
        raise ValueError("no feasible states")
    opt = float(np.min(costs[feasible]))
    opt_mask = feasible & np.isclose(costs, opt, atol=1e-8, rtol=0)
    return costs, feasible, opt, opt_mask

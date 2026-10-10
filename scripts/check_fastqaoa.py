"""Verificación de `quantum/fastqaoa.py` frente a `quantum/qaoa.py`.

1) Equivalencia numérica en un problema aleatorio pequeño (n=4).
2) Benchmark sobre el modelo real (9 redes) y mejor bitstring factible.

Uso (desde la raíz del repo):
    /tmp/opencode/qtvenv/bin/python scripts/check_fastqaoa.py
"""

import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from quantum import fastqaoa, qaoa, pipeline
from quantum import modelo as M


def check_equivalence():
    print("== 1) Equivalencia en problema aleatorio (n=4) ==")
    rng = np.random.default_rng(0)
    n = 4
    A = rng.random((n, n))
    J = np.triu(A, 1)
    J = J + J.T
    np.fill_diagonal(J, 0.0)
    h = rng.normal(size=n)

    for reps in (1, 2):
        maxiter = 60
        t0 = time.perf_counter()
        slow = qaoa.run_qaoa(J, h, reps=reps, maxiter=maxiter)
        t_slow = time.perf_counter() - t0

        t0 = time.perf_counter()
        fast = fastqaoa.run_qaoa(J, h, reps=reps, maxiter=maxiter)
        t_fast = time.perf_counter() - t0

        diff = abs(slow["energy"] - fast["energy"])
        hist_match = slow["history"] == fast["history"]
        print(f"reps={reps} maxiter={maxiter}")
        print(f"  energy  slow={slow['energy']:.12f}  fast={fast['energy']:.12f}"
              f"  |diff|={diff:.3e}")
        print(f"  keys iguales: {set(slow) == set(fast)}   history idéntico:"
              f" {hist_match} ({len(fast['history'])} evals)")
        print(f"  tiempo  slow={t_slow*1000:.1f} ms  fast={t_fast*1000:.2f} ms"
              f"  speedup={t_slow/max(t_fast, 1e-9):.0f}x")
        assert diff < 1e-6, f"energía difiere: {diff}"
    print("  -> equivalencia OK (< 1e-6)\n")


def check_real_model():
    print("== 2) Modelo real (9 redes) ==")
    prob = pipeline._problem()
    J, h = prob["J"], prob["h"]
    W, vias, lam_v, conflicts, Mpen = (prob["W"], prob["vias"], prob["lam_v"],
                                       prob["conflicts"], prob["M"])
    n = len(h)
    reps, maxiter = 3, 150

    t0 = time.perf_counter()
    res = fastqaoa.run_qaoa(J, h, reps=reps, maxiter=maxiter)
    elapsed = time.perf_counter() - t0

    # mejor bitstring factible según modelo.full_cost
    best = None
    for k, p in enumerate(res["probabilities"]):
        if p < 1e-4:
            continue
        bits = [(k >> i) & 1 for i in range(n)]
        cost = M.full_cost(bits, W, vias, lam_v, conflicts, Mpen)
        violations = sum(1 for (i, j) in conflicts if bits[i] == bits[j])
        if violations == 0 and (best is None or cost < best[0]):
            best = (cost, bits, p)

    best_cost, best_bits, best_p = best
    print(f"reps={reps} maxiter={maxiter}  n_qubits={res['num_qubits']}"
          f"  n_params={res['num_parameters']}")
    print(f"  tiempo total: {elapsed*1000:.1f} ms  ({len(res['history'])} evals)"
          f"  -> {elapsed/max(len(res['history']),1)*1000:.3f} ms/eval")
    print(f"  energy (Ising, sin constante): {res['energy']:.6f}")
    print(f"  mejor bitstring factible: {''.join(map(str, best_bits))}"
          f"  (prob={best_p:.4e})")
    print(f"  costo full_cost: {best_cost:.6f}")

    exact_cost, exact_bits = M.solve_exact(W, vias, lam_v, conflicts, Mpen)
    print(f"  óptimo exacto: {exact_cost:.6f}  bits={''.join(map(str, exact_bits))}")

    assert elapsed < 2.0, f"demasiado lento: {elapsed:.3f}s"
    print("  -> benchmark OK (< 2 s)\n")


if __name__ == "__main__":
    check_equivalence()
    check_real_model()
    print("TODO OK")

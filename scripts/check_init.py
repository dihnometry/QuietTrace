"""Verifica el estado inicial opcional (init) de fastqaoa.py y qaoa.py.

Uso (desde la raíz del repo):
    /tmp/opencode/qtvenv/bin/python scripts/check_init.py

Comprueba:
  1. init=None vs init=[pi/2]*n sobre el modelo real: energías y mejor costo
     factible coinciden (tol 1e-6).
  2. init=[0]*n (partir de |0..0>) da una distribución distinta (se reporta el
     mejor costo factible).
  3. fastqaoa vs qaoa.run_qaoa para n=4 aleatorio con el mismo init (dif. de
     energía < 1e-6); y el circuito de build_circuit tiene 0 parámetros libres y
     corre en BasicSimulator.
"""

import math
import os
import random
import time

import numpy as np

# repo root en sys.path para `import quantum...` al ejecutar desde scripts/
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import sys
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from quantum import fastqaoa as fast
from quantum import qaoa as ref
from quantum import pipeline as P


def best_feasible_cost(probs, prob, n):
    dist = P._distribution(list(probs), prob["W"], prob["vias"], prob["lam_v"],
                           prob["conflicts"], prob["M"], n)
    best = P._best_feasible(dist)
    return best["cost"], best["x"], round(sum(d["prob"] for d in dist), 6)


def main():
    prob = P._problem()
    J, h = prob["J"], prob["h"]
    n = len(prob["nets"])
    reps, maxiter = P.REPS, P.MAXITER

    print(f"modelo real: n={n} reps={reps} maxiter={maxiter}")

    # ---- 1. init=None vs init=[pi/2]*n --------------------------------------
    t0 = time.perf_counter()
    qa_none = fast.run_qaoa(J, h, reps=reps, maxiter=maxiter)
    t_none = time.perf_counter() - t0
    t0 = time.perf_counter()
    qa_pi2 = fast.run_qaoa(J, h, reps=reps, maxiter=maxiter,
                           init=[math.pi / 2] * n)
    t_pi2 = time.perf_counter() - t0

    e_none, e_pi2 = qa_none["energy"], qa_pi2["energy"]
    dE = abs(e_none - e_pi2)
    c_none, x_none, _ = best_feasible_cost(qa_none["probabilities"], prob, n)
    c_pi2, x_pi2, _ = best_feasible_cost(qa_pi2["probabilities"], prob, n)
    tol = 1e-6
    print("\n[1] init=None vs init=[pi/2]*n")
    print(f"    energy  none={e_none:.12f}  pi2={e_pi2:.12f}  diff={dE:.2e}")
    print(f"    best feasible cost none={c_none} pi2={c_pi2}  diff={abs(c_none-c_pi2):.2e}")
    print(f"    timings none={t_none:.3f}s pi2={t_pi2:.3f}s")
    assert dE < tol, f"energias difieren: {dE}"
    assert abs(c_none - c_pi2) < tol, "mejor costo factible difiere"
    assert x_none == x_pi2, f"asignaciones difieren: {x_none} vs {x_pi2}"
    print("    OK")

    # ---- 2. init=[0]*n ------------------------------------------------------
    qa_zero = fast.run_qaoa(J, h, reps=reps, maxiter=maxiter, init=[0.0] * n)
    c_zero, x_zero, _ = best_feasible_cost(qa_zero["probabilities"], prob, n)
    print("\n[2] init=[0.0]*n")
    print(f"    energy={qa_zero['energy']:.12f}  best feasible cost={c_zero}")
    print(f"    x={x_zero}")
    # la distribución debe ser distinta: comparar vector de probabilidades
    dP = max(abs(a - b) for a, b in zip(qa_none["probabilities"],
                                        qa_zero["probabilities"]))
    print(f"    max|P(none)-P(0)|={dP:.3e}")
    assert dP > tol, "la distribucion con init=[0]*n NO difiere"
    print("    OK (distinta)")

    # ---- 3. fastqaoa vs qaoa.run_qaoa (n=4) --------------------------------
    rng = random.Random(1234)
    n4 = 4
    Jr = [[0.0] * n4 for _ in range(n4)]
    for i in range(n4):
        for j in range(i + 1, n4):
            v = rng.uniform(-1.0, 1.0)
            Jr[i][j] = Jr[j][i] = v
    hr = [rng.uniform(-0.5, 0.5) for _ in range(n4)]
    init4 = [rng.uniform(0, math.pi) for _ in range(n4)]

    t0 = time.perf_counter()
    f4 = fast.run_qaoa(Jr, hr, reps=2, maxiter=80, init=init4)
    tf = time.perf_counter() - t0
    t0 = time.perf_counter()
    r4 = ref.run_qaoa(Jr, hr, reps=2, maxiter=80, init=init4)
    tr = time.perf_counter() - t0
    dE4 = abs(f4["energy"] - r4["energy"])
    print("\n[3] fastqaoa vs qaoa.run_qaoa (n=4, init aleatorio)")
    print(f"    init={[round(v, 6) for v in init4]}")
    print(f"    energy fast={f4['energy']:.12f} ref={r4['energy']:.12f} diff={dE4:.2e}")
    print(f"    num_parameters fast={f4['num_parameters']} ref={r4['num_parameters']}")
    print(f"    timings fast={tf:.3f}s ref={tr:.3f}s")
    assert dE4 < tol, f"energia fast vs ref difiere: {dE4}"

    # etapa 3b: build_circuit sin parametros libres + BasicSimulator
    theta = f4["theta"] if len(f4["theta"]) == 2 * 2 else r4["theta"]
    circ = ref.build_circuit(Jr, hr, 2, theta, init=init4)
    nparams = len(circ.parameters)
    print(f"    build_circuit(init=...): parametros libres={nparams} "
          f"depth={circ.depth()} size={circ.size()}")
    assert nparams == 0, f"el circuito tiene {nparams} parametros libres"

    circ_none = ref.build_circuit(Jr, hr, 2, theta, init=None)
    print(f"    build_circuit(init=None): parametros libres={len(circ_none.parameters)}")
    assert any(circ_none.data[i].operation.name == "h"
               for i in range(len(circ_none.data))), "init=None deberia usar H"

    from qiskit.providers.basic_provider import BasicSimulator
    backend = BasicSimulator()
    t0 = time.perf_counter()
    counts = backend.run(circ, shots=256).result().get_counts()
    tb = time.perf_counter() - t0
    print(f"    BasicSimulator counts (256 shots): {counts}  [{tb:.3f}s]")
    assert sum(counts.values()) == 256
    print("    OK")

    print("\nTODO OK")


if __name__ == "__main__":
    main()

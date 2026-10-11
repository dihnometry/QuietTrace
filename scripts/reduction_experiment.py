"""Experimento: reduccion exacta por componentes (k qubits en vez de n pistas).

Uso (desde la raiz del repo, con un Python con numpy/scipy):
    .venv/bin/python -m scripts.reduction_experiment
    .venv/bin/python -m scripts.reduction_experiment --synthetic 18

- Sin argumentos: imprime k para las instancias reales (9, 18, 25 pistas) y compara
  el QAOA reducido con el QAOA completo.
- --synthetic K: construye una instancia sintetica con K componentes (n = 2K pistas,
  k bloques de 2 invertidos) y corre el QAOA REDUCIDO de K qubits.
"""
import argparse
import sys
import time

import numpy as np

from quantum import pipeline, reduced


def real_instances(wsource="geom", cmult=5.0, reps=3):
    print("=== instancias reales ===")
    for kind in ("1adc", "2adc", "25"):
        prob = pipeline._problem(kind, None, wsource, cmult)
        t0 = time.perf_counter()
        red = reduced.run_reduced(prob, reps=reps)
        dt = time.perf_counter() - t0
        print(f"{kind:5s}: n={red['n']:2d} -> k={red['k']:2d} componentes "
              f"({red['states_reduced']} estados vs {red['states_full']}) | "
              f"optimo reducido={red['reduced_opt_cost']:.6f} | "
              f"QAOA reducido={red['qaoa_reduced']['cost']:.6f} "
              f"(prob {red['qaoa_reduced']['prob']:.3f}, {dt:.1f}s)")


def synthetic(k, reps=3, maxiter=150):
    print(f"\n=== sintetica con k={k} componentes (n={2 * k} pistas) ===")
    prob = reduced.synthetic_instance(k)
    base, groups, comp_of, kk = reduced.reduce_problem(prob)
    print(f"conflictos={len(prob['conflicts'])} | componentes={kk} | "
          f"QAOA reducido = {kk} qubits, 2^{kk} = {1 << kk} estados")
    t0 = time.perf_counter()
    red = reduced.run_reduced(prob, reps=reps, maxiter=maxiter)
    dt = time.perf_counter() - t0
    exact = red["reduced_opt_cost"]
    got = red["qaoa_reduced"]["cost"]
    print(f"optimo exacto={exact:.6f} | QAOA reducido={got:.6f} "
          f"(prob {red['qaoa_reduced']['prob']:.4f}) | coincide={abs(got - exact) < 1e-9} | {dt:.1f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", type=int, default=0, help="K componentes para la instancia sintetica")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--maxiter", type=int, default=150)
    a = ap.parse_args()
    if a.synthetic > 0:
        synthetic(a.synthetic, reps=a.reps, maxiter=a.maxiter)
    else:
        real_instances(reps=a.reps)


if __name__ == "__main__":
    main()

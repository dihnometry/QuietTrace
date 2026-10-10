"""Verificacion aislada de `quantum/problem2.py` (2 ADC -> FPGA, 18 redes).

Corre fuera de Qollab con NumPy/SciPy. Comprueba:
  1. construye `problem_2adc()`;
  2. cuenta conflictos y confirma que `conflict_coloring(18, ...)` tiene exito;
  3. resuelve exacto (2^18) y reporta costo + bits;
  4. corre fastqaoa (reps=2, maxiter=80) y reporta tiempo + mejor costo factible;
  5. verifica serializabilidad JSON y n=18.

Uso:
  /tmp/opencode/qtvenv/bin/python scripts/check_problem2.py
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from quantum import modelo as M            # noqa: E402
from quantum import problem2 as P          # noqa: E402
from quantum import fastqaoa as qaoa       # noqa: E402
from quantum.pipeline import _distribution, _best_feasible  # noqa: E402


def main():
    prob = P.problem_2adc()
    nets = prob["nets"]
    W, vias, lam_v = prob["W"], prob["vias"], prob["lam_v"]
    conflicts, Mpen = prob["conflicts"], prob["M"]
    n = len(nets)

    print(f"n = {n}")
    print(f"nets = {nets}")
    print(f"out_order = {prob['out_order']}")
    print(f"n conflictos = {len(conflicts)}")

    coloring = M.conflict_coloring(n, conflicts)
    print(f"conflict_coloring OK -> {coloring}")

    # --- exacto (2^18) -------------------------------------------------------
    t0 = time.perf_counter()
    exact_cost, exact_bits = M.solve_exact(W, vias, lam_v, conflicts, Mpen)
    t_exact = time.perf_counter() - t0
    exact_bits = [int(b) for b in exact_bits]
    print(f"exacto: cost={exact_cost:.6f} bits={exact_bits} (t={t_exact:.1f}s)")
    assert not any(exact_bits[i] == exact_bits[j] for (i, j) in conflicts), \
        "el optimo exacto viola conflictos"

    # --- QAOA ----------------------------------------------------------------
    t0 = time.perf_counter()
    qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=2, maxiter=80)
    t_qaoa = time.perf_counter() - t0
    dist = _distribution(qa["probabilities"], W, vias, lam_v, conflicts, Mpen, n)
    best = _best_feasible(dist)
    print(f"QAOA: t={t_qaoa:.1f}s  num_qubits={qa['num_qubits']}  "
          f"params={qa['num_parameters']}  energy={qa['energy']:.6f}")
    print(f"QAOA mejor factible: cost={best['cost']:.6f} x={best['x']} "
          f"feasible={best['feasible']}")
    gap = (best["cost"] - exact_cost) / max(abs(exact_cost), 1e-9)
    print(f"gap QAOA vs exacto = {gap * 100:.4f}%")

    # --- serializabilidad ----------------------------------------------------
    payload = {
        "nets": nets,
        "in_order": prob["in_order"],
        "out_order": prob["out_order"],
        "conflicts": sorted([int(i), int(j)] for (i, j) in conflicts),
        "W": prob["W"].tolist(),
        "vias": prob["vias"].tolist(),
        "lam_v": prob["lam_v"],
        "M": prob["M"],
        "J": prob["J"].tolist(),
        "h": prob["h"].tolist(),
    }
    s = json.dumps(payload)
    assert isinstance(s, str) and len(s) > 0
    assert payload["M"] > 0 and len(payload["W"]) == n and len(payload["h"]) == n
    print(f"JSON serializable OK ({len(s)} bytes)")

    assert n == 18
    assert prob["W"].shape == (18, 18) and prob["J"].shape == (18, 18)
    print("OK: n=18, shapes correctos, todo serializable.")


if __name__ == "__main__":
    main()

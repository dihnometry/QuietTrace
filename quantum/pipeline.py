"""Pipeline de QuietTracE: modelo real + QAOA -> contrato del motor de vista.

- Variables y restricciones originales: `quantum/modelo.py` (rutas, conflictos,
  pesos geométricos, QUBO/Ising, óptimo exacto).
- QAOA: `quantum/qaoa.py` (QAOAAnsatz + Statevector + COBYLA, movido de main.py).
- Salida: el mismo dict que consume `engine.js`, con datos REALES.
"""

import math
import random

import numpy as np

from . import modelo as M
try:
    from . import fastqaoa as qaoa  # simulador rápido (numpy); mismo contrato
except ImportError:
    from . import qaoa  # respaldo: `main.py` (QAOAAnsatz + Statevector)

# --- parámetros del experimento ---------------------------------------------
LAMBDA_V = 0.5          # hipótesis (sensibilidad por barrido)
VIAS_PER_L4 = 2.0
REPS = 3                # profundidad QAOA (como main.py)
MAXITER = 150
SWEEP_REPS = [1, 2, 3]  # barrido de profundidad
SWEEP_MAXITER = 80


def _problem():
    nets = list(M.NETS)
    routes = M.make_routes()
    conflicts = M.find_conflicts(nets, routes)
    W = M.geometric_weights(nets, routes, conflicts)
    vias = np.full(len(nets), VIAS_PER_L4, dtype=float)
    lam_v = LAMBDA_V
    feasible = M.conflict_coloring(len(nets), conflicts)
    upper = M.soft_cost(feasible, W, vias, lam_v)
    Mpen = upper + max(1.0, 0.05 * upper)
    Q, cQ, J, h, cI = M.build_model(W, vias, lam_v, conflicts, M=Mpen)
    return {
        "nets": nets, "routes": routes, "conflicts": conflicts, "W": W,
        "vias": vias, "lam_v": lam_v, "M": Mpen, "feasible": feasible,
        "J": J, "h": h,
    }


def _bits_from_index(k, n):
    return [(k >> i) & 1 for i in range(n)]


def _breakdown(bits, W, vias, lam_v, conflicts, Mpen):
    x = np.asarray(bits, dtype=int)
    n = len(x)
    coupling = float(sum(W[i, j] for i in range(n)
                         for j in range(i + 1, n) if x[i] == x[j]))
    vias_count = int(sum(vias[i] for i in range(n) if x[i] == 1))
    via_cost = float(lam_v * vias_count)
    violations = int(sum(1 for (i, j) in conflicts if x[i] == x[j]))
    conflict_cost = float(Mpen * violations)
    return {
        "coupling": round(coupling, 6),
        "via_cost": round(via_cost, 6),
        "conflict_cost": round(conflict_cost, 6),
        "total": round(coupling + via_cost + conflict_cost, 6),
        "vias": vias_count,
        "violations": violations,
    }


def _distribution(probs, W, vias, lam_v, conflicts, Mpen, n):
    items = []
    for k, p in enumerate(probs):
        if p < 1e-4:
            continue
        bits = _bits_from_index(k, n)
        bd = _breakdown(bits, W, vias, lam_v, conflicts, Mpen)
        items.append({
            "label": "".join(str(b) for b in bits),
            "x": bits,
            "prob": round(float(p), 6),
            "cost": bd["total"],
            "feasible": bd["violations"] == 0,
        })
    items.sort(key=lambda d: d["prob"], reverse=True)
    return items


def _best_feasible(dist):
    feasible = [d for d in dist if d["feasible"]]
    pool = feasible if feasible else dist
    return min(pool, key=lambda d: (d["cost"], -d["prob"]))


def _layer_members(bits, nets):
    return {
        "L1": [nets[i] for i, b in enumerate(bits) if b == 0],
        "L4": [nets[i] for i, b in enumerate(bits) if b == 1],
    }


def _full(bits, prob, lam_v=None, m_pen=None):
    return M.full_cost(bits, prob["W"], prob["vias"],
                       prob["lam_v"] if lam_v is None else lam_v,
                       prob["conflicts"],
                       prob["M"] if m_pen is None else m_pen)


def run_backend(backend, shots=1024, reps=REPS, maxiter=MAXITER):
    """Optimiza localmente y ejecuta el circuito QAOA final UNA vez en `backend`.

    Cumple la regla de Qollab de un job por run en IonQ: no se itera contra el
    QPU; se optimiza con el simulador rápido y se envía un único circuito.
    Devuelve los conteos medidos.
    """
    prob = _problem()
    qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=reps, maxiter=maxiter)

    from qiskit import transpile
    from . import qaoa as ref  # quantum/qaoa.py (referencia, usa Qiskit)

    circuit = ref.build_circuit(prob["J"], prob["h"], reps, qa["theta"])
    # transpila al conjunto de puertas del backend: los simuladores locales
    # rechazan PauliEvolutionGate sin transpilar.
    tcirc = transpile(circuit, backend=backend, optimization_level=1)

    job = backend.run(tcirc, shots=shots)
    counts = job.result().get_counts()

    name = getattr(backend, "name", None)
    if callable(name):
        try:
            name = name()
        except Exception:  # noqa: BLE001
            name = None

    return {
        "counts": {str(k): int(v) for k, v in counts.items()},
        "shots": int(shots),
        "num_qubits": int(qa["num_qubits"]),
        "reps": reps,
        "backend_name": str(name) if name else "",
    }


def _convergence(prob, n, qa_argmax, budget=150, seed=1234):
    """Trazas 'mejor-hasta-ahora' de cada método, por nº de evaluaciones.

    Devuelve series {name, values (costo acumulado por evaluación), evaluations}
    sobre la MISMA función de costo (corte + vías + conflictos), para ver qué
    método converge más rápido.
    """
    W, vias, lam_v = prob["W"], prob["vias"], prob["lam_v"]
    conflicts, Mpen = prob["conflicts"], prob["M"]
    rng = random.Random(seed)

    def full(bits):
        return M.full_cost(bits, W, vias, lam_v, conflicts, Mpen)

    def trace(gen):
        best, out = None, []
        for bits in gen:
            c = full(bits)
            if best is None or c < best:
                best = c
            out.append(round(float(best), 4))
        return out

    series = []

    def add(name, gen):
        vals = trace(gen)
        series.append({"name": name, "values": vals, "evaluations": len(vals)})

    add("Todas L1", iter(([0] * n,)))

    def gen_random():
        for _ in range(budget):
            yield [rng.randint(0, 1) for _ in range(n)]
    add("Aleatorio", gen_random())

    def gen_greedy():
        x = [0] * n
        yield list(x)
        improved = True
        while improved:
            improved = False
            for i in range(n):
                y = x.copy()
                y[i] ^= 1
                yield list(y)
                if full(y) < full(x):
                    x = y
                    improved = True
    add("Greedy + local", gen_greedy())

    def gen_sa():
        x = [0] * n
        cx = full(x)
        yield list(x)
        T0, T1 = 5.0, 0.05
        for step in range(max(0, budget - 1)):
            T = T0 * (T1 / T0) ** (step / max(1, budget - 2))
            i = rng.randrange(n)
            y = x.copy()
            y[i] ^= 1
            cy = full(y)
            yield list(y)
            if cy <= cx or rng.random() < math.exp(-(cy - cx) / max(T, 1e-9)):
                x, cx = y, cy
    add("Recocido (SA)", gen_sa())

    if qa_argmax:
        best, vals = None, []
        for k in qa_argmax:
            c = full(_bits_from_index(int(k), n))
            if best is None or c < best:
                best = c
            vals.append(round(float(best), 4))
        series.append({"name": "QAOA", "values": vals, "evaluations": len(vals)})

    return series


def get_model():
    prob = _problem()
    nets = prob["nets"]
    n = len(nets)
    W, vias, lam_v, conflicts, Mpen = (prob["W"], prob["vias"], prob["lam_v"],
                                       prob["conflicts"], prob["M"])

    # --- QAOA principal ---
    qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=REPS, maxiter=MAXITER)
    dist = _distribution(qa["probabilities"], W, vias, lam_v, conflicts, Mpen, n)
    best = _best_feasible(dist)
    feas_mass = round(sum(d["prob"] for d in dist if d["feasible"]), 6)

    # --- referencia exacta ---
    exact_cost, exact_bits = M.solve_exact(W, vias, lam_v, conflicts, Mpen)
    exact_bits = [int(b) for b in exact_bits]
    gap = (best["cost"] - exact_cost) / max(abs(exact_cost), 1e-9)

    # --- antes (todas L1) ---
    before_bits = [0] * n
    before = _breakdown(before_bits, W, vias, lam_v, conflicts, Mpen)
    after = _breakdown(best["x"], W, vias, lam_v, conflicts, Mpen)

    # --- barridos analíticos (no usan QAOA) ---
    lam_x = [round(k * 0.25, 2) for k in range(13)]
    lam_before = [round(_full(before_bits, prob, lam_v=lv), 4) for lv in lam_x]
    lam_after = [round(_full(best["x"], prob, lam_v=lv), 4) for lv in lam_x]
    m_x = list(range(17))
    m_before = [round(_full(before_bits, prob, m_pen=float(mv)), 4) for mv in m_x]
    m_after = [round(_full(best["x"], prob, m_pen=float(mv)), 4) for mv in m_x]

    # --- barrido de profundidad p (QAOA real) ---
    p_x, qaoa_cost, qaoa_feas = [], [], []
    for p in SWEEP_REPS:
        if p == REPS:
            d = dist
        else:
            q = qaoa.run_qaoa(prob["J"], prob["h"], reps=p, maxiter=SWEEP_MAXITER)
            d = _distribution(q["probabilities"], W, vias, lam_v, conflicts, Mpen, n)
        b = _best_feasible(d)
        p_x.append(p)
        qaoa_cost.append(b["cost"])
        qaoa_feas.append(round(sum(x["prob"] for x in d if x["feasible"]), 4))

    it_cost = [round(v, 4) for v in qa["history"]]

    # --- evolución de la solución: mejor-hasta-esa-iteración + energía ---
    argmax = qa.get("argmax_history") or []
    hist = qa["history"]
    per_eval = []
    for k in argmax:
        bits = _bits_from_index(int(k), n)
        bd = _breakdown(bits, W, vias, lam_v, conflicts, Mpen)
        per_eval.append({"x": bits, "cost": bd["total"], "violations": bd["violations"]})

    checkpoints = sorted({c for c in (1, 2, 5, 10, 25, 50, 100) if c <= len(hist)} | {len(hist)})
    best_f, best_a, snap_by_iter = None, None, {}
    for idx in range(1, len(hist) + 1):
        if idx - 1 < len(per_eval):
            cand = per_eval[idx - 1]
            if best_a is None or cand["cost"] < best_a["cost"]:
                best_a = cand
            if cand["violations"] == 0 and (best_f is None or cand["cost"] < best_f["cost"]):
                best_f = cand
        if idx in checkpoints:
            snap_by_iter[idx] = best_f or best_a

    solutions = []
    for t in checkpoints:
        s = snap_by_iter[t]
        solutions.append({
            "iter": t,
            "x": s["x"],
            "cost": s["cost"],
            "violations": s["violations"],
            "energy": round(hist[t - 1], 4),
        })

    # --- convergencia: costo vs nº de evaluaciones (QAOA vs clásicos) ---
    convergence = _convergence(prob, n, qa.get("argmax_history") or [], budget=MAXITER)

    return {
        "source": "qaoa",
        "meta": {
            "use_case": "ADC08060 (8 bits) → FPGA · 40 MSPS · stackup L1/L2/L3/L4",
            "lambda_v": lam_v,
            "vias_per_l4": VIAS_PER_L4,
            "m_penalty": round(Mpen, 4),
            "n_nets": n,
            "layers": ["L1", "L4"],
            "reps": REPS,
            "maxiter": MAXITER,
            "num_qubits": qa["num_qubits"],
            "num_parameters": qa["num_parameters"],
            "energy": round(qa["energy"], 6),
            "feasibility": feas_mass,
            "approx_gap": round(gap, 6),
            "approx_ratio": round(best["cost"] / exact_cost, 6) if exact_cost else None,
            "exact_cost": round(float(exact_cost), 6),
        },
        "nets": nets,
        "in_order": nets,
        "out_order": list(M.RIGHT_ORDER),
        "conflicts": [[nets[i], nets[j]] for (i, j) in sorted(conflicts)],
        "weights": [[float(W[i][j]) for j in range(n)] for i in range(n)],
        "assignments": {
            "before": before_bits,
            "after": list(best["x"]),
            "before_layers": _layer_members(before_bits, nets),
            "after_layers": _layer_members(best["x"], nets),
        },
        "costs": {"before": before, "after": after},
        "lambda_sweep": {"x": lam_x, "before": lam_before, "after": lam_after},
        "m_sweep": {"x": m_x, "before": m_before, "after": m_after},
        "qaoa": {"x": p_x, "cost": qaoa_cost, "feasibility": qaoa_feas},
        "iterations": {"x": list(range(len(it_cost))), "cost": it_cost},
        "distribution": dist[:16],
        "best": best,
        "exact": {"x": exact_bits, "cost": round(float(exact_cost), 6)},
        "solutions": solutions,
        "convergence": {
            "series": convergence,
            "exact": {"cost": round(float(exact_cost), 6), "evaluations": 2 ** n},
        },
    }

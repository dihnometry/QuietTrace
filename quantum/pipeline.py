"""QuietTracE pipeline: real model + QAOA -> the viewer's data contract.

- Variables & constraints: `quantum/modelo.py` (routes, conflicts, weights, Ising, exact).
- QAOA: `quantum/fastqaoa.py` (fast NumPy) and `quantum/qaoa.py` (QPU circuit).
- Output: the dict consumed by `engine.js`.
"""

import numpy as np

from . import modelo as M
try:
    from . import fastqaoa as qaoa  # fast NumPy simulator; same contract
except ImportError:
    from . import qaoa  # fallback: main.py (QAOAAnsatz + Statevector)

# --- experiment parameters ---------------------------------------------------
LAMBDA_V = 0.5      # hypothesis (sensitivity via sweep, not wired to the UI)
VIAS_PER_L4 = 2.0
REPS = 3            # QAOA depth (as in main.py)
MAXITER = 150


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
        "nets": nets, "conflicts": conflicts, "W": W,
        "vias": vias, "lam_v": lam_v, "M": Mpen, "J": J, "h": h,
    }


def _bits_from_index(k, n):
    return [(k >> i) & 1 for i in range(n)]


def _bits_from_key(key, n):
    """Qiskit get_counts keys: key[0] es el qubit n-1 (MSB primero)."""
    key = str(key)
    return [int(key[n - 1 - i]) for i in range(n)]


def _breakdown(bits, W, vias, lam_v, conflicts, Mpen):
    x = np.asarray(bits, dtype=int)
    n = len(x)
    coupling = float(sum(W[i, j] for i in range(n)
                         for j in range(i + 1, n) if x[i] == x[j]))
    via_cost = float(lam_v * sum(vias[i] for i in range(n) if x[i] == 1))
    violations = int(sum(1 for (i, j) in conflicts if x[i] == x[j]))
    conflict_cost = float(Mpen * violations)
    return {
        "coupling": round(coupling, 6),
        "via_cost": round(via_cost, 6),
        "conflict_cost": round(conflict_cost, 6),
        "total": round(coupling + via_cost + conflict_cost, 6),
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
            "x": bits,
            "prob": float(p),
            "cost": bd["total"],
            "feasible": bd["violations"] == 0,
        })
    items.sort(key=lambda d: d["prob"], reverse=True)
    return items


def _best_feasible(dist):
    feasible = [d for d in dist if d["feasible"]]
    pool = feasible if feasible else dist
    return min(pool, key=lambda d: (d["cost"], -d["prob"]))


def _ising_energy(bits, J, h):
    s = 1.0 - 2.0 * np.asarray(bits, dtype=float)
    J = np.asarray(J, dtype=float)
    off = J - np.diag(np.diag(J))
    return float(s @ np.asarray(h, dtype=float) + 0.5 * s @ off @ s)


def _dist_stats(dist, J, h):
    """Metricas sobre la distribucion COMPLETA (no truncada)."""
    energy = sum(d["prob"] * _ising_energy(d["x"], J, h) for d in dist)
    valid = sum(d["prob"] for d in dist if d["feasible"])
    return {
        "measured_energy": round(energy, 6),
        "valid_mass": round(valid, 6),
    }


def _index_from_bits(bits):
    return sum((1 << i) for i, b in enumerate(bits) if b)


def _feasible_mask(n, conflicts):
    mask = np.ones(1 << n, dtype=bool)
    for k in range(1 << n):
        bits = _bits_from_index(k, n)
        for (i, j) in conflicts:
            if bits[i] == bits[j]:
                mask[k] = False
                break
    return mask


def _layer_members(bits, nets):
    return {
        "L1": [nets[i] for i, b in enumerate(bits) if b == 0],
        "L4": [nets[i] for i, b in enumerate(bits) if b == 1],
    }


def run_backend(backend, shots=1024, reps=REPS, maxiter=MAXITER):
    """Optimize locally, then run the final QAOA circuit ONCE on `backend`.

    Follows Qollab's one-job-per-run rule on IonQ: no iteration against the QPU;
    it optimizes with the fast simulator and sends a single circuit.
    Returns the measured counts.
    """
    prob = _problem()
    qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=reps, maxiter=maxiter)

    from qiskit import transpile
    from . import qaoa as ref  # quantum/qaoa.py (reference, uses Qiskit)

    circuit = ref.build_circuit(prob["J"], prob["h"], reps, qa["theta"])

    # Transpile for local simulators (their basis). IonQ is left as written:
    # its own pipeline converts to native gates with valid angles, whereas
    # transpiling for IonQ can produce gates with non-positive times.
    is_ionq = type(backend).__module__.startswith("qiskit_ionq")
    if is_ionq:
        tcirc = circuit
    else:
        tcirc = transpile(circuit, backend=backend, optimization_level=1)

    job = backend.run(tcirc, shots=shots)
    counts = job.result().get_counts()

    name = getattr(backend, "name", None)
    if callable(name):
        try:
            name = name()
        except Exception:  # noqa: BLE001
            name = None

    counts = {str(k): int(v) for k, v in counts.items()}
    derived = _fields_from_counts(counts, prob, len(prob["nets"]))

    # comparison metrics: ideal (|psi|^2) vs backend (measured counts)
    n = len(prob["nets"])
    optimal = [int(b) for b in M.solve_exact(prob["W"], prob["vias"], prob["lam_v"],
                                             prob["conflicts"], prob["M"])[1]]
    P = np.asarray(qa["probabilities"], dtype=float)
    Q = np.zeros(1 << n, dtype=float)
    tcounts = sum(counts.values()) or 1
    for key, cnt in counts.items():
        Q[_index_from_bits(_bits_from_key(key, n))] += cnt / tcounts
    mask = _feasible_mask(n, prob["conflicts"])
    opt_idx = _index_from_bits(optimal)
    derived["tvd"] = round(float(0.5 * np.sum(np.abs(P - Q))), 6)
    derived["success_ideal"] = round(float(P[opt_idx]), 6)
    derived["success_backend"] = round(float(Q[opt_idx]), 6)
    derived["valid_ideal"] = round(float(P[mask].sum()), 6)
    derived["valid_backend"] = round(float(Q[mask].sum()), 6)

    return {
        "counts": counts,
        "shots": int(shots),
        "num_qubits": int(qa["num_qubits"]),
        "reps": reps,
        "backend_name": str(name) if name else "",
        "circuit": {
            "num_qubits": int(tcirc.num_qubits),
            "depth": int(tcirc.depth()),
            "size": int(tcirc.size()),
            "ops": {str(k): int(v) for k, v in tcirc.count_ops().items()},
        },
        "derived": derived,
    }


def _fields_from_counts(counts, prob, n):
    """Campos que dependen de la medicion, a partir de conteos (dict Python)."""
    nets = prob["nets"]
    W, vias, lam_v, conflicts, Mpen = (prob["W"], prob["vias"], prob["lam_v"],
                                       prob["conflicts"], prob["M"])
    total = sum(int(c) for c in counts.values()) or 1
    dist = []
    for key, cnt in counts.items():
        bits = _bits_from_key(key, n)
        bd = _breakdown(bits, W, vias, lam_v, conflicts, Mpen)
        dist.append({
            "x": bits,
            "prob": round(int(cnt) / total, 6),
            "cost": bd["total"],
            "feasible": bd["violations"] == 0,
        })
    dist.sort(key=lambda d: (-d["prob"], d["cost"]))
    best = _best_feasible(dist)
    return {
        "distribution": dist[:32],
        "distribution_source": "backend",
        "best": best,
        "costs_after": _breakdown(best["x"], W, vias, lam_v, conflicts, Mpen),
        "assignments_after": list(best["x"]),
        "assignments_after_layers": _layer_members(best["x"], nets),
        "shots": int(total),
        **_dist_stats(dist, prob["J"], prob["h"]),
    }


def model_from_counts(counts):
    """Campos desde conteos, aceptando un objeto JS (Pyodide) o un dict."""
    if hasattr(counts, "to_py"):  # Pyodide JsProxy
        counts = counts.to_py()
    counts = {str(k): int(v) for k, v in counts.items()}
    prob = _problem()
    return _fields_from_counts(counts, prob, len(prob["nets"]))


_IDEAL = {}


def _ideal_cached():
    if "probs" not in _IDEAL:
        prob = _problem()
        qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=REPS, maxiter=MAXITER)
        _IDEAL["prob"] = prob
        _IDEAL["probs"] = np.asarray(qa["probabilities"], dtype=float)
    return _IDEAL


def resample_ideal(shots=1024, seed=None):
    """Remuestrea la distribucion IDEAL con `shots` tiradas (simulacion LOCAL).

    No usa el backend: sirve para ver el efecto del numero de shots (ruido de
    muestreo) sobre las metricas y sobre 'encontrar el optimo'.
    """
    ideal = _ideal_cached()
    prob = ideal["prob"]
    probs = ideal["probs"]
    n = len(prob["nets"])

    rng = np.random.default_rng(seed)
    p = probs / probs.sum()
    draws = rng.choice(len(p), size=int(shots), p=p)

    # conteos con la misma convencion de clave que Qiskit (MSB = qubit n-1)
    counts = {}
    for k in draws:
        key = "".join(str(b) for b in reversed(_bits_from_index(int(k), n)))
        counts[key] = counts.get(key, 0) + 1

    derived = _fields_from_counts(counts, prob, n)

    Q = np.zeros(1 << n, dtype=float)
    for k in draws:
        Q[int(k)] += 1.0
    Q /= max(1, len(draws))

    optimal = [int(b) for b in M.solve_exact(prob["W"], prob["vias"], prob["lam_v"],
                                             prob["conflicts"], prob["M"])[1]]
    opt = _index_from_bits(optimal)
    mask = _feasible_mask(n, prob["conflicts"])

    derived.update({
        "distribution_source": "sampled",
        "shots": int(shots),
        "found_optimal": bool(Q[opt] > 0),
        "tvd": round(float(0.5 * np.sum(np.abs(p - Q))), 6),
        "success_ideal": round(float(p[opt]), 6),
        "success_backend": round(float(Q[opt]), 6),
        "valid_ideal": round(float(p[mask].sum()), 6),
        "valid_backend": round(float(Q[mask].sum()), 6),
    })
    return derived


def get_model():
    prob = _problem()
    nets = prob["nets"]
    n = len(nets)
    W, vias, lam_v, conflicts, Mpen = (prob["W"], prob["vias"], prob["lam_v"],
                                       prob["conflicts"], prob["M"])

    # --- QAOA ---
    qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=REPS, maxiter=MAXITER)
    dist = _distribution(qa["probabilities"], W, vias, lam_v, conflicts, Mpen, n)
    best = _best_feasible(dist)

    # --- exact reference (for the status line) ---
    exact_cost, exact_bits = M.solve_exact(W, vias, lam_v, conflicts, Mpen)
    exact_bits = [int(b) for b in exact_bits]
    gap = (best["cost"] - exact_cost) / max(abs(exact_cost), 1e-9)
    success_ideal = round(sum(d["prob"] for d in dist if d["x"] == exact_bits), 6)

    # --- before (all L1) / after (QAOA) ---
    before_bits = [0] * n
    before = _breakdown(before_bits, W, vias, lam_v, conflicts, Mpen)
    after = _breakdown(best["x"], W, vias, lam_v, conflicts, Mpen)

    # --- solution evolution: best-so-far at checkpoints ---
    argmax = qa.get("argmax_history") or []
    hist = qa["history"]
    per_eval = []
    for k in argmax:
        bits = _bits_from_index(int(k), n)
        bd = _breakdown(bits, W, vias, lam_v, conflicts, Mpen)
        per_eval.append({"x": bits, "cost": bd["total"], "violations": bd["violations"]})

    checkpoints = sorted({c for c in (1, 2, 5, 10, 25, 50, 100) if c <= len(hist)} | {len(hist)})
    best_f, best_a, snap = None, None, {}
    for idx in range(1, len(hist) + 1):
        if idx - 1 < len(per_eval):
            cand = per_eval[idx - 1]
            if best_a is None or cand["cost"] < best_a["cost"]:
                best_a = cand
            if cand["violations"] == 0 and (best_f is None or cand["cost"] < best_f["cost"]):
                best_f = cand
        if idx in checkpoints:
            snap[idx] = best_f or best_a

    solutions = [{
        "iter": t,
        "x": snap[t]["x"],
        "cost": snap[t]["cost"],
        "violations": snap[t]["violations"],
    } for t in checkpoints]

    return {
        "source": "qaoa",
        "meta": {
            "n_nets": n,
            "num_qubits": qa["num_qubits"],
            "num_parameters": qa["num_parameters"],
            "reps": REPS,
            "approx_gap": round(gap, 6),
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
        "exact": {"cost": round(float(exact_cost), 6)},
        "convergence": {
            "x": list(range(len(hist))),
            "energy": [round(v, 4) for v in hist],
        },
        "distribution": dist[:32],
        "distribution_source": "ideal",
        "success_ideal": success_ideal,
        "solutions": solutions,
        **_dist_stats(dist, prob["J"], prob["h"]),
    }

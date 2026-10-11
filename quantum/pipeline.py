"""QuietTracE pipeline: real model + QAOA -> the viewer's data contract.

- Variables & constraints: `quantum/modelo.py` (routes, conflicts, weights, Ising, exact).
- QAOA: `quantum/fastqaoa.py` (fast NumPy) and `quantum/qaoa.py` (QPU circuit).
- Output: the dict consumed by `engine.js`.
"""

import math
import random

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


def _py_none(v):
    """Qollab/Pyodide entrega el `null`/`undefined` de JS como `JsNull`/`JsUndefined`
    (un `JsProxy`), no como `None`. Normaliza ambos a `None`."""
    if v is None:
        return None
    if type(v).__name__ in ("JsNull", "JsUndefined"):
        return None
    return v


def _init_vector(init_deg, n):
    """n angulos (rad) uniformes desde un angulo en grados; None -> |+> (Hadamard)."""
    init_deg = _py_none(init_deg)
    if init_deg is None:
        return None
    return [math.radians(float(init_deg))] * n


def _parse_order(nets, order_str, default):
    order_str = _py_none(order_str)
    if order_str:
        parts = [p.strip() for p in str(order_str).split(",") if p.strip()]
        if len(parts) == len(nets) and set(parts) == set(nets):
            return parts
    return list(default)


def _build_problem(nets, order, wsource="geom"):
    routes = M.make_routes(nets, order)
    conflicts = M.find_conflicts(nets, routes)
    if wsource == "comsol":
        from . import capacitance
        W = capacitance.mutual_capacitance_weights(nets, routes, conflicts)
    else:
        W = M.geometric_weights(nets, routes, conflicts)
    vias = np.full(len(nets), VIAS_PER_L4, dtype=float)
    lam_v = LAMBDA_V
    feasible = M.conflict_coloring(len(nets), conflicts)  # raises if not bipartite
    upper = M.soft_cost(feasible, W, vias, lam_v)
    Mpen = upper + max(1.0, 0.05 * upper)
    Q, cQ, J, h, cI = M.build_model(W, vias, lam_v, conflicts, M=Mpen)
    return {
        "nets": list(nets), "in_order": list(nets), "out_order": list(order),
        "conflicts": conflicts, "W": W,
        "vias": vias, "lam_v": lam_v, "M": Mpen, "J": J, "h": h,
    }


def _problem(kind="1adc", order_str=None, wsource="geom"):
    if kind == "2adc":
        from . import problem2
        nets = list(problem2.NETS_2ADC)
        default = list(problem2.OUT_ORDER)
    else:
        nets = list(M.NETS)
        default = list(M.RIGHT_ORDER)

    order = _parse_order(nets, order_str, default)
    try:
        return _build_problem(nets, order, wsource)
    except ValueError:
        # order makes the conflict graph non-bipartite -> fall back to default
        return _build_problem(nets, default, wsource)


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


def _state_bits(n):
    k = np.arange(1 << n)
    return ((k[:, None] >> np.arange(n)) & 1).astype(np.int8)


def _violation_counts(n, conflicts):
    X = _state_bits(n)
    viol = np.zeros(1 << n, dtype=np.int32)
    for (i, j) in conflicts:
        viol = viol + (X[:, i] == X[:, j]).astype(np.int32)
    return viol


def _feasible_mask(n, conflicts):
    return _violation_counts(n, conflicts) == 0


def _vector_metrics(prob, n):
    """(bits matrix, total cost, ising energy, feasible) para los 2^n estados."""
    X = _state_bits(n)
    Xf = X.astype(float)
    S = 1.0 - 2.0 * Xf
    W = prob["W"]
    coupling = np.zeros(1 << n, dtype=float)
    for i in range(n):
        for j in range(i + 1, n):
            if W[i][j] != 0.0:
                coupling = coupling + W[i][j] * (X[:, i] == X[:, j])
    via = prob["lam_v"] * (Xf @ prob["vias"])
    conflict = prob["M"] * _violation_counts(n, prob["conflicts"])
    total = coupling + via + conflict
    ising = S @ prob["h"] + 0.5 * np.einsum("ki,ij,kj->k", S, prob["J"], S)
    return X, total, ising, (conflict == 0)


def _layer_members(bits, nets):
    return {
        "L1": [nets[i] for i, b in enumerate(bits) if b == 0],
        "L4": [nets[i] for i, b in enumerate(bits) if b == 1],
    }


def _counts_metrics(counts, prob, probs):
    """TVD / validos / exito comparando la ideal (|psi|^2) con los conteos del backend."""
    n = len(prob["nets"])
    P = np.asarray(probs, dtype=float)
    Q = np.zeros(1 << n, dtype=float)
    total = sum(int(c) for c in counts.values()) or 1
    for key, cnt in counts.items():
        Q[_index_from_bits(_bits_from_key(key, n))] += int(cnt) / total
    mask = _feasible_mask(n, prob["conflicts"])
    out = {
        "tvd": round(float(0.5 * np.sum(np.abs(P - Q))), 6),
        "valid_ideal": round(float(P[mask].sum()), 6),
        "valid_backend": round(float(Q[mask].sum()), 6),
    }
    if n <= 16:
        optimal = [int(b) for b in M.solve_exact(prob["W"], prob["vias"], prob["lam_v"],
                                                 prob["conflicts"], prob["M"])[1]]
        opt = _index_from_bits(optimal)
        out["success_ideal"] = round(float(P[opt]), 6)
        out["success_backend"] = round(float(Q[opt]), 6)
    return out


def run_backend(backend, shots=1024, reps=REPS, maxiter=MAXITER, kind="1adc", init_deg=None, order_str=None, wsource="geom"):
    """Optimize locally, then run the final QAOA circuit ONCE on `backend`.

    Follows Qollab's one-job-per-run rule on IonQ: no iteration against the QPU;
    it optimizes with the fast simulator and sends a single circuit.
    Returns the measured counts.
    """
    prob = _problem(kind, order_str, wsource)
    init = _init_vector(init_deg, len(prob["nets"]))
    qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=reps, maxiter=maxiter, init=init)

    from qiskit import transpile
    from . import qaoa as ref  # quantum/qaoa.py (reference, uses Qiskit)

    circuit = ref.build_circuit(prob["J"], prob["h"], reps, qa["theta"], init=init)

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

    job_id = ""
    try:
        jid = job.job_id()
        job_id = str(jid() if callable(jid) else jid)
    except Exception:  # noqa: BLE001
        job_id = ""

    mod = type(backend).__module__
    print(f"[QuietTracE] QPU backend: {name or type(backend).__name__} "
          f"({mod}) · ionq={is_ionq} · shots={int(shots)} · job={job_id or 'n/a'}")

    counts = {str(k): int(v) for k, v in counts.items()}
    derived = _fields_from_counts(counts, prob, len(prob["nets"]))

    # comparison metrics: ideal (|psi|^2) vs backend (measured counts)
    derived.update(_counts_metrics(counts, prob, qa["probabilities"]))

    return {
        "counts": counts,
        "shots": int(shots),
        "num_qubits": int(qa["num_qubits"]),
        "reps": reps,
        "backend_name": str(name) if name else "",
        "backend_module": str(mod),
        "backend_type": type(backend).__name__,
        "is_ionq": bool(is_ionq),
        "job_id": job_id,
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


def model_from_counts(counts, kind="1adc", order_str=None, wsource="geom"):
    """Campos (distribucion, costes, metricas) desde conteos del backend.

    `counts` puede ser un objeto JS (Pyodide) o un dict. Lo usa `main.js` tras
    lanzar el job DESDE JavaScript (`backend.run`), que es la unica via que Qollab
    permite para los backends remotos (IonQ): el POST sincrono desde Python esta
    bloqueado en el sandbox.
    """
    if hasattr(counts, "to_py"):  # Pyodide JsProxy
        counts = counts.to_py()
    counts = {str(k): int(v) for k, v in counts.items()}
    prob = _problem(kind, order_str, wsource)
    derived = _fields_from_counts(counts, prob, len(prob["nets"]))
    ideal = _ideal_cached(kind, None, order_str, wsource)
    derived.update(_counts_metrics(counts, prob, ideal["probs"]))
    return derived


def qaoa_circuit(kind="1adc", order_str=None, wsource="geom"):
    """Circuito QAOA (angulos numericos) para dibujar y ejecutar desde JavaScript.

    Devuelve:
      - `gates`: lista de puertas serializada, para que `main.js` reconstruya el
        circuito con Qiskit en JS y lo envie con `backend.run` (unica via valida
        para IonQ en Qollab).
      - `info`: resumen (qubits, profundidad, tamano, operaciones).
      - `svg`: dibujo del circuito (matplotlib) listo para mostrar como imagen;
        o `text` como respaldo si el drawer no esta disponible.
    """
    import io

    prob = _problem(kind, order_str, wsource)
    theta = _ideal_cached(kind, None, order_str, wsource)["theta"]
    from . import qaoa as ref

    circuit = ref.build_circuit(prob["J"], prob["h"], REPS, theta, init=None)

    gates = []
    for item in circuit.data:
        op = item.operation
        gate = {
            "g": str(op.name),
            "q": [circuit.find_bit(item.qubits[k]).index for k in range(len(item.qubits))],
        }
        if item.clbits:
            gate["c"] = [circuit.find_bit(item.clbits[k]).index for k in range(len(item.clbits))]
        params = list(getattr(op, "params", []) or [])
        if params:
            gate["p"] = [float(x) for x in params]
        gates.append(gate)

    out = {
        "gates": gates,
        "info": {
            "num_qubits": int(circuit.num_qubits),
            "num_clbits": int(circuit.num_clbits),
            "depth": int(circuit.depth()),
            "size": int(circuit.size()),
            "ops": {str(k): int(v) for k, v in circuit.count_ops().items()},
        },
    }
    try:
        import matplotlib
        matplotlib.use("Agg")
        from matplotlib import pyplot as plt
        fig = circuit.draw("mpl", scale=0.7)
        buf = io.StringIO()
        fig.savefig(buf, format="svg", facecolor="white", bbox_inches="tight")
        plt.close(fig)
        out["svg"] = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        out["svg"] = None
        out["draw_error"] = f"{type(exc).__name__}: {exc}"
        try:
            out["text"] = str(circuit.draw("text"))
        except Exception:  # noqa: BLE001
            out["text"] = None
    return out


_IDEAL = {}


def _ideal_cached(kind="1adc", init_deg=None, order_str=None, wsource="geom"):
    init_deg = _py_none(init_deg)
    order_str = _py_none(order_str)
    key = (kind, init_deg, order_str, wsource)
    if key not in _IDEAL:
        prob = _problem(kind, order_str, wsource)
        init = _init_vector(init_deg, len(prob["nets"]))
        qa = qaoa.run_qaoa(prob["J"], prob["h"], reps=REPS, maxiter=MAXITER, init=init)
        _IDEAL[key] = {
            "prob": prob,
            "probs": np.asarray(qa["probabilities"], dtype=float),
            "theta": [float(t) for t in qa["theta"]],
            "qa": qa,
        }
    return _IDEAL[key]


def resample_ideal(shots=1024, seed=None, kind="1adc", init_deg=None, order_str=None, wsource="geom"):
    """Remuestrea la distribucion IDEAL con `shots` tiradas (simulacion LOCAL).

    No usa el backend: sirve para ver el efecto del numero de shots (ruido de
    muestreo) sobre las metricas y sobre 'encontrar el optimo'.
    """
    ideal = _ideal_cached(kind, init_deg, order_str, wsource)
    prob = ideal["prob"]
    probs = ideal["probs"]
    n = len(prob["nets"])
    p = probs / probs.sum()

    mask = _feasible_mask(n, prob["conflicts"])
    opt = None
    if n <= 16:
        optimal = [int(b) for b in M.solve_exact(prob["W"], prob["vias"], prob["lam_v"],
                                                 prob["conflicts"], prob["M"])[1]]
        opt = _index_from_bits(optimal)

    shots = max(0, int(shots))
    if shots < 1:
        return {
            "distribution": [], "distribution_source": "sampled", "shots": 0,
            "found_optimal": False if opt is not None else None, "tvd": 0.5,
            "success_ideal": round(float(p[opt]), 6) if opt is not None else None,
            "success_backend": 0.0 if opt is not None else None,
            "valid_ideal": round(float(p[mask].sum()), 6), "valid_backend": 0.0,
            "best": None, "costs_after": None,
            "assignments_after": [], "assignments_after_layers": {},
        }

    rng = np.random.default_rng(seed)
    draws = rng.choice(len(p), size=shots, p=p)

    # conteos con la misma convencion de clave que Qiskit (MSB = qubit n-1)
    counts = {}
    for k in draws:
        key = "".join(str(b) for b in reversed(_bits_from_index(int(k), n)))
        counts[key] = counts.get(key, 0) + 1

    derived = _fields_from_counts(counts, prob, n)

    Q = np.zeros(1 << n, dtype=float)
    for k in draws:
        Q[int(k)] += 1.0
    Q /= shots

    derived.update({
        "distribution_source": "sampled",
        "shots": shots,
        "found_optimal": (bool(Q[opt] > 0) if opt is not None else None),
        "tvd": round(float(0.5 * np.sum(np.abs(p - Q))), 6),
        "success_ideal": (round(float(p[opt]), 6) if opt is not None else None),
        "success_backend": (round(float(Q[opt]), 6) if opt is not None else None),
        "valid_ideal": round(float(p[mask].sum()), 6),
        "valid_backend": round(float(Q[mask].sum()), 6),
    })
    return derived


def _nets_and_default(kind):
    if kind == "2adc":
        from . import problem2
        return list(problem2.NETS_2ADC), list(problem2.OUT_ORDER)
    return list(M.NETS), list(M.RIGHT_ORDER)


def random_order(kind="1adc"):
    """Random 2-colorable order.

    Interleaves the two color classes of the default coloring at random while
    preserving the order inside each class, so no same-class pair ever inverts
    and the conflict graph stays bipartite.
    """
    nets, default = _nets_and_default(kind)
    routes = M.make_routes(nets, default)
    conflicts = M.find_conflicts(nets, routes)
    color = M.conflict_coloring(len(nets), conflicts)

    c0 = [nets[i] for i in range(len(nets)) if color[i] == 0]
    c1 = [nets[i] for i in range(len(nets)) if color[i] == 1]
    order = []
    i = j = 0
    while i < len(c0) or j < len(c1):
        if j >= len(c1) or (i < len(c0) and random.random() < 0.5):
            order.append(c0[i])
            i += 1
        else:
            order.append(c1[j])
            j += 1
    return {"order": order}


def get_problem(kind="1adc", order_str=None, wsource="geom"):
    prob = _problem(kind, order_str, wsource)
    nets = prob["nets"]
    n = len(nets)
    before_bits = [0] * n
    before = _breakdown(before_bits, prob["W"], prob["vias"], prob["lam_v"],
                        prob["conflicts"], prob["M"])
    return {
        "source": "problem",
        "loading": True,
        "meta": {"n_nets": n, "num_qubits": n, "adcs": 2 if kind == "2adc" else 1,
                 "wsource": wsource},
        "nets": nets,
        "in_order": nets,
        "out_order": list(prob["out_order"]),
        "conflicts": [[nets[i], nets[j]] for (i, j) in sorted(prob["conflicts"])],
        "weights": [[float(prob["W"][i][j]) for j in range(n)] for i in range(n)],
        "assignments": {"before": before_bits, "before_layers": _layer_members(before_bits, nets)},
        "costs": {"before": before},
    }


def get_model(kind="1adc", init_deg=None, order_str=None, wsource="geom"):
    # Una sola optimización QAOA por (kind, init, order, wsource): reutiliza la caché
    # que también usan qaoa_circuit/model_from_counts (evita correr QAOA dos veces).
    ideal = _ideal_cached(kind, init_deg, order_str, wsource)
    prob = ideal["prob"]
    qa = ideal["qa"]
    nets = prob["nets"]
    n = len(nets)
    W, vias, lam_v, conflicts, Mpen = (prob["W"], prob["vias"], prob["lam_v"],
                                       prob["conflicts"], prob["M"])

    # --- QAOA ---
    probs = np.asarray(ideal["probs"], dtype=float)

    X, total, ising, feasible = _vector_metrics(prob, n)
    valid_mass = round(float(probs[feasible].sum()), 6)
    measured_energy = round(float((probs * ising).sum()), 6)

    pool = np.where(feasible)[0]
    if pool.size == 0:
        pool = np.arange(1 << n)
    rel = int(pool[np.lexsort((-probs[pool], total[pool]))[0]])
    best_x = [int(b) for b in X[rel]]
    best_cost = round(float(total[rel]), 6)

    top = np.argsort(probs)[::-1][:32]
    dist = [{
        "x": [int(b) for b in X[k]],
        "prob": round(float(probs[k]), 6),
        "cost": round(float(total[k]), 6),
        "feasible": bool(feasible[k]),
    } for k in top]

    # --- exact reference (skip for large n: 2^n enumeration is costly) ---
    if n <= 16:
        exact_cost, exact_bits = M.solve_exact(W, vias, lam_v, conflicts, Mpen)
        exact_bits = [int(b) for b in exact_bits]
        gap = (best_cost - exact_cost) / max(abs(exact_cost), 1e-9)
        opt = _index_from_bits(exact_bits)
        success_ideal = round(float(probs[opt]), 6)
    else:
        exact_cost, exact_bits, gap, success_ideal = None, None, None, None

    # --- before (all L1) / after (QAOA) ---
    before_bits = [0] * n
    before = _breakdown(before_bits, W, vias, lam_v, conflicts, Mpen)
    after = _breakdown(best_x, W, vias, lam_v, conflicts, Mpen)

    # --- solution evolution: best-so-far at checkpoints ---
    argmax = qa.get("argmax_history") or []
    hist = qa["history"]

    checkpoints = sorted({c for c in (1, 2, 5, 10, 25, 50, 100) if c <= len(hist)} | {len(hist)})
    solutions = []
    for t in checkpoints:
        if t - 1 >= len(argmax):
            continue
        bits = _bits_from_index(int(argmax[t - 1]), n)
        bd = _breakdown(bits, W, vias, lam_v, conflicts, Mpen)
        solutions.append({
            "iter": t,
            "x": bits,
            "cost": bd["total"],
            "violations": bd["violations"],
        })

    return {
        "source": "qaoa",
        "meta": {
            "n_nets": n,
            "num_qubits": qa["num_qubits"],
            "num_parameters": qa["num_parameters"],
            "reps": REPS,
            "adcs": 2 if kind == "2adc" else 1,
            "wsource": wsource,
            "approx_gap": round(gap, 6) if gap is not None else None,
        },
        "nets": nets,
        "in_order": nets,
        "out_order": list(prob["out_order"]),
        "conflicts": [[nets[i], nets[j]] for (i, j) in sorted(conflicts)],
        "weights": [[float(W[i][j]) for j in range(n)] for i in range(n)],
        "assignments": {
            "before": before_bits,
            "after": list(best_x),
            "before_layers": _layer_members(before_bits, nets),
            "after_layers": _layer_members(best_x, nets),
        },
        "costs": {"before": before, "after": after},
        "exact": {"cost": round(float(exact_cost), 6) if exact_cost is not None else None},
        "convergence": {
            "x": list(range(len(hist))),
            "energy": [round(v, 4) for v in hist],
        },
        "distribution": dist,
        "distribution_source": "ideal",
        "success_ideal": success_ideal,
        "solutions": solutions,
        "measured_energy": measured_energy,
        "valid_mass": valid_mass,
    }

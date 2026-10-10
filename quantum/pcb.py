"""QuietTracE — datos MOCK y geometría de la PCB ADC–FPGA.

Este módulo NO implementa la optimización QUBO / Ising / QAOA: esa parte la
hace el equipo de física. Aquí solo:

  - se describe la geometría del corredor (redes y orden de terminales),
  - se detectan conflictos geométricos por cruce de permutaciones,
  - se generan datos de ejemplo (MOCK) para visualizar la placa antes/después
    y alimentar las gráficas de valor.

Todos los pesos y costos son de ejemplo; no provienen de un solver
electromagnético ni de una placa fabricada.
"""

import math

# --- Redes y geometría del corredor -----------------------------------------

NETS = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "CLK"]

# Orden de las redes al entrar y al salir del corredor. La permutación genera
# los cruces; NO se inventan conflictos.
IN_ORDER = list(NETS)
OUT_ORDER = ["D2", "D4", "D0", "D1", "D3", "D5", "D7", "D6", "CLK"]

# Capas externas de señal. L1 = 0, L4 = 1. Los planos L2/L3 son GND.
L1, L4 = 0, 1
LAYER_NAMES = ["L1", "L4"]

# --- Parámetros MOCK (adimensionales) ---------------------------------------

LAMBDA_V = 0.5     # costo por vía
VIAS_PER_L4 = 2    # vías añadidas por red movida a L4
M_PENALTY = 8.0    # penalización por conflicto geométrico
USE_CASE = "ADC08060 (8 bits) → FPGA · 40 MSPS · stackup L1/L2/L3/L4"

# Asignaciones de ejemplo (MOCK):
BEFORE = [L1] * 9                  # "todas L1" (punto de partida sin optimizar)
AFTER = [0, 0, 1, 0, 1, 0, 0, 1, 0]  # solución factible de ejemplo del informe


def _ranks(order):
    return {name: i for i, name in enumerate(order)}


def detect_conflicts():
    """Conflictos geométricos: pares cuyo orden relativo se invierte entre la
    entrada y la salida del corredor (se cruzarían si comparten capa)."""
    ri, ro = _ranks(IN_ORDER), _ranks(OUT_ORDER)
    conflicts = []
    for a in range(len(NETS)):
        for b in range(a + 1, len(NETS)):
            i, j = NETS[a], NETS[b]
            if (ri[i] - ri[j]) * (ro[i] - ro[j]) < 0:
                conflicts.append([i, j])
    return conflicts


def _mock_weights(conflicts):
    """Matriz de acoplamiento w_ij MOCK. Un conflicto no puede compartir capa,
    así que su acoplamiento no aplica y se deja en 0."""
    conflict_pairs = {frozenset(pair) for pair in conflicts}
    w = []
    for a, i in enumerate(NETS):
        row = []
        for b, j in enumerate(NETS):
            if a == b or frozenset((i, j)) in conflict_pairs:
                row.append(0.0)
            else:
                # proxy geométrico de juguete: más acoplamiento si están cerca
                row.append(round(1.0 / abs(a - b), 3))
        w.append(row)
    return w


def evaluate(x, w, conflicts, lam=LAMBDA_V, m=M_PENALTY):
    """Evalúa el costo MOSTRADO de una asignación dada.

    Es solo una función de puntuación para la visualización (corte + vías +
    conflictos). NO es el optimizador: no busca el óptimo.
    """
    n = len(NETS)
    coupling = 0.0
    for a in range(n):
        for b in range(a + 1, n):
            if x[a] == x[b]:
                coupling += w[a][b]

    vias = sum(VIAS_PER_L4 for xi in x if xi == L4)
    violations = sum(
        1 for i, j in conflicts
        if x[NETS.index(i)] == x[NETS.index(j)]
    )

    via_cost = lam * vias
    conflict_cost = m * violations
    return {
        "coupling": round(coupling, 4),
        "via_cost": round(via_cost, 4),
        "conflict_cost": round(conflict_cost, 4),
        "total": round(coupling + via_cost + conflict_cost, 4),
        "vias": vias,
        "violations": violations,
    }


def _layer_members(x):
    return {
        "L1": [NETS[i] for i, xi in enumerate(x) if xi == L1],
        "L4": [NETS[i] for i, xi in enumerate(x) if xi == L4],
    }


def _sweep_lambda(w, conflicts, before, after):
    xs, before_curve, after_curve = [], [], []
    lam = 0.0
    while lam <= 3.0001:
        xs.append(round(lam, 2))
        before_curve.append(evaluate(before, w, conflicts, lam=lam)["total"])
        after_curve.append(evaluate(after, w, conflicts, lam=lam)["total"])
        lam += 0.25
    return xs, before_curve, after_curve


def _sweep_m(w, conflicts, before, after):
    xs, before_curve, after_curve = [], [], []
    for m in range(0, 17, 1):
        xs.append(m)
        before_curve.append(evaluate(before, w, conflicts, m=float(m))["total"])
        after_curve.append(evaluate(after, w, conflicts, m=float(m))["total"])
    return xs, before_curve, after_curve


def _mock_qaoa(opt_cost, start_cost):
    """Curva MOCK de QAOA: el costo esperado baja hacia el óptimo con p."""
    xs, cost, feas = [], [], []
    for p in range(1, 7):
        xs.append(p)
        c = opt_cost + (start_cost - opt_cost) * math.exp(-0.75 * p)
        cost.append(round(c, 4))
        feas.append(round(1 - math.exp(-0.9 * p), 4))
    return xs, cost, feas


def _mock_iterations(opt_cost, start_cost, steps=40):
    xs, cost = [], []
    for k in range(steps):
        t = k / (steps - 1)
        c = opt_cost + (start_cost - opt_cost) * math.exp(-3.2 * t) \
            + 0.6 * math.sin(7 * t) * (1 - t)
        xs.append(k)
        cost.append(round(c, 4))
    return xs, cost


def get_model():
    """Devuelve todo el modelo MOCK como un dict plano (para `main.js`)."""
    conflicts = detect_conflicts()
    w = _mock_weights(conflicts)

    before = evaluate(BEFORE, w, conflicts)
    after = evaluate(AFTER, w, conflicts)

    lam_x, lam_before, lam_after = _sweep_lambda(w, conflicts, BEFORE, AFTER)
    m_x, m_before, m_after = _sweep_m(w, conflicts, BEFORE, AFTER)
    p_x, qaoa_cost, qaoa_feas = _mock_qaoa(after["total"], before["total"])
    it_x, it_cost = _mock_iterations(after["total"], before["total"])

    return {
        "meta": {
            "use_case": USE_CASE,
            "lambda_v": LAMBDA_V,
            "vias_per_l4": VIAS_PER_L4,
            "m_penalty": M_PENALTY,
            "n_nets": len(NETS),
            "layers": LAYER_NAMES,
        },
        "nets": NETS,
        "in_order": IN_ORDER,
        "out_order": OUT_ORDER,
        "conflicts": conflicts,
        "weights": w,
        "assignments": {
            "before": BEFORE,
            "after": AFTER,
            "before_layers": _layer_members(BEFORE),
            "after_layers": _layer_members(AFTER),
        },
        "costs": {"before": before, "after": after},
        "lambda_sweep": {"x": lam_x, "before": lam_before, "after": lam_after},
        "m_sweep": {"x": m_x, "before": m_before, "after": m_after},
        "qaoa": {"x": p_x, "cost": qaoa_cost, "feasibility": qaoa_feas},
        "iterations": {"x": it_x, "cost": it_cost},
    }

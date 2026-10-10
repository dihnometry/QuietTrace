"""QuietTrace ADC08060 -> FPGA: QUBO/Ising completo con conflictos geométricos.

Implementación ilustrativa, NO un diseño de PCB fabricable:
- Rutas XY rectas, una elección global L1/L4 por red
- Conflictos deducidos de cruces de proyecciones XY
- W calculada con un proxy geométrico (reemplazar por C'_m integrado)
- Penalización por vías y conflictos incluida en TODOS los costos

Requiere: numpy.
"""

from itertools import product
import numpy as np

NETS = tuple([f"D{i}" for i in range(8)] + ["CLK"])
# Orden físico de las redes en los corredores de llegada (abajo -> arriba).
# No corresponde todavía al pinout real de una FPGA; es un experimento de breakout.
RIGHT_ORDER = ("D2", "D4", "D0", "D1", "D3", "D5", "D7", "D6", "CLK")


def make_routes(nets=NETS, right_order=RIGHT_ORDER, *, length_mm=65.0, pitch_mm=1.2):
    """Cada ruta se representa como (y_izquierda, y_derecha) en mm."""
    assert set(nets) == set(right_order) and len(nets) == len(right_order)
    destination = {net: p * pitch_mm for p, net in enumerate(right_order)}
    return {net: (i * pitch_mm, destination[net]) for i, net in enumerate(nets)}


def find_conflicts(nets, routes, *, width_mm=0.4, clearance_mm=0.2):
    """Cruces de segmentos x-monótonos y separación de líneas menor que DRC.

    Para dos segmentos entre x=0 y x=L, la separación vertical firmada es lineal.
    Un cambio de signo significa cruce (cobre distinto no puede superponerse).
    Sin cambio de signo, su mínima separación vertical está en un extremo.
    Es una detección geométrica para corredores rectos, no sustituye KiCad DRC.
    """
    conflicts = set()
    for i in range(len(nets)):
        for j in range(i + 1, len(nets)):
            yia, yib = routes[nets[i]]
            yja, yjb = routes[nets[j]]
            left_diff = yia - yja
            right_diff = yib - yjb
            cross = left_diff * right_diff < 0
            too_close = (min(abs(left_diff), abs(right_diff))
                         < width_mm + clearance_mm)
            if cross or too_close:
                conflicts.add((i, j))
    return conflicts


def geometric_weights(nets, routes, conflicts, *, length_mm=65.0,
                      width_mm=0.4, d0_mm=0.25, pitch_ref_mm=1.2, samples=251):
    """Proxy adimensional ~ integral dx/(edge_gap+d0)^2.

    No es NEXT/FEXT ni una capacitancia mutua medida. Para conflictos el peso
    de mismo plano se omite: esos estados son ilegales y los penaliza M.
    La referencia es UNA geometría fija, no una renormalización por instancia.
    """
    n = len(nets)
    W = np.zeros((n, n), dtype=float)
    xx = np.linspace(0.0, length_mm, samples)
    fixed_ref = length_mm / (pitch_ref_mm - width_mm + d0_mm) ** 2
    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) in conflicts:
                continue
            yia, yib = routes[nets[i]]
            yja, yjb = routes[nets[j]]
            yi = yia + (yib - yia) * xx / length_mm
            yj = yja + (yjb - yja) * xx / length_mm
            edge_gap = np.maximum(np.abs(yi - yj) - width_mm, 0.0)
            raw = np.trapezoid(1.0 / (edge_gap + d0_mm) ** 2, xx)
            W[i, j] = W[j, i] = raw / fixed_ref
    return W


def conflict_coloring(n, conflicts):
    """Retorna un bitstring sin conflictos o lanza error si grafo no bipartito."""
    neighbors = [set() for _ in range(n)]
    for i, j in conflicts:
        neighbors[i].add(j)
        neighbors[j].add(i)
    bits = [-1] * n
    for root in range(n):
        if bits[root] != -1:
            continue
        bits[root] = 0
        queue = [root]
        for v in queue:
            for u in neighbors[v]:
                if bits[u] == -1:
                    bits[u] = 1 - bits[v]
                    queue.append(u)
                elif bits[u] == bits[v]:
                    raise ValueError("No existe asignación a dos capas: conflicto no bipartito")
    return tuple(bits)


def soft_cost(bits, W, vias, lam_v):
    x = np.asarray(bits, dtype=int)
    return float(sum(W[i, j] for i in range(len(x))
                     for j in range(i + 1, len(x)) if x[i] == x[j])
                 + lam_v * np.dot(vias, x))


def full_cost(bits, W, vias, lam_v, conflicts, M):
    return soft_cost(bits, W, vias, lam_v) + M * sum(
        bits[i] == bits[j] for (i, j) in conflicts
    )


def build_model(W, vias, lam_v, conflicts, *, M):
    """Matriz Q simétrica y coeficientes Ising de la MISMA función completa.

    C(x) = constant_Q + x.T Q x
         = constant_Ising + h.s + sum_{i<j} J[i,j] s[i]s[j]
    """
    n = len(vias)
    W = np.asarray(W, dtype=float)
    vias = np.asarray(vias, dtype=float)
    assert W.shape == (n, n) and np.allclose(W, W.T)
    assert np.allclose(np.diag(W), 0.0) and np.all(W >= 0)
    A = W.copy()
    for i, j in conflicts:
        A[i, j] += M
        A[j, i] += M
    Q = A.copy()
    np.fill_diagonal(Q, lam_v * vias - A.sum(axis=1))
    constant_Q = float(np.triu(A, k=1).sum())
    J = A / 2.0
    h = -0.5 * lam_v * vias
    constant_Ising = constant_Q / 2.0 + lam_v * float(vias.sum()) / 2.0
    return Q, constant_Q, J, h, constant_Ising


def solve_exact(W, vias, lam_v, conflicts, M):
    n = len(vias)
    results = [(full_cost(x, W, vias, lam_v, conflicts, M), x)
               for x in product((0, 1), repeat=n)]
    return min(results, key=lambda t: t[0])


"""QuietTracE, variante experimental de 25 redes (dev-only).

Instancia SINTETICA para empujar el limite del statevector denso (2^25 = 33.5M
amplitudes). NO se ofrece en la version exportada a Qollab: la pestana de 25q
esta marcada `dev-only` en la UI.

Misma matematica que `modelo`/`problem2` (rutas, DRC, pesos, Ising). El truco
para que el grafo de conflictos sea 2-coloreable es el de la instancia de 18:
dos clases de color (A y B) cuyo orden interno se preserva en el pinout, de modo
que TODO cruce ocurre entre clases -> el grafo es exactamente bipartito.

    A = D0..D12            (13 redes)
    B = D13..D23 + CLK     (12 redes)
"""

from . import modelo as M

NETS_25 = tuple([f"D{i}" for i in range(24)] + ["CLK"])
IN_ORDER = list(NETS_25)

_A = [f"D{i}" for i in range(13)]
_B = [f"D{i}" for i in range(13, 24)] + ["CLK"]


def _interleave(a, b):
    """Alterna a/b preservando el orden dentro de cada clase (garantiza 2-coloreo)."""
    out, i, j = [], 0, 0
    while i < len(a) or j < len(b):
        if i < len(a):
            out.append(a[i]); i += 1
        if j < len(b):
            out.append(b[j]); j += 1
    return out


OUT_ORDER = _interleave(_A, _B)

VIAS_PER_L4 = 2.0
LAMBDA_V = 0.5

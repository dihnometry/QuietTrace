"""QuietTracE, variante de 2 ADC: asignacion de capas L1/L4 sobre 18 redes.

Escenario: dos ADC08060 (cada uno 8 datos + 1 reloj) hacia una FPGA.

  - ADC1: D0..D7 + CLK1
  - ADC2: D8..D15 + CLK2

Es la MISMA matematica que el caso mono-ADC de `quantum/modelo.py` (rutas, DRC,
pesos geometricos, Ising); aqui solo se define la instancia de 18 redes. No se
duplica ningun calculo: todo se delega en `modelo`.

Contrato de salida: identico al de `quantum/pipeline.py::_problem()` (mas
`in_order`/`out_order`), para que `quantum/fastqaoa.py` y el visor lo consuman
sin cambios.
"""

import numpy as np

from . import modelo as M

# --- instancia: 18 redes (2 bancos de 9) ------------------------------------
NETS_2ADC = tuple([f"D{i}" for i in range(16)] + ["CLK1", "CLK2"])

# Orden logico: los datos primero, luego los relojes (como llega la lista de
# nets de `modelo`). Los indices 0..7 son ADC1, 8..15 ADC2, 16=CLK1, 17=CLK2.
IN_ORDER = list(NETS_2ADC)

# Pinout de llegada a la FPGA. Se intercalan los dos bancos empezando cada
# pareja por la linea de ADC2 (D8,D0,D9,D1,...): eso invierte ~la mitad de los
# pares entre bancos y produce varios cruces. Clave para que el grafo de
# conflictos sea 2-coloreable:
#   * dentro de cada banco el orden de salida coincide con el de entrada
#     (ADC1: D0<...<D7<CLK1 ; ADC2: D8<...<D15<CLK2), asi que NINGUN par del
#     mismo banco se invierte -> no hay cruces intra-banco;
#   * todo cruce es, por tanto, entre bancos -> el grafo es exactamente
#     bipartito (una capa = un banco).
# CLK2 se inserta tras D15 (respeta el orden del banco ADC2) pero antes de D7,
# lo que reproduce la inversion del par de relojes y mantiene las 18 redes en
# una sola componente conexa.
OUT_ORDER = [
    "D8", "D0", "D9", "D1", "D10", "D2", "D11", "D3",
    "D12", "D4", "D13", "D5", "D14", "D6", "D15", "CLK2", "D7", "CLK1",
]

VIAS_PER_L4 = 2.0
LAMBDA_V = 0.5


def make_routes_2adc(nets=NETS_2ADC, out_order=OUT_ORDER):
    """Rutas XY (y_izq, y_der) en mm para las 18 redes."""
    return M.make_routes(nets, out_order)


def problem_2adc():
    """Instancia 2 ADC -> FPGA con el mismo contrato que pipeline._problem()."""
    nets = list(NETS_2ADC)
    routes = make_routes_2adc()
    conflicts = M.find_conflicts(nets, routes)
    W = M.geometric_weights(nets, routes, conflicts)

    vias = np.full(len(nets), VIAS_PER_L4, dtype=float)
    lam_v = LAMBDA_V

    # El coloreo 2-capas debe existir (grafo bipartito); si no, la instancia
    # seria insolubre y no tendria sentido pasarla a QAOA.
    feasible = M.conflict_coloring(len(nets), conflicts)
    upper = M.soft_cost(feasible, W, vias, lam_v)
    Mpen = upper + max(1.0, 0.05 * upper)

    Q, cQ, J, h, cI = M.build_model(W, vias, lam_v, conflicts, M=Mpen)

    return {
        "nets": nets,
        "in_order": list(IN_ORDER),
        "out_order": list(OUT_ORDER),
        "conflicts": conflicts,
        "W": W,
        "vias": vias,
        "lam_v": lam_v,
        "M": Mpen,
        "J": J,
        "h": h,
    }

# Reducción exacta por componentes (QuietTracE)

> Documento de diseño e implementación. Describe la **reformulación** del problema de
> asignación de capas (L1/L4) que hace que QAOA **nunca** explore configuraciones que
> violan las restricciones de cruce. No añade física nueva ni un algoritmo cuántico
> nuevo: cambia la **representación matemática** y conserva todos los pesos.

Rama: `feat/component-reduction`. Código: `quantum/reduced.py` (núcleo),
`quantum/pipeline.py` (`_reduced_model`, `get_model(model=...)`),
`scripts/reduction_experiment.py` (experimento), UI (`Model: Full / Reduced`).

---

## 1. Motivación

En el modelo original hay **una variable por pista** `x_i ∈ {0,1}` (L1/L4) y el coste es

```
C(x) = Σ_{i<j} W_ij [x_i = x_j]        (acoplamiento capacitivo; W de COMSOL o geométrico)
     + λv Σ_i v_i x_i                  (coste de vías)
     + M Σ_{(i,j)∈F} [x_i = x_j]       (restricciones de cruce, penalizadas)
```

Problema: aunque los cruces son **obligatorios**, el circuito puede producir soluciones
que los violan (sobre todo a 18 qubits, donde `valid ≈ 0`). La penalización `M` solo
*desincentiva*; no *prohíbe*.

## 2. La idea: resolver la estructura de las restricciones (antes de optimizar)

Cada cruce es un **XOR**: `x_i ⊕ x_j = 1`. Si el grafo de conflictos es **bipartito**
con **k componentes conexas**, entonces **todas** las asignaciones factibles son las
`2^k` coloraciones (una por componente). Con una coloración de referencia `b`:

```
x_i = b_i ⊕ y_{c(i)}          c(i) = componente de la pista i;  y_c ∈ {0,1}
```

- `b` y las componentes se hallan con **BFS/DFS en tiempo lineal** — es **preprocesamiento**
  (presolve), **no** una optimización. No resuelve el problema: solo reescribe variables.
- Si aparece un **ciclo impar**, el modelo no tiene asignación factible (se detecta).

## 3. En qué se convierte la función de coste

La penalización de conflictos **desaparece** (siempre se cumple). Quedan acoplamiento y vías,
reexpresados en las `y`:

```
C(y) = Σ_{i<j} W_ij [b_i ⊕ y_{c(i)} = b_j ⊕ y_{c(j)}] + λv Σ_i v_i (b_i ⊕ y_{c(i)})
```

Reagrupando por componentes (`Z_c = (-1)^{y_c}`):

```
C(y) = C0 + Σ_{c<d} J_cd Z_c Z_d + Σ_c h_c Z_c
```

- Pares **intra-componente**: `x_i, x_j` cambian juntos → aportan a la **constante `C0`**.
- Pares **inter-componente**: aportan acoplamiento efectivo

  ```
  J_cd = ½ Σ_{i∈c, j∈d} W_ij (−1)^{b_i ⊕ b_j}
  ```

  (cada par una vez). Puede ser **positivo o negativo** → **no** es MaxCut convencional.
- Vías → campo local `h_c`.

**Resultado:** un **Ising/QUBO sobre k variables**, con acoplamientos físicos efectivos
(COMSOL) y sin penalizaciones. Y `min_y C(y) = min_{x factible} C(x)` = óptimo del problema
original. **La reducción es exacta.**

Mixer: el estándar `H_M = Σ_c X_c` basta (todas las combinaciones de `y` son válidas);
**no** hace falta XY mixer.

## 4. Implementación

- `quantum/reduced.py`
  - `reduce_problem(prob)` → `base, groups, comp_of, k` (coloración + componentes).
  - `x_from_y(base, comp_of, y)` → reconstruye las n pistas.
  - `reduced_cost_vector(prob, base, comp_of, k)` → `C(y)` para los `2^k` estados
    (**vectorizado con BLAS por trozos**: k=25 → 33.5M estados viables).
  - `run_reduced(prob, reps, maxiter)` → QAOA sobre `k` qubits + reconstrucción.
  - `synthetic_instance(k, per=2)` → instancia con `k` componentes (`n = 2k`).
- `quantum/fastqaoa.py`: `run_qaoa_cost(cost, ...)` (QAOA con un vector de coste; `run_qaoa` delega).
- `quantum/pipeline.py`: `get_model(..., model="full"|"reduced")`; `_reduced_model()` devuelve el
  **mismo contrato** que el motor, con `meta.num_qubits = k`. Guarda: el modelo completo no se
  simula por encima de ~22 qubits (avisa y pide usar Reduced).
- UI: pestañas **`Model: Full · n qubits` / `Reduced · k qubits`** (visibles también en Qollab) y
  la tarjeta *Component reduction*. Instancias `9 groups · 18 nets` (k=9) y `18 groups · 36 nets` (k=18).

## 5. Resultados medidos

Instancias reales (reducido = k qubits):

| instancia | pistas n | **k** | estados reducidos | estado completo |
|---|---|---|---|---|
| 1 ADC | 9 | 4 | 16 | 512 |
| 2 ADC | 18 | **1** | 2 | 262 144 |
| 25 nets | 25 | 2 | 4 | 33 554 432 |

Sintéticas (n = 2k):

| | pistas n | **k** | QAOA reducido | óptimo | coincide |
|---|---|---|---|---|---|
| `syn9` | 18 | 9 | 9 qubits (2⁹) | 13.7053 | ✅ |
| `syn18` | 36 | **18** | 18 qubits (2¹⁸) | 28.6714 | ✅ |

Ejemplo revelador (`syn9`): **Full 18q → 14.7591 (subóptimo, valid 0.11)** vs
**Reduced 9q → 13.7053 (óptimo exacto, valid 1.0)**. La reformulación no solo es más
pequeña: **mejora el resultado**.

## 6. Honestidad del benchmark (importante)

Comparar el QAOA **reducido** contra métodos que **no** usan la reducción sería
**supremacía cuántica falsa**. Por eso, en el benchmark **todos** los métodos operan en el
**mismo espacio reducido (2^k)**:

- *Greedy local* y *Simulated annealing*: ya van restringidos a factibles (flips por componente).
- *Exhaustive (feasible 2^k)*: enumeración del espacio reducido (vectorizada).
- *QAOA*: el reducido (k qubits) cuando el modelo es Reduced.

No se enumeran los `2^n` estados ni se usan tiempos **estimados**: eso sería un número falso.
Consecuencia honesta: con los pesos/estructura actuales, los clásicos **también** encuentran el
óptimo → **no hay ventaja cuántica que reclamar**; el valor está en la **ingeniería**
(COMSOL, restricciones físicas, comparación cuantitativa).

## 7. Límites y cuándo NO aplica

- La reducción es exacta **solo** bajo restricciones **XOR duras** ("estas dos pistas en capas
  distintas") y **compatibles** (grafo bipartito).
- Si se añaden **conflictos blandos**, **vías** como decisión, **cambios de ruta** o **más de
  dos capas** (la restricción deja de ser XOR), **no** se puede imponer con esta reducción sin
  ampliar el modelo.
- La reducción **reduce la dificultad**: en instancias reales `k` es diminuto (18 pistas → **1
  decisión**). Para un problema genuinamente difícil hay que **enriquecer el modelo**.

## 8. Próximos pasos

1. Validar que el QUBO reducido reproduce **exactamente** costes y soluciones del original
   (hecho: mismo óptimo en todas las instancias).
2. Benchmark con **k creciente** (p. ej. k = 6, 9, 12, 15, 18) comparando QAOA reducido vs
   simulated annealing / búsqueda local / solver Ising, con **presupuestos comparables**, y
   cuidando que los `J_cd` entre componentes **no** sean despreciables (si no, se trivializa).
3. Decidir si se **enriquece el modelo** (más capas, conflictos ponderados) para buscar un
   régimen donde la optimización sobre las `y_c` siga siendo difícil.

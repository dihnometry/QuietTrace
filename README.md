# QuietTracE

Optimización cuántica de **asignación de capas** (L1/L4) en una PCB **ADC–FPGA**, ejecutada
en [Qollab](https://qollab.xyz). Proyecto **híbrido JS + núcleo Python**.

> **Contrato de desarrollo:** antes de tocar código lee [`AGENTS.md`](./AGENTS.md).

## Qué hace ahora

El **QAOA real** está integrado en el pipeline. Al abrir la página:

1. **Variables y restricciones originales** — el modelo (`quantum/modelo.py`) construye las
   9 redes (`D0`–`D7`, `CLK`), sus rutas, los **conflictos geométricos** y los pesos `W`.
2. **QAOA** — `quantum/fastqaoa.py` corre el QAOA (mismo ansatz que `main.py`) sobre el
   Ising `J,h` del modelo. El optimizador es COBYLA.
3. **Respuesta + gráficas** — se elige la **mejor muestra factible** y se dibuja: tablero
   *después*, desglose de costo, convergencia del optimizador, distribución de bitstrings,
   grafo de **qubits y acoplamientos**, explosión combinatoria **2ⁿ vs nº de líneas**,
   comparación con el **óptimo exacto** y una **evolución por iteraciones** (mejor-hasta-ese-
   momento + energía secuencial: 1, 2, 5, 10, 25, 50, 100, 150).

Resultado verificado en el modelo de ejemplo: mejor solución = `001010010`, coste **7.049177**
(igual al óptimo exacto, `gap ≈ 0`). Capas: `L1: D0,D1,D3,D5,D6,CLK` · `L4: D2,D4,D7`.

## Ejecutar en QPU

Al correr en Qollab se elige el backend en **Select QPU**. El pipeline optimiza **localmente**
y luego envía **un solo circuito** QAOA al backend elegido (regla de *un job por run* en IonQ),
mostrando los conteos medidos y su factibilidad. En la vista local no hay backend, así que esa
sección queda vacía.

## QAOA vs clásicos

Gráfica **costo vs nº de evaluaciones** (mejor-hasta-ahora) sobre la misma función de costo:
*Todas L1*, *Aleatorio*, *Greedy + búsqueda local*, *Recocido simulado (SA)* y *QAOA*, con el
**óptimo exacto** como referencia. Muestra qué método converge más rápido.

A esta escala (9 líneas) el óptimo exacto es tratable y varios heurísticos llegan al óptimo;
QAOA lo alcanza en ~150 evaluaciones. La ventaja de QAOA **escala con el número de líneas**
(recursos ~polinómicos vs 2ⁿ), como ilustra la gráfica de combinaciones.

## Arquitectura

```
index.html            # UI (solo contenido de <body>)
main.css              # estilos + temas
main.js               # entrada JS -> quantum/pipeline.py + engine.js
engine.js             # motor de render SVG (PCB 2D/3D, gráficas, histograma)

quantum/
  modelo.py           # MODELO del equipo (vendorado tal cual, NO se modifica)
  qaoa.py             # QAOA de referencia: movido de main.py (QAOAAnsatz + Statevector)
  fastqaoa.py         # QAOA rápido (NumPy, statevector exacto) — el que usa el pipeline
  pipeline.py         # une modelo + QAOA y devuelve el contrato del motor
  pcb.py              # modelo MOCK (modo demo / respaldo si faltan deps)
requirements.txt
```

**`main.py` se movió a `quantum/qaoa.py`** (la lógica QAOA queda intacta para auditar).
El pipeline usa `fastqaoa.py` porque `QAOAAnsatz + Statevector` es ~1000× más lento
(~1.2 s por evaluación) e inviable en el navegador; `fastqaoa` reproduce el mismo resultado
con NumPy puro.

## Tema

Tema único **Hybrid**: colores y bordes nítidos de *OtherDev* (negro puro + verde neón) +
**glow** estilo Frutiger Aero + **liquid glass** (cristal negro con bordes marcados).

## Ver en local

El motor de render es JS puro; la vista local usa `dev/model.json`:

```sh
PYTHON=/ruta/a/python/con/qiskit ./scripts/export-model.sh   # modelo.json real (QAOA)
./scripts/preview.sh        # http://localhost:8000/dev/preview.html
```

Sin qiskit/scipy, `export-model.sh` cae automáticamente al modelo **mock**.

## Empaquetar para Qollab

```sh
./scripts/package.sh        # -> /tmp/quiettrace-qollab.zip
```

Incluye solo los archivos de runtime (`index.html`, `main.css`, `main.js`, `engine.js`,
`quantum/`, `requirements.txt`, `README.md`, `LICENSE`). Luego, en Qollab:
**Upload your own files** → soltar el zip → **built-in simulator**.

## Documentación

- Runtime: https://qollab.xyz/learn/docs/runtime-environment
- Proyectos JS/Qiskit: https://qollab.xyz/learn/docs/js-qiskit-projects
- Subida de archivos: https://qollab.xyz/learn/docs/upload-your-files

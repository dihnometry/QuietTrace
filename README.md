# QuietTracE

Optimización cuántica de **asignación de capas** en una PCB **ADC–FPGA**, ejecutada en
[Qollab](https://qollab.xyz). Este repositorio es un **híbrido JS + núcleo Python**:

- **`quantum/pcb.py`** — modelo de datos **mock** y geometría del corredor (redes,
  orden de terminales, detección de conflictos por cruce).
- **`engine.js`** — motor de visualización en SVG (PCB antes/después + gráficas de valor).
- **`main.js`** — une ambos: pide el modelo a Python y lo dibuja.

> **Importante:** aquí **no** está implementada la optimización QUBO / Ising / QAOA.
> Eso lo hace el equipo de física. Este módulo solo **visualiza**; no envía jobs a `backend`
> ni gasta créditos. Todos los pesos y costos son **de ejemplo (mock)**.

> **Contrato de desarrollo:** antes de tocar código lee [`AGENTS.md`](./AGENTS.md).

## Qué muestra

- **PCB (vista superior):** el ADC08060 a un lado, la FPGA al otro y las 9 redes
  (`D0`–`D7`, `CLK`) cruzando el corredor. Compara **antes** (todas en L1, con los 6
  conflictos geométricos) y **después** (una solución factible de ejemplo, con las redes
  repartidas entre L1 y L4 y las vías de señal).
- **Gráficas:** desglose de costo (acoplamiento + vías + conflictos), costo vs. `λv`,
  costo vs. `M`, curva mock de QAOA (costo y factibilidad vs. profundidad `p`), convergencia
  mock y matriz de acoplamiento `w_ij`.

## Estructura

```
index.html          # UI (solo contenido de <body>)
main.css            # estilos (única hoja cargada)
main.js             # entrada JS -> quantum/pcb.py + engine.js
engine.js           # motor de render (SVG puro)
quantum/pcb.py      # modelo mock + geometría (Python, sin Qiskit)
requirements.txt
```

## Ver en local

El proyecto real depende del runtime de Qollab (Pyodide + `backend`), pero el motor de
render es JS puro y se puede previsualizar:

```sh
./scripts/export-model.sh   # genera dev/model.json desde quantum/pcb.py
./scripts/preview.sh        # abre http://localhost:8000/dev/preview.html
```

La vista local usa el mismo `engine.js` y el mismo `index.html`, alimentados por
`dev/model.json`. Es un **mock** del runtime.

## Empaquetar para subir a Qollab

```sh
./scripts/package.sh        # -> /tmp/quiettrace-qollab.zip
```

Incluye solo los archivos de runtime (`index.html`, `main.css`, `main.js`, `engine.js`,
`quantum/`, `requirements.txt`, `README.md`, `LICENSE`); excluye `dev/`, `scripts/` y
`AGENTS.md`. Luego, en Qollab: **Upload your own files** → soltar el zip → elegir el
**built-in simulator**.

## Documentación

- Runtime: https://qollab.xyz/learn/docs/runtime-environment
- Proyectos JS/Qiskit: https://qollab.xyz/learn/docs/js-qiskit-projects
- Subida de archivos: https://qollab.xyz/learn/docs/upload-your-files

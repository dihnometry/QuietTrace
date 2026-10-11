# Contrato de desarrollo — QuietTracE sobre Qollab

> **Este archivo es vinculante para cualquier agente o persona que toque este repositorio.**
> Léelo completo antes de escribir, mover o borrar código. Si algo aquí contradice lo que
> crees saber sobre proyectos "normales", **manda este contrato**.

---

## 0. Regla de oro

**Todo QuietTracE se ejecuta en Qollab (https://qollab.xyz).** No es una app local, no es un
servidor, no es un contenedor. El código corre en el navegador del visitante, dentro del
runtime de Qollab. Cualquier decisión de diseño debe ser válida **dentro de ese runtime**,
no en una máquina de desarrollo.

Consecuencias obligatorias:

- **NO** asumas acceso a disco persistente, base de datos, sistema de archivos del host,
  procesos en background, cron, ni sockets.
- **NO** asumas `pip install` arbitrario ni compilación nativa en tiempo de ejecución.
- **NO** asumas backend propio, API key ni proveedor cuántico propio: Qollab **inyecta**
  un objeto `backend` ya creado.
- **NO** metas secretos (API keys, tokens, contraseñas): el código es público al publicar.
- Si una funcionalidad no puede vivir dentro de estas reglas, se rediseña; no se salta la regla.

### Fuentes autoritativas

La fuente de verdad es siempre la documentación viva. Antes de implementar algo nuevo,
consúltala:

- Índice: https://qollab.xyz/learn/docs
- Subida de archivos: https://qollab.xyz/learn/docs/upload-your-files
- Runtime: https://qollab.xyz/learn/docs/runtime-environment
- Proyectos Python/Qiskit: https://qollab.xyz/learn/docs/python-qiskit-projects
- Proyectos JS/Qiskit: https://qollab.xyz/learn/docs/js-qiskit-projects
- Ejecutar código: https://qollab.xyz/learn/docs/run-your-code
- Backends: https://qollab.xyz/learn/docs/compute-backends
- Compilación: https://qollab.xyz/learn/docs/how-your-circuit-is-compiled
- Transpilación: https://qollab.xyz/learn/docs/transpilation
- Primitivas: https://qollab.xyz/learn/docs/primitives
- Mitigación de error: https://qollab.xyz/learn/docs/error-mitigation
- Ideal vs. ruido: https://qollab.xyz/learn/docs/ideal-vs-noise-model-simulators
- Créditos: https://qollab.xyz/learn/docs/how-credits-work
- Errores: https://qollab.xyz/learn/docs/error-reference
- FAQ: https://qollab.xyz/learn/docs/faq

Cuando este contrato y la documentación difieran, **gana la documentación** y este archivo se
actualiza en el mismo cambio.

---

## 1. Anatomía del proyecto en Qollab

### 1.1. Tipo de proyecto (se decide por archivos, no por configuración)

En cada **Run**, Qollab inspecciona los archivos de nivel superior:

| Archivos de nivel superior | Tipo resultante |
| --- | --- |
| `index.html` **y** `main.js` | **JS project** (HTML/JS) |
| Si no, `main.py` | **Python project** |
| Ninguno de los dos | No se puede ejecutar (Run deshabilitado) |

Reglas obligatorias:

- Los archivos dentro de subcarpetas **no cuentan** (`app/main.py` **no** hace un proyecto Python).
- Si están los tres, gana **JS**.
- No hay ajuste para cambiar de tipo: se cambia añadiendo/quitando archivos.
- Este repo debe declarar explícitamente **cuál** de los dos es. *(Ver sección 9 — pendiente de decisión del owner.)*

### 1.2. Archivos especiales de nivel superior

- **`README.md`** → **no** es un archivo del proyecto: se convierte en el *write-up* (Project Card).
  Máximo 65.000 caracteres; si se pasa, la subida se rechaza. Al **añadir** archivos a un
  proyecto existente, `README.md` se **ignora** (el write-up se edita aparte).
- **`requirements.txt`** → define paquetes Python. Si falta, Qollab añade
  `qiskit>=2.5.2,<3.0.0`. Qiskit **siempre** está instalado.
- **`main.css`** → única hoja de estilos que carga el runtime (opcional).
- **`index.html`** → se inserta dentro del `<body>`; se descartan `<html>`, `<head>`, `<body>`.
  Los `<script>` **no** se ejecutan: el código va en `main.js`.

### 1.3. Subida y empaquetado

- Acepta **archivos sueltos**, **carpeta** o **un archivo** (archivo = comprimido).
- Archivos soportados: `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.tar.bz2`/`.tbz2`, `.tar.xz`/`.txz`.
- Una carpeta envoltorio única se elimina (p. ej. `mi-proyecto-main/` de un ZIP de GitHub).
- Se descarta basura: `.git`, `__MACOSX`, `.DS_Store`, `Thumbs.db`, nombres que empiezan por `._`.
- Si el proyecto ya tiene archivos, la subida pregunta **Keep and add** (reemplaza por ruta) o
  **Erase first** (borra todo; irreversible).

### 1.4. Límites duros de tamaño

| Límite | Valor |
| --- | --- |
| Archivos por proyecto | **100** |
| Tamaño por archivo | **2 MB** |
| Total por cuenta (todos los proyectos) | **200 MB** |

Un dataset > 2 MB **no** puede ser archivo de proyecto: se lee desde la web (sección 4.5).

---

## 2. El runtime

- **Python**: Pyodide (Python 3.14 + Qiskit 2.x, NumPy 2.x), compilado a WebAssembly, en el navegador.
- **JS**: corre en la página, en un iframe sandbox.
- Nada se instala en la máquina del usuario. Ningún código corre en servidor, **excepto** el job
  cuántico, que va a los servidores de IonQ cuando se elige un backend remoto/hardware.
- Requiere navegador con **WebAssembly JSPI** (Chrome/Edge/Opera recientes, Firefox 153+).
  Sin JSPI, Run queda deshabilitado.

### 2.1. La variable `backend` (obligatorio)

Qollab **pre-crea** `backend`. Quien pulsa **Run** elige el QPU en el diálogo **Select QPU**,
y el runtime lo entrega al código.

- Python: `backend` es un **global** en `main.py`. Pásalo como argumento a los módulos que lo necesiten.
- JS: está disponible en `main.js` y en cada archivo JS que importa. `await backend.run(circuit, { shots })`.

**PROHIBIDO** crear o hardcodear un backend propio, proveedor, o API key. Si lo haces, el
proyecto ignora la elección del diálogo.

`backend` es el objeto real del proveedor (no un wrapper de Qollab): built-in → `BasicSimulator`;
IBM → backend `Fake` del dispositivo; IonQ → `IonQProvider`. Nada intercepta `run()`.

### 2.2. Un job por run en IonQ

- **Simuladores locales** (built-in, AWS Braket local, IBM noise models): tantos `backend.run`
  como quiera el código en un mismo run.
- **IonQ** (simuladores remotos **y** hardware): **un solo job por run**. Un segundo job aborta
  el run con error.

Por tanto, en IonQ: manda **todos** los circuitos en **una** llamada a `backend.run`, o usa
**Stop** y luego **Run** de nuevo para otro job. La misma regla aplica al wrapper **Estimator**.

### 2.3. `main()` en Python (formulario de parámetros)

`main.py` corre de arriba a abajo y escribe stdout/stderr a la consola. `input()` **no funciona**.

Si defines `main()` que cumpla las reglas, el runtime lo **llama automáticamente** tras el script
(no lo llames tú, o corre dos veces). Reglas de la firma:

- `def main(` debe empezar **al inicio de la línea** y toda la firma en **una sola línea**.
- Cada parámetro lleva anotación `int`, `float`, `str` o `bool`.
- Los valores por defecto rellenan el formulario; el nombre del parámetro es la etiqueta.
- Si se rompe una regla (p. ej. `Optional[int]`, parámetro sin anotación), **no aparece formulario
  y `main()` no se llama**, sin aviso.

`shots: int` en `main()` se convierte en el campo **Shots** en **Run settings**.

### 2.4. Librerías Python (`requirements.txt`)

- Una por línea: `name==1.2.3` o rango `name>=1.0,<2`. Se permiten comentarios `#` y líneas vacías.
- **Rechazado**: opciones de pip (`-r`, `-e`, `--index-url`), marcadores de entorno
  (`; python_version …`) y requisitos por URL.
- Qiskit siempre instalado. Si `requirements.txt` no lo nombra, se añade `qiskit>=2.5.2,<3.0.0`;
  si lo nombras, se respeta tu línea.
- NumPy, SciPy, Matplotlib vienen con Pyodide: se cargan al importar, **no** se listan.
- Solo instala wheels **puro-Python** o builds de Pyodide. Paquetes con C compilado sin build
  de Pyodide rompen el run.
- Utiliza la lista **Libraries** del editor cuando aplique (mismas líneas que la tabla de la doc),
  p. ej. Qiskit Visualizations para dibujos `mpl`.

### 2.5. Red (solo lectura)

- **Permitido**: `GET` (`pyodide.http.pyfetch(url)` en Python, `fetch(url)` en JS).
- **Bloqueado**: `POST`, `PUT`, `DELETE` y todo salvo `OPTIONS`; `XMLHttpRequest`, `WebSocket`,
  web workers.
- El servidor debe permitir CORS; lo más seguro `Access-Control-Allow-Origin: *`.
  El proyecto JS corre sin origen propio: sus peticiones salen con origen `null`.
- No se envían cookies ni credenciales a otros sitios.
- **Nunca** pongas secretos en el código (es público al publicar).
- El núcleo del proyecto debe seguir funcionando **sin** servicios externos.

### 2.6. Importar archivos propios

- Python: root del proyecto = directorio de trabajo y primer `sys.path`. `import extra.helpers.common`
  funciona; imports relativos **no** funcionan dentro de `main.py`.
- Un archivo propio con el mismo nombre que un paquete instalado **gana**.
- JS: importa con `./` o `../`; el runtime prueba la ruta exacta, luego `.js`/`.mjs`,
  luego `index.js`/`index.mjs`. Otros tipos no se importan.
- `main.js` puede importar Python (propio o instalado) por **nombre de módulo punteado**:
  ```js
  import * as qt from 'quantum.pipeline';      // tu quantum/pipeline.py

  // Python corre el circuito con el `backend` real que Qollab inyecta
  const q = (await qt.run_backend.callPromising(backend, 1024, 3, 150, '1adc', null, null, 'geom')).toJs();
  // ... y al final del módulo, mantén la ejecución viva (ver abajo):
  await new Promise(() => {});
  ```
  Usa `.callPromising`, o `.callPromisingKwargs` para kwargs.
  Usa **imports con nombre** o `import * as`; un import por defecto da `undefined`.
  Un paquete Python que solo importa tu JS **no** se instala solo: añádelo a `requirements.txt`
  (incluidos `numpy`/`scipy`, aunque vengan con Pyodide).
  **`null`/`undefined` de JS llegan a Python como `JsNull`/`JsUndefined` (un `JsProxy`), no como
  `None`.** No los compares con `is None`: normalízalos (p. ej. un helper que mapee esos nombres
  de tipo a `None`) antes de usarlos, o el argumento revienta con
  `float() argument must be ... not 'JsNull'`.
  **Mantén la ejecución viva**: termina `main.js` con `await new Promise(() => {})`. Qollab
  desmonta el runtime —y su `backend` ya autenticado— en cuanto el script de nivel superior
  acaba; un job enviado después (p. ej. al pulsar ▶ Run) queda **fuera de la ejecución** y falla
  (`Failed to fetch`, `401`, o "la ejecución acaba antes de ejecutar ningún job"). Con la promesa
  colgada, Python y `backend` siguen disponibles hasta que el usuario pulse **Stop**. Es lo que
  hace el proyecto de referencia `Optogenetic Quantum Brain`.
  `backend.run(...)` **desde Python** es correcto: `backend` es el objeto real del proveedor y
  Qollab no intercepta `run()`. Qollab dibuja el circuito por su cuenta (panel *Circuit* de las
  runs IonQ), así que **no** hay que dibujarlo en la UI.

### 2.7. Archivos de datos (crítico)

Python puede leer archivos del proyecto con `open`, `pathlib`, `numpy.loadtxt`, `pandas.read_csv`.

- La ruta debe aparecer como **string literal** en el código Python, relativa al root.
- Solo se cargan los archivos que el código **nombra literalmente**.
  ```python
  DATA = "data/measurements.csv"     # SÍ se carga
  open(DATA).read()
  open(f"data/{name}.csv")           # NO se carga
  ```
- El string puede estar en `main.py` o en un módulo importado; no tiene que estar dentro de `open()`.
- Rutas con f-string, `+` u `os.path.join` **no** se detectan → `OSError`.
- **JS no puede leer archivos del proyecto**: lee en un módulo Python y devuélvelo a `main.js`.

### 2.8. Sin persistencia

- No hay almacenamiento entre runs. Los archivos que escribe Python duran hasta el fin del run.
- En JS, `localStorage`, `sessionStorage`, IndexedDB y cookies **no** existen.
- Para estado guardado, envíalo como archivo de proyecto (p. ej. `states/demo.json`) y cárgalo al inicio.

### 2.9. HTML y CSS

- `index.html` = solo contenido de `<body>`. `<script>` no corre.
- `main.css` opcional; es la única hoja de estilos cargada. Otros `.html`/`.css` **no** se cargan.
- En JS, `console.log` escribe en la consola inferior; cada argumento en su línea como texto
  (un objeto sale `[object Object]`): usa `JSON.stringify`.

### 2.10. Salida de figuras y archivos (Python)

- `plt.show()` muestra el figure como SVG. `plt.savefig("result.png")` lo muestra y ofrece PNG
  como descarga; **nada** se escribe a disco.
- `circuit.draw("mpl", filename="circuit.png")` igual.
- Para volcar otro archivo a la consola: `from js import sendFile` y `sendFile(name, content_type, data)`.

---

## 3. Backends y costos

Tres grupos en **Select QPU**:

1. **Simuladores locales** (en el navegador, gratis, sin cola): built-in (24 qubits),
   AWS Braket local (25), e IBM noise models (Boston, Kingston, Pittsburgh, Fez, Marrakesh,
   Miami, Aachen, Berlin; 120–156 qubits).
2. **Simuladores remotos** (nube de IonQ, gratis, modelo de ruido): IonQ Aria 1/2, Forte 1,
   Forte Enterprise 1.
3. **Computadoras cuánticas** (hardware IonQ Forte 1 / Forte Enterprise 1, 36 qubits):
   consumen **créditos**; solo si está online.

Reglas:

- Los simuladores son **gratis**. Solo el hardware gasta créditos.
- El runner tiene un tope editable **"Allow running if it doesn't exceed N credits"**
  (por defecto 1/10 del saldo). Por encima, pide confirmación.
- La cifra es **estimada**; al terminar se muestra el **actual** retirado.
- Los conteos de qubits son **techos**, no garantías.
- La lista de máquinas vivas cambia: **el diálogo es la verdad** de qué hay disponible.

Flujo recomendado (obligatorio antes de gastar créditos):

1. Validar la lógica en el **built-in simulator** (ideal, instantáneo).
2. Ver ruido en un **IBM noise model** o **IonQ remote** (gratis).
3. Antes de hardware IonQ, correr el **simulador remoto equivalente**.
4. Solo entonces hardware.

---

## 4. Ejecución y transpilación

- **No** hace falta llamar a `transpile()` antes de enviar a IonQ: el runner entrega el circuito
  tal cual y IonQ compila en su lado.
- El conteo de puertas **escrito** ≠ el **compilado**. IonQ descompone multicúbit, convierte a
  nativas, elimina redundancia y optimiza. `TooManyGates` usa el conteo **compilado**.
- Si llamas `transpile()` para IonQ, usa `optimization_level=1` (o `0`) para evitar
  `IonQTranspileLevelWarning` (re-síntesis agresiva). La advertencia no es error.
- El built-in y los IBM noise models **rechazan** `PauliEvolutionGate` sin transpilar
  (`unrecognized operation` / `unknown instruction`): transpila primero.
- Los IBM reescriben a `rz`, `sx`, `x`, `cz`.
- Puertas nativas de IonQ: `GPi`, `GPi2`, Virtual Z, `MS` (Aria), `ZZ` (Forte). Un circuito debe
  usar **un solo gateset**: no mezcles nativas y abstractas.
- Normalmente **no** escribas puertas nativas: usa la interfaz abstracta salvo investigación
  explícita (caracterización de ruido, mitigación, compilación).
- `transpile()` no envía job ni gasta créditos.

### 4.1. Primitivas

- **Sampler** (`BackendSamplerV2`): solo simuladores locales e IBM noise models. **No** funciona
  en IonQ (no devuelve `memory`; llena todo con 0 sin error). En IonQ, muestrea con
  `backend.run(...).result().get_counts()`.
- **Estimator** (`BackendEstimatorV2`): funciona en **todos**, incluido IonQ (trabaja por conteos).
  Observables con `SparsePauliOp`. En IonQ, **una** llamada por run con todos los pares
  (circuito, observable) dentro.
- Counts se indexan por el nombre del registro clásico (`c` por defecto). En JS usa `.get(0)` y `.toJs()`.

### 4.2. Mitigación de error (debiasing) y sharpening

- Debiasing es de IonQ (no del simulador de nube de IonQ). En puertas estándar: **ON por defecto
  a ≥ 500 shots**; por debajo se desactiva y no se puede activar. Default de shots = **1024**.
- Se controla en código: `backend.run(qc, shots=1000, error_mitigation=ErrorMitigation.NO_DEBIASING)`.
- Con puertas nativas el default se invierte (OFF por defecto).
- **Sharpening** (plurality voting) es opt-in al recuperar el resultado:
  `job.result(sharpen=True).get_counts()`. Solo para distribuciones con uno o pocos estados
  dominantes; **no** usarlo para cuantificar probabilidades relativas.

### 4.3. Ideal vs. ruido (tiempos)

- **Ideal** (built-in, AWS Braket local): el tiempo no depende del número de shots.
  Úsalos para validar; sube shots libremente.
- **Noise model** (IBM local, IonQ remoto): el tiempo crece con los shots (una simulación por shot;
  IonQ corre una por shot). Empieza con ~100 shots.
- Aer puede cambiar a matriz de densidad al pasar `2^n` shots (deja de escalar con shots).
- Si un run con ruido tarda demasiado: **baja shots** o **reduce profundidad** primero.

---

## 5. Límites, errores y diagnóstico

- Un run **no tiene límite de tiempo**; **Stop** lo termina (Python tiene 5 s para cerrar).
- `Power-of-two` etc.: consulta https://qollab.xyz/learn/docs/error-reference.
- Resultados raros/noisy: https://qollab.xyz/learn/docs/why-your-results-look-wrong.
- FAQ: https://qollab.xyz/learn/docs/faq.

---

## 6. Reglas de ingeniería para este repo

1. **Portabilidad Qollab**: todo debe poder subirse a Qollab y correr sin cambios.
2. **Sin dependencias ocultas**: cualquier paquete Python va en `requirements.txt`; cualquier
   paquete JS de terceros se importa por **URL completa** (excepto `three`, `three/addons/…`,
   `postprocessing`, `@tweenjs/tween.js`, `meshline`, que están bundleados).
3. **Rutas de datos literales**: nunca construyas rutas dinámicamente para archivos del proyecto.
4. **Un job por run en IonQ**: diseñar agregando circuitos en una sola llamada / un solo Estimator.
5. **Sin secretos** en el repo.
6. **Sin estado persistente** asumido.
7. **Todo lo grande (>2 MB) viene de la red** con GET y se procesa por chunks.
8. **`main()` monolínea** y con anotaciones `int|float|str|bool` cuando se exponga formulario.
9. **`README.md` = write-up**, no un archivo de runtime; mantenlo bajo 65.000 caracteres.
10. **Estructura plana de entrada**: `main.py` **o** (`index.html` + `main.js`) en la raíz.
    El código de apoyo vive en subcarpetas.

### Tooling local (no se sube a Qollab)

`dev/` y `scripts/` existen solo para desarrollo local. **No forman parte del proyecto en
Qollab** y nunca deben alterar el comportamiento de los archivos de runtime:

- `dev/preview.html` — mock del runtime para previsualizar la UI en local.
- `dev/model.json` — modelo mock exportado (generado por `scripts/export-model.sh`).
- `scripts/preview.sh` — servidor estático para la vista local.
- `scripts/export-model.sh` — regenera `dev/model.json` (intenta el pipeline real; cae al
  mock). Acepta `PYTHON=/ruta/bin/python` para usar un intérprete con qiskit/scipy.
- `scripts/check_fastqaoa.py` — verifica que `quantum/fastqaoa.py` reproduce a `quantum/qaoa.py`.
- `scripts/package.sh` — genera un `.zip` solo con los archivos de runtime para subir.

`engine.js` sí es archivo de runtime (lo importa `main.js` con `./engine.js`).

Al empaquetar/subir, excluir `dev/`, `scripts/` y `AGENTS.md`.

---

## 7. Estructura de referencia

**Tipo elegido para QuietTracE: híbrido — UI en JS con núcleo cuántico en Python** (ver sección 9).

```
index.html               # solo contenido de <body>
main.css                 # única hoja cargada (opcional)
main.js                  # punto de entrada JS; llama al pipeline Python
engine.js                # motor de render (SVG); importado con './engine.js'
quantum/pipeline.py      # une modelo + QAOA; devuelve el contrato del motor
quantum/modelo.py        # modelo del equipo (recortado: sin helpers sin usar)
quantum/qaoa.py          # QAOA de referencia (movido de main.py)
quantum/fastqaoa.py      # QAOA rápido NumPy (lo usa el pipeline)
quantum/capacitance.py   # pesos W_ij desde C'_m de COMSOL (fuente de pesos opcional)
quantum/comsol_capacitance.csv  # calibración COMSOL 6.1 (11 puntos, 0.2–4 mm)
quantum/pcb.py           # modelo MOCK (modo demo / respaldo)
requirements.txt         # paquetes Python (Qiskit)
README.md                # write-up (Project Card)
```

**El QAOA ya está integrado** (no hay que reimplementarlo). `main.py` se movió a
`quantum/qaoa.py`; su código se conserva para auditar. El pipeline usa `quantum/fastqaoa.py`
por rendimiento (el navegador no tolera `QAOAAnsatz + Statevector`).

Referencia para los otros dos tipos:

Proyecto **Python/Qiskit**:

```
main.py                  # punto de entrada, usa `backend` global
requirements.txt         # dependencias (Qiskit siempre)
README.md                # write-up (Project Card)
<paquete>/               # módulos propios importables
data/                    # archivos de datos < 2 MB, rutas literales
```

Proyecto **JS/Qiskit**:

```
index.html               # solo contenido de <body>
main.css                 # opcional, única hoja cargada
main.js                  # punto de entrada, usa `backend` global
requirements.txt         # para paquetes Python que JS importe
README.md                # write-up
<paquete>/               # módulos Python y/o JS
data/                    # datos para Python (< 2 MB)
```

---

## 8. Definición de "Terminado" (Definition of Done)

Un cambio no está terminado hasta que:

- [ ] Corre en el **built-in simulator** sin errores (ideal).
- [ ] La estructura de archivos de la sección 7 se respeta.
- [ ] No hay secretos ni dependencias no declaradas.
- [ ] Se respetan los límites (100 archivos, 2 MB/archivo, 200 MB).
- [ ] Si toca IonQ: **un** job por run; el usuario no gastó créditos sin querer.
- [ ] El `README.md` (write-up) describe cómo usarlo.
- [ ] Si la doc de Qollab cambió, este contrato se actualizó.

---

## 9. Decisiones del owner (fijadas 2026-10-10)

1. **Tipo de proyecto: híbrido — UI en JS + núcleo en Python.** `index.html` + `main.js`
   en la raíz (proyecto JS), con la física en módulos Python (`quantum/…`) importados por
   `main.js` vía `callPromising`. Ver estructura en sección 7.
2. **Alcance:** QuietTracE optimiza la **asignación de capas** (L1/L4) de las 9 redes de una
   PCB **ADC08060 → FPGA** con **QAOA**, ya integrado:
   `quantum/pipeline.py` (modelo + QAOA) → `engine.js` (visualización). El modelo del equipo
   vive en `quantum/modelo.py` (del equipo; recortado, sin helpers sin usar); `main.py` se movió a
   `quantum/qaoa.py` y el pipeline usa `quantum/fastqaoa.py` (NumPy, exacto y rápido).
   La optimización corre **localmente con statevector** (sin `backend`, sin jobs, sin
   créditos). `quantum/pcb.py` queda como modelo **mock** (demo/respaldo).
   **Fuente de pesos conmutable:** `W` geométrico (`modelo.geometric_weights`) o `W` de
   **COMSOL** (`quantum/capacitance.py`, integrando `C'_m` de `quantum/comsol_capacitance.csv`);
   se elige con `wsource="geom"|"comsol"` en el pipeline y con **Weights: Geometric / COMSOL**
   en la UI. La validación (interpolación/extrapolación, `W_geom` vs `W_COMSOL`, barrido de
   `λv`) vive en el notebook, no en la app.
3. **Entrada de datos:** archivos del proyecto en el repo, siempre **< 2 MB** y con **rutas
   literales** en Python. Un dataset mayor iría por GET desde la web (sección 2.5).
4. **Nombre de proyecto/usuario en Qollab:** pendiente (para el enlace público).

*(Se refinará a medida que el owner entregue el alcance completo.)*

---

Última actualización: 2026-10-10 · Mantenedor: dihnömetry (LICENSE).

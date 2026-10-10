# QuietTracE

Proyecto **híbrido** que corre en [Qollab](https://qollab.xyz): interfaz en JavaScript
con el núcleo cuántico en Python (Qiskit). Todo se ejecuta en el navegador.

> **Antes de escribir código, lee [`AGENTS.md`](./AGENTS.md).**
> Es el contrato de desarrollo vinculante: reglas de runtime de Qollab, límites, backends,
> ejecución y definición de "terminado". Rige para cualquier agente o persona.

## Cómo funciona

`main.js` importa el módulo Python `quantum/bell.py` y lo llama con `.callPromising`,
pasándole el objeto `backend` que Qollab pre-crea. Quien pulsa **Run** elige el QPU en el
diálogo **Select QPU**; el código nunca lo fija.

```
index.html     -> página (solo contenido de <body>)
main.css       -> estilos (única hoja cargada)
main.js        -> punto de entrada; usa `backend` global
quantum/bell.py-> circuito de Bell en Qiskit; devuelve conteos
requirements.txt
```

## Ejecutar

1. Sube el proyecto a Qollab (project shape **Upload your own files**).
2. Pulsa **Run Project** → **Run**.
3. En **Select QPU**, empieza por el **built-in simulator** (ideal, gratis, instantáneo).
4. Los conteos del estado de Bell aparecen en la tarjeta y en la consola.

Estado actual: esqueleto mínimo (estado de Bell). El alcance completo se añadirá después.

## Ver en local

El código de producción depende del runtime de Qollab (`backend` inyectado y Python vía Pyodide),
así que en local no se ejecuta igual. Para previsualizar la interfaz:

```sh
./scripts/preview.sh        # abre http://localhost:8000/dev/preview.html
```

La vista local es un **mock** (conteos de ejemplo, sin `backend` real).

## Empaquetar para subir a Qollab

```sh
./scripts/package.sh        # genera /tmp/quiettrace-qollab.zip
```

Incluye solo los archivos de runtime (`index.html`, `main.css`, `main.js`, `quantum/`,
`requirements.txt`, `README.md`, `LICENSE`); excluye `dev/`, `scripts/` y `AGENTS.md`.

## Documentación de referencia

- Runtime: https://qollab.xyz/learn/docs/runtime-environment
- Subida de archivos: https://qollab.xyz/learn/docs/upload-your-files
- Ejecutar código: https://qollab.xyz/learn/docs/run-your-code
- Proyectos JS/Qiskit: https://qollab.xyz/learn/docs/js-qiskit-projects

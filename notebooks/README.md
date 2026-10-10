# QuietTracE — experiments

Notebook para iterar el **modelo + QAOA** fuera de Qollab, con vuestro entorno Python.

```bash
# dependencias
pip install qiskit scipy numpy matplotlib
# opcionales (secciones 6 y 7):
pip install qiskit-aer qiskit-ionq

# abrir
jupyter lab notebooks/quiettrace_experiments.ipynb
```

Para la sección de **IonQ**: `export IONQ_API_KEY=...` antes de ejecutarla.

Cuando un experimento funcione, se integra en `quantum/pipeline.py` y el visor (`engine.js`).

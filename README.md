# QuietTracE

Quantum **layer assignment** (L1/L4) for an **ADC–FPGA** PCB, running on
[Qollab](https://qollab.xyz). Hybrid **JS + Python** project.

> **Development contract:** read [`AGENTS.md`](./AGENTS.md) before touching the code.

## What it does

1. **Model** (`quantum/modelo.py`) — builds the 9 nets (`D0`–`D7`, `CLK`), their routes,
   the geometric **conflicts** and the coupling weights `W`.
2. **QAOA** (`quantum/fastqaoa.py`) — runs QAOA on the model's Ising `J,h` (same ansatz as
   `main.py`), optimized with COBYLA.
3. **Result + charts** — the best feasible assignment is drawn on the PCB (before/after),
   with a cost breakdown, a possible-configurations histogram and a coupling matrix, plus a
   per-iteration solution evolution.

The coupling weights `W` can come from either the **geometric heuristic**
(`modelo.geometric_weights`) or the **COMSOL 6.1 mutual capacitance**
(`quantum/capacitance.py`, integrating `C'_m(s)` from `quantum/comsol_capacitance.csv`,
`w_ij = 1/C_ref · ∫ C'_m ds`). Switch between them with **Weights: Geometric / COMSOL**.
Verified on the example model: best solution = `001010010`, cost **7.049177** (geometric,
equal to the exact optimum) / **3.1837** (COMSOL). Layers: `L1: D0,D1,D3,D5,D6,CLK` ·
`L4: D2,D4,D7`.

## UI (English)

- **Summary chips:** *Qubits*, *Circuit cost (baseline → after QAOA)* and *Cost reduction*.
- **PCB:** 3D stackup / 2D plan (`BEFORE` = all lines on L1, `AFTER` = QAOA solution).
- **Solution evolution:** one mini-PCB per iteration (best-so-far).
- **Problem tabs:** switch between **1 ADC (9 qubits)** and **2 ADC (18 qubits)**.
- **Weights:** switch between the **Geometric** heuristic and the **COMSOL 6.1** mutual
  capacitance (quasi-electrostatic proxy) — same QAOA, so you can compare how the layer
  assignment changes when the weights go from a geometric heuristic to an electrostatic estimate.
- **Depth p** and **Conflict weight** are auto-set per problem (from the notebook sweeps):
  **1 ADC → p=3, ×1** (valid mass 0.59) and **2 ADC → p=3, ×5** (only **2 of 262 144** states are
  feasible at 18 qubits, so ×1 leaves QAOA with ~0 feasible mass; ×5 lifts it to ~0.6%, ≈18 valid
  samples at 3072 shots). `p=5` is ~15% better at 18 qubits but ~5× slower, so both keep `p=3`.
  At **9 qubits** more conflict weight *hurts* (valid mass drops from 0.59 to ~0.04 at ×8).
- **Connections:** edit the **ADC→FPGA order** (comma-separated net names, e.g.
  `D2,D4,D0,D1,D3,D5,D7,D6,CLK`). It rebuilds conflicts/weights and redraws. An order whose
  conflict graph is not 2-colorable falls back to the default (shown in the UI). (For 18 qubits
  the exact reference is skipped: 2^18 enumeration is costly.)
- **Charts:** *Cost breakdown*, *Circuit distribution*, *QAOA convergence* (energy per
  iteration), *Possible configurations* (log/linear toggle) and *Coupling matrix*.
- **QAOA convergence is the ideal optimization trace (local simulation)**, not the backend
  result.
- Each chart has an **expand (⤢)** button that opens it larger in a modal.
- **When a backend exists**, the local view is not painted until the job returns. Then the
  charts use that backend's counts: *Circuit distribution* shows **ideal vs backend** (grey =
  ideal, green = valid backend, red = conflict backend), and
  *Cost breakdown* (after) + the after-board come from the backend. The optimization trace
  (*QAOA convergence*, *evolution*) stays local.
- **Noise shows up in:** the *ideal vs backend* distribution, the **Model distance (TVD)**,
  **Success rate** (ideal → backend) and **Valid** chips, and the dashed **measured ⟨H_C⟩**
  line on the convergence chart. (The reported *best feasible* solution is robust: it is
  post-selected, so moderate noise leaves it unchanged.)
- **QPU run:** see below.

## Run on a QPU

In Qollab, pick a backend in **Select QPU**. The pipeline optimizes **locally**, then submits
**one** QAOA circuit with `backend.run` inside Python — the `backend` Qollab injects is the real
provider object, and Qollab does not intercept `run()`. `main.js` ends with
`await new Promise(() => {})` to **keep the run alive**: Qollab tears down the runtime (and its
authenticated `backend`) as soon as the top-level script finishes, so a job sent later — from the
▶ Run button — would run *outside* the run and fail. Press **Stop** to end the run. Qollab enforces
*one job per run* on IonQ and draws the submitted circuit in its own **Circuit** panel. Simulators
run in your browser or on IonQ's cloud and are **free**; only the IonQ quantum computers spend
**credits**. A local preview has no backend, so the QPU section stays empty.

## Structure

```
index.html            # UI (body content only)
main.css              # styles (theme)
main.js               # JS entry -> quantum/pipeline.py + engine.js
engine.js             # SVG render engine (PCB 2D/3D, charts)

quantum/
  modelo.py           # team MODEL (trimmed: unused helpers removed)
  qaoa.py             # reference QAOA: moved from main.py (QAOAAnsatz + Statevector)
  fastqaoa.py         # fast exact NumPy QAOA (used by the pipeline)
  pipeline.py         # model + QAOA -> the engine's data contract
  capacitance.py      # COMSOL-calibrated capacitive weights W_ij (optional weight source)
  comsol_capacitance.csv  # COMSOL 6.1 C'_m calibration (11 gaps, 0.2–4 mm)
  pcb.py              # MOCK model (demo / fallback)
requirements.txt      # Python deps (Qiskit)
```

The COMSOL curve, its log-log interpolation / power-law tail and the `W_geometric` vs
`W_COMSOL` comparison (plus a `λ_v` sweep) are validated in
`notebooks/quiettrace_experiments.ipynb` (section 9).

`main.py` was moved to `quantum/qaoa.py` (kept for auditing). The pipeline uses
`quantum/fastqaoa.py` because `QAOAAnsatz + Statevector` is ~1000× slower and not viable in a
browser.

## Local preview & packaging

Two local options:

```bash
# 1) Static mock (fast, no Python): shows a fixed dev/model.json
PYTHON=/path/to/python/with/qiskit ./scripts/export-model.sh
./scripts/preview.sh                      # http://localhost:8000/dev/preview.html

# 2) Dynamic local app (runs the pipeline in Python; controls work)
PYTHON=/path/to/python/with/qiskit ./scripts/dev.sh   # http://localhost:8000/dev/app-local.html
```

Option (2) serves the **real** UI (`main.js`) with a shim that calls `quantum/pipeline.py` over
HTTP — so the problem tabs and the connection order all work locally without
Qollab/Pyodide. It needs a Python with `qiskit`, `numpy`, `scipy`.
./scripts/package.sh                                           # -> /tmp/quiettrace-qollab.zip
```

`package.sh` includes only the runtime files (`index.html`, `main.css`, `main.js`, `engine.js`,
`quantum/`, `requirements.txt`, `README.md`, `LICENSE`). Upload that zip in Qollab
(**Upload your own files**) and press **Run**.

## Benchmark

`scripts/benchmark.py` (dev-only, not uploaded) compares the QAOA statevector against
classical search on the **same** penalized cost `C(x)`: feasible-only **greedy local search**
and **simulated annealing** (with a call budget) vs **QAOA** (unconstrained; reports both
success and feasibility probability). It enumerates the exact optimum for reference.

```bash
python -m scripts.benchmark --kind both --wsource comsol --runs 10 --shots 1024
python -m scripts.benchmark --kind 2adc --cmult 5 --runs 10 --shots 3072
```

`--cmult` multiplies the conflict penalty (the UI **Conflict weight**); at 18 qubits ×5 is the
interesting setting (see above). Results are written to a CSV.

## Theme

Single **Hybrid** theme: crisp borders + green-on-black palette with an Aero-style glow and
liquid glass.

## Docs

- Runtime: https://qollab.xyz/learn/docs/runtime-environment
- JS/Qiskit projects: https://qollab.xyz/learn/docs/js-qiskit-projects
- Uploading files: https://qollab.xyz/learn/docs/upload-your-files

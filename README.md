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

Verified on the example model: best solution = `001010010`, cost **7.049177** (equal to the
exact optimum). Layers: `L1: D0,D1,D3,D5,D6,CLK` · `L4: D2,D4,D7`.

## UI (English)

- **Summary chips:** *Qubits*, *Circuit cost (baseline → after QAOA)* and *Cost reduction*.
- **PCB:** 3D stackup / 2D plan (`BEFORE` = all lines on L1, `AFTER` = QAOA solution).
- **Solution evolution:** one mini-PCB per iteration (best-so-far).
- **Problem tabs:** switch between **1 ADC (9 qubits)** and **2 ADC (18 qubits)**, and set the
  QAOA **initial state** angle (0–180°, default 90° = |+⟩). Changing either re-runs and redraws.
  (For 18 qubits the exact reference is skipped: 2^18 enumeration is costly.)
- **Charts:** *Cost breakdown*, *Circuit distribution*, *QAOA convergence* (energy per
  iteration), *Possible configurations* (log/linear toggle) and *Coupling matrix*.
- **QAOA convergence is the ideal optimization trace (local simulation)**, not the backend
  result. A **Local sampling** panel (slider + exact number input, 0–2000 shots) resamples the
  ideal distribution and draws the **sampled PCB**, so you can compare it with the main one
  (at few shots it may miss the optimum) — it runs no QPU job.
- Each chart has an **expand (⤢)** button that opens it larger in a modal.
- **When a backend exists**, the local view is not painted until the job returns. Then the
  charts use that backend's counts: *Circuit distribution* shows **ideal vs backend**, and
  *Cost breakdown* (after) + the after-board come from the backend. The optimization trace
  (*QAOA convergence*, *evolution*) stays local.
- **Noise shows up in:** the *ideal vs backend* distribution, the **Model distance (TVD)**,
  **Success rate** (ideal → backend) and **Valid** chips, and the dashed **measured ⟨H_C⟩**
  line on the convergence chart. (The reported *best feasible* solution is robust: it is
  post-selected, so moderate noise leaves it unchanged.)
- **QPU run:** see below.

## Run on a QPU

In Qollab, pick a backend in **Select QPU**. The pipeline optimizes **locally**, then sends
**one** QAOA circuit to the chosen backend (Qollab enforces *one job per run* on IonQ) and
renders the measured counts and their validity. A local preview has no backend, so that section
stays empty.

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
  pcb.py              # MOCK model (demo / fallback)
requirements.txt      # Python deps (Qiskit)
```

`main.py` was moved to `quantum/qaoa.py` (kept for auditing). The pipeline uses
`quantum/fastqaoa.py` because `QAOAAnsatz + Statevector` is ~1000× slower and not viable in a
browser.

## Local preview & packaging

```sh
PYTHON=/path/to/python/with/qiskit ./scripts/export-model.sh   # dev/model.json (real QAOA)
./scripts/preview.sh                                           # http://localhost:8000/dev/preview.html
./scripts/package.sh                                           # -> /tmp/quiettrace-qollab.zip
```

`package.sh` includes only the runtime files (`index.html`, `main.css`, `main.js`, `engine.js`,
`quantum/`, `requirements.txt`, `README.md`, `LICENSE`). Upload that zip in Qollab
(**Upload your own files**) and press **Run**.

## Theme

Single **Hybrid** theme: crisp borders + green-on-black palette with an Aero-style glow and
liquid glass.

## Docs

- Runtime: https://qollab.xyz/learn/docs/runtime-environment
- JS/Qiskit projects: https://qollab.xyz/learn/docs/js-qiskit-projects
- Uploading files: https://qollab.xyz/learn/docs/upload-your-files

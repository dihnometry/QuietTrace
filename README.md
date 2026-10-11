# QuietTrace

**Quantum layer assignment to reduce crosstalk on a PCB.**
QuietTrace decides which signal lines of an ADC→FPGA bus go on the top layer (L1) and which on the bottom layer (L4), so that lines that couple strongly end up on different layers. The problem is written as an Ising/QUBO cost and solved with **QAOA**, running on [Qollab](https://qollab.xyz) (simulators or IonQ hardware).

> **This effort is supported by Qollab & IonQ**

<p align="center">
  <img src="docs/pcb_after.jpeg" alt="PCB after QAOA layer assignment: L1 in green, L4 in pink, L2 and L3 are ground planes" width="720">
</p>
<p align="center"><em>Example output: 2 ADCs (8 bits each) → FPGA receiver. L1 (green) and L4 (pink) carry signals; L2 and L3 are ground planes.</em></p>

---

## The problem in one minute

- Two nearby parallel traces on the same layer couple electromagnetically (**crosstalk**). The longer they run together and the closer they are, the worse it gets.
- Each net (`D0`–`D7`, `CLK`, per ADC) is assigned to **L1 or L4**, one qubit per net.
- Two nets whose routes **cross** must be on different layers (a hard constraint, handled as a penalty).
- Goal: minimize the total coupling between nets that share a layer.

Written as a cost over binary variables `x_i ∈ {0,1}` (0 = L1, 1 = L4):

```
C(x) = Σ_{i<j}  W_ij · [x_i = x_j]  +  λ · Σ_{(i,j) ∈ conflicts} [x_i = x_j]
```

`W_ij` is the coupling weight between nets _i_ and _j_, `λ` is the conflict penalty (the **Conflict weight** in the UI). This maps to an Ising Hamiltonian `H = Σ J_ij Z_i Z_j + Σ h_i Z_i`, which is the cost operator used by QAOA.

## Where the weights come from

The coupling weights `W_ij` come from **COMSOL 6.1 mutual capacitance**. We simulated the mutual capacitance per unit length `C'_m(s)` as a function of the spacing `s` between two traces (11 gaps, 0.2–4 mm, in `quantum/comsol_capacitance.csv`). For each pair of nets, the weight integrates it along the length where the two routes run together:

```
w_ij = (1 / C_ref) · ∫ C'_m(s) ds
```

(`quantum/capacitance.py`, log-log interpolation between simulated gaps and a power-law tail beyond them.) Qollab uses only these COMSOL weights. A purely geometric heuristic (`modelo.geometric_weights`) is still in the code as a fallback for the local dev preview.

The COMSOL weights are a **quasi-electrostatic proxy**: they capture capacitive coupling only. Inductive coupling and signal rise times are not modeled.

## Results

Benchmark of QAOA against classical search on the **same penalized cost**, with COMSOL weights, a budget of 150 evaluations and 10 independent runs per method (`scripts/benchmark.py`, raw data in `benchmark_results.csv`). The conflict weight follows the defaults described under _Settings_: ×1 for 1 ADC and ×5 for 2 ADC (3 072 shots). QAOA is run as an exact statevector **simulation**, not on a quantum computer. _Success_ means the method returned the exact optimum.

| Problem           | Method              | Success | Median time | Best cost |
| ----------------- | ------------------- | ------- | ----------- | --------- |
| 1 ADC (9 qubits)  | Greedy local search | 10 / 10 | 1.3 ms      | 3.1837    |
|                   | Simulated annealing | 10 / 10 | 2.0 ms      | 3.1837    |
|                   | **QAOA**            | 10 / 10 | 134 ms      | 3.1837    |
| 2 ADC (18 qubits) | Greedy local search | 10 / 10 | 2.5 ms      | 9.4368    |
|                   | Simulated annealing | 10 / 10 | 2.5 ms      | 9.4368    |
|                   | **QAOA**            | 8 / 10  | 8.9 s       | 9.4368    |

What the numbers say:

- **Solution quality:** every method that succeeds finds the same optimum, equal to the exact one. The best assignment for 1 ADC is `001010010` (L1: D0, D1, D3, D5, D6, CLK · L4: D2, D4, D7).
- **Time:** the classical methods stay in the millisecond range for both sizes. QAOA is about 70× slower at 9 qubits and about 3 500× slower at 18 qubits, because a statevector simulation grows as 2^n (from 0.13 s to 8.9 s, roughly 66×, when going from 9 to 18 qubits). At 18 qubits one circuit evaluation takes about 60 ms, and the optimizer used between 80 and 150 evaluations per run.
- **QAOA probabilities:** at 9 qubits, the median probability of sampling a feasible assignment is 29% and of sampling the optimum is 2.6%. At 18 qubits only 2 of 262 144 states are feasible (and both are optimal), so the probability of sampling a valid assignment drops to a median of 0.15% (range 0.0008%–0.38%), about 5 valid samples out of 3 072 shots. The 2 failed runs are those where no feasible sample was drawn.

In short: for problems this small, classical search is faster and just as accurate. The value of QuietTrace is the formulation, the physics-based weights and a working QAOA pipeline that runs on Qollab and IonQ, not a speedup.

## How it works

```
modelo.py ──► nets, routes, conflicts, weights W
                │
                ▼
          Ising J, h ──► fastqaoa.py (QAOA, COBYLA) ──► best feasible assignment
                                                            │
                                                            ▼
                                            engine.js: PCB before/after + charts
```

1. **Model** (`quantum/modelo.py`): builds the 9 nets per ADC, their routes, the geometric conflicts and the weights `W`.
2. **QAOA** (`quantum/fastqaoa.py`): exact NumPy simulation of the QAOA ansatz on the Ising `J, h`, optimized with COBYLA. The reference implementation with Qiskit's `QAOAAnsatz` is kept in `quantum/qaoa.py` for auditing; the fast version is used because the Qiskit statevector path is far too slow in the browser.
3. **Result**: the best _feasible_ sample (no conflict violated) is drawn on the PCB as BEFORE (all lines on L1) vs AFTER, with cost breakdown, circuit distribution, convergence, a possible-configurations histogram and the coupling matrix.
4. **On hardware**: after local optimization, one QAOA circuit is submitted with `backend.run` (IonQ allows one job per run). The UI then shows ideal vs backend distributions.

### Settings

| Setting             | Meaning                                                | Defaults (dev preview)   |
| ------------------- | ------------------------------------------------------ | ------------------------ |
| **Depth p**         | Number of QAOA layers                                  | 1 ADC → p=3, 2 ADC → p=3 |
| **Conflict weight** | Multiplier for the crossing penalty λ                  | 1 ADC → ×1, 2 ADC → ×5   |
| **Problem**         | 1 ADC (9 qubits) or 2 ADC (18 qubits)                  | —                        |
| **Connections**     | ADC→FPGA net order, e.g. `D2,D4,D0,D1,D3,D5,D7,D6,CLK` | default order            |

Why those defaults: at 18 qubits only 2 of 262 144 states are feasible, so with ×1 QAOA puts almost no probability on valid assignments. In the notebook sweeps (p=3), ×5 raised it to about 0.6%; the benchmark above measured a median of 0.15% per shot. At 9 qubits, a larger conflict weight hurts (valid mass drops from 0.59 to about 0.04 at ×8). In the Qollab export these knobs are locked to p=5, ×5 and COMSOL weights.

### Classical benchmark

The exact optimum is found instantly by enumerating only the feasible colorings (`2^components`) and is the reference for the gap. QAOA is compared against feasible-only greedy local search and simulated annealing on the same penalized cost (`scripts/benchmark.py`). Results are in the table under **Results**.

## Quick start

**Run on Qollab**

1. Build the package: `./scripts/package.sh` (creates `/tmp/quiettrace-qollab.zip`).
2. In Qollab, **Upload your own files** and choose the zip.
3. Select a backend in **Select QPU** (simulators are free; IonQ quantum computers spend credits) and press **Run**. Press **Stop** to end the run.

**Local preview** (needs Python with `qiskit`, `numpy`, `scipy`; `pip install -r requirements.txt`)

```bash
# Dynamic app: runs the Python pipeline, all controls work
PYTHON=/path/to/python ./scripts/dev.sh          # http://localhost:8000/dev/app-local.html

# Static mock: no Python needed
PYTHON=/path/to/python ./scripts/export-model.sh
./scripts/preview.sh                             # http://localhost:8000/dev/preview.html
```

**Benchmark**

```bash
python -m scripts.benchmark --kind both --wsource comsol --runs 10 --shots 1024
python -m scripts.benchmark --kind 2adc --cmult 5 --runs 10 --shots 3072
```

## Repository structure

```
index.html, main.css, main.js, engine.js   # UI and SVG render engine (PCB 2D/3D, charts)
quantum/
  modelo.py                 # nets, routes, conflicts, weights
  fastqaoa.py               # fast exact QAOA (used by the pipeline)
  qaoa.py                   # reference QAOA with Qiskit (auditing)
  pipeline.py               # model + QAOA -> data contract for the UI
  capacitance.py            # COMSOL-calibrated weights W_ij
  comsol_capacitance.csv    # C'_m calibration data (COMSOL 6.1)
  pcb.py                    # mock model (demo / fallback)
notebooks/                  # experiments (COMSOL vs geometric weights, parameter sweeps)
scripts/                    # packaging, local preview, benchmark
dev/                        # local-only preview files
```

The COMSOL curve, the `W_geometric` vs `W_COMSOL` comparison and the parameter sweeps are in `notebooks/quiettrace_experiments.ipynb` (section 9).

## Limitations

- Two layers only (L1/L4); the ground planes L2 and L3 are fixed.
- Capacitive coupling only (no inductive coupling or frequency dependence).
- Small instances (9 and 18 qubits): a classical solver finds the optimum instantly, so this is a demonstration of the method, not a speedup.
- Hardware runs are limited by IonQ's one-job-per-run rule on Qollab.

## Contributing

Read [`AGENTS.md`](AGENTS.md) before touching the code.

## Team and acknowledgements

<!-- TODO: team members, Qollab + IonQ hackathon, COMSOL license/institution if applicable. -->

## License

MIT, see [`LICENSE`](LICENSE).

## Docs

- Qollab runtime: <https://qollab.xyz/learn/docs/runtime-environment>
- JS/Qiskit projects: <https://qollab.xyz/learn/docs/js-qiskit-projects>
- Uploading files: <https://qollab.xyz/learn/docs/upload-your-files>

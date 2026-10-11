"""QuietTrace reproducible classical/quantum benchmarking.

Run from repo root:
    python -m scripts.benchmark --kind both --wsource comsol --runs 10 --shots 1024
    python -m scripts.benchmark --kind 2adc --cmult 5 --runs 10 --shots 3072

All algorithms minimize the same physical (penalized) C(x). Classical search
methods are constrained to feasible assignments, while QAOA is unconstrained
and reports both success and feasibility probabilities. `--cmult` multiplies the
conflict penalty M (see the UI "Conflict weight"): at 18 qubits x1 leaves QAOA
with ~0 feasible mass, so x5 is the interesting setting.

The solvers live in `quantum/classical.py` (shared with the UI's
"Classical benchmark" chart), so this script only orchestrates the trials.
"""
import argparse
import csv
import time
from pathlib import Path

import numpy as np
from quantum import pipeline, fastqaoa
from quantum.classical import (
    cost, exact, greedy_local, simulated_annealing as anneal,
)


def get_instance(kind, wsource, cmult=1.0):
    prob = pipeline._problem(kind=kind, wsource=wsource, cmult=cmult)
    n = len(prob['nets'])
    W = np.asarray(prob['W'], dtype=float)
    A = W.copy()
    conflicts = tuple(sorted(tuple(sorted(p)) for p in prob['conflicts']))
    M = float(prob['M'])
    for i, j in conflicts:
        A[i, j] += M
        A[j, i] += M
    b = float(prob['lam_v']) * np.asarray(prob['vias'], dtype=float)
    assert np.allclose(A, A.T)
    return prob, n, W, A, b, conflicts


def run_one(kind, wsource, runs, shots, budget, reps, maxiter, seed, cmult=1.0):
    prob, n, W, A, b, conflicts = get_instance(kind, wsource, cmult)
    t0 = time.perf_counter()
    costs, feas, opt, opt_mask = exact(n, A, b, conflicts)
    exact_time = time.perf_counter() - t0
    print(f'\n{n} nets [{kind}, {wsource}, cmult={cmult:g}]: exact={opt:.8g}; '
          f'feasible={feas.sum()}/{len(feas)}; optima={opt_mask.sum()}; exact_time={exact_time:.3f}s')
    rows = []
    rng = np.random.default_rng(seed)
    for method in ('greedy_local', 'simulated_annealing'):
        for trial in range(runs):
            trial_seed = int(rng.integers(1, 2**31))
            r = np.random.default_rng(trial_seed)
            t = time.perf_counter()
            if method == 'greedy_local':
                best, x, ev = greedy_local(A, b, conflicts, r, budget)
            else:
                best, x, ev = anneal(A, b, conflicts, r, budget)
            dt = time.perf_counter() - t
            rows.append(dict(kind=kind, wsource=wsource, cmult=cmult, method=method, trial=trial,
                             seed=trial_seed, n=n, budget=ev, time_s=dt,
                             best_cost=best, gap=best - opt, feasible=1,
                             success=int(abs(best - opt) < 1e-8),
                             p_feasible='', p_optimal='', expected_cost=''))
    # QAOA: ensure multiple trials differ; fastqaoa uses a fixed theta0 constant.
    # Vary the initial theta0 scalar deterministically for genuine independent restarts.
    for trial in range(runs):
        trial_seed = int(rng.integers(1, 2**31))
        r = np.random.default_rng(trial_seed)
        theta0_value = float(r.uniform(0.05, 1.4))
        t = time.perf_counter()
        qa = fastqaoa.run_qaoa(prob['J'], prob['h'], reps=reps, maxiter=maxiter,
                               theta0_value=theta0_value)
        dt = time.perf_counter() - t
        probabilities = np.asarray(qa['probabilities'], dtype=float)
        probabilities = probabilities / probabilities.sum()
        assert len(probabilities) == len(costs)
        p_feas = float(probabilities[feas].sum())
        p_opt = float(probabilities[opt_mask].sum())
        exp_cost = float(probabilities @ costs)
        draws = r.choice(len(probabilities), size=shots, p=probabilities)
        valid_draws = draws[feas[draws]]
        if len(valid_draws):
            idx = valid_draws[np.argmin(costs[valid_draws])]
            best = float(costs[idx]); valid = 1
        else:
            best = np.nan; valid = 0
        rows.append(dict(kind=kind, wsource=wsource, cmult=cmult, method='QAOA_statevector', trial=trial,
                         seed=trial_seed, n=n, budget=len(qa['history']), time_s=dt,
                         best_cost=best, gap=(best - opt if valid else np.nan),
                         feasible=valid, success=int(valid and abs(best - opt) < 1e-8),
                         p_feasible=p_feas, p_optimal=p_opt, expected_cost=exp_cost))
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--kind', choices=['1adc', '2adc', 'both'], default='both')
    p.add_argument('--wsource', choices=['geom', 'comsol'], default='comsol')
    p.add_argument('--cmult', type=float, default=1.0)
    p.add_argument('--runs', type=int, default=10)
    p.add_argument('--shots', type=int, default=1024)
    p.add_argument('--budget', type=int, default=150)
    p.add_argument('--reps', type=int, default=3)
    p.add_argument('--maxiter', type=int, default=150)
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--out', default='benchmark_results.csv')
    a = p.parse_args()
    all_rows = []
    kinds = ['1adc', '2adc'] if a.kind == 'both' else [a.kind]
    for kind in kinds:
        rows = run_one(kind, a.wsource, a.runs, a.shots, a.budget, a.reps, a.maxiter, a.seed, a.cmult)
        all_rows.extend(rows)
        for method in ('greedy_local', 'simulated_annealing', 'QAOA_statevector'):
            r = [x for x in rows if x['method'] == method]
            gaps = np.array([x['gap'] for x in r], dtype=float)
            succ = np.mean([x['success'] for x in r])
            print(f'  {method:22s} success={succ:.1%} '
                  f'median_gap={np.nanmedian(gaps):.5g} '
                  f'median_runtime={np.median([x["time_s"] for x in r]):.3f}s')
    dest = Path(a.out)
    with dest.open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(all_rows[0]))
        writer.writeheader(); writer.writerows(all_rows)
    print('Saved:', dest)


if __name__ == '__main__':
    main()

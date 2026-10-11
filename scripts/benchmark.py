"""QuietTrace reproducible classical/quantum benchmarking.

Copy into scripts/benchmark.py in the QuietTrace repo. Run from repo root:
    python -m scripts.benchmark --kind both --wsource comsol --runs 10 --shots 1024
    python -m scripts.benchmark --kind 2adc --cmult 5 --runs 10 --shots 3072

All algorithms minimize the same physical (penalized) C(x). Classical search
methods are constrained to feasible assignments, while QAOA is unconstrained
and reports both success and feasibility probabilities. `--cmult` multiplies the
conflict penalty M (see the UI "Conflict weight"): at 18 qubits ×1 leaves QAOA
with ~0 feasible mass, so ×5 is the interesting setting.
"""
import argparse
import csv
import json
import time
from pathlib import Path

import numpy as np
from quantum import pipeline, fastqaoa


def get_instance(kind, wsource, cmult=1.0):
    prob = pipeline._problem(kind=kind, wsource=wsource, cmult=cmult)
    n = len(prob['nets'])
    W = np.asarray(prob['W'], dtype=float)
    A = W.copy()
    conflicts = tuple(sorted(tuple(sorted(p)) for p in prob['conflicts']))
    M = float(prob['M'])
    for i, j in conflicts:
        A[i,j] += M
        A[j,i] += M
    b = float(prob['lam_v']) * np.asarray(prob['vias'], dtype=float)
    assert np.allclose(A,A.T)
    return prob,n,W,A,b,conflicts


def cost(bits, A, b):
    bits = np.asarray(bits, dtype=np.int8)
    return float(np.triu(A * (bits[:,None] == bits[None,:]), 1).sum() + b @ bits)


def num_violations(bits, conflicts):
    return sum(int(bits[i] == bits[j]) for i,j in conflicts)


def exact(n, A, b, conflicts):
    """Enumerate in chunks; n=18 only 262144 states. Full state costs retained."""
    size = 1 << n
    costs = np.empty(size, dtype=np.float64)
    feasible = np.ones(size, dtype=bool)
    # 8192 rows at a time; no 2**n x n x n temporary arrays
    edge_i,edge_j = np.triu_indices(n,k=1)
    weights = A[edge_i,edge_j]
    good_edges = weights != 0
    ei,ej,ew = edge_i[good_edges],edge_j[good_edges],weights[good_edges]
    for lo in range(0,size,8192):
        hi=min(lo+8192,size)
        k=np.arange(lo,hi,dtype=np.uint32)
        X=((k[:,None] >> np.arange(n)) & 1).astype(np.int8)
        value=X@b
        for i,j,w in zip(ei,ej,ew):
            value=value+w*(X[:,i]==X[:,j])
        costs[lo:hi]=value
        for i,j in conflicts:
            feasible[lo:hi] &= (X[:,i]!=X[:,j])
    if not np.any(feasible):
        raise ValueError('No feasible states!')
    opt = float(np.min(costs[feasible]))
    mask = feasible & np.isclose(costs,opt,atol=1e-8,rtol=0)
    return costs,feasible,opt,mask


def bits_from_index(k,n):
    return np.array([(k>>i)&1 for i in range(n)],dtype=np.int8)


def components(n, conflicts):
    adj=[[] for _ in range(n)]
    for i,j in conflicts:adj[i].append(j);adj[j].append(i)
    seen=set();result=[]
    for root in range(n):
        if root in seen:continue
        seen.add(root);queue=[root]
        for u in queue:
            for v in adj[u]:
                if v not in seen:seen.add(v);queue.append(v)
        result.append(np.asarray(queue,dtype=int))
    return result


def greedy_local(A,b,conflicts,rng,budget):
    """Random feasible restarts + component-flip descent, measured in calls."""
    n=len(b);groups=components(n,conflicts)
    best=np.inf;best_bits=None;evals=0
    while evals<budget:
        x=feasible_coloring(n,conflicts)
        for group in groups:
            if rng.random()<.5:x[group]^=1
        value=cost(x,A,b);evals+=1
        changed=True
        while changed and evals<budget:
            changed=False
            move=None;newval=value
            for j in rng.permutation(len(groups)):
                if evals>=budget:break
                y=x.copy();y[groups[j]]^=1
                c=cost(y,A,b);evals+=1
                if c<newval-1e-12:move=y;newval=c
            if move is not None:
                x=move;value=newval;changed=True
        if value<best:
            best=float(value);best_bits=x.copy()
    return best,best_bits,evals


def feasible_coloring(n, conflicts):
    adj=[[] for _ in range(n)]
    for i,j in conflicts:adj[i].append(j);adj[j].append(i)
    bits=np.full(n,-1,dtype=np.int8)
    for root in range(n):
        if bits[root]>=0: continue
        bits[root]=0;queue=[root]
        for u in queue:
            for v in adj[u]:
                if bits[v]<0:bits[v]=1-bits[u];queue.append(v)
                elif bits[v]==bits[u]:raise ValueError('Not bipartite')
    return bits


def anneal(A,b,conflicts,rng,budget,steps_per_run=150):
    """Feasible-only simulated annealing, with restarts. Count cost evaluations."""
    n=len(b);best=np.inf;best_bits=None;evals=0
    while evals<budget:
        x=feasible_coloring(n,conflicts)
        # randomize the choice of initial 2-coloring by component flips
        adj=[[] for _ in range(n)]
        for i,j in conflicts:adj[i].append(j);adj[j].append(i)
        seen=set()
        for root in range(n):
            if root in seen:continue
            queue=[root];seen.add(root);component=[]
            for u in queue:
                component.append(u)
                for v in adj[u]:
                    if v not in seen:seen.add(v);queue.append(v)
            if rng.random()<.5:x[component]^=1
        value=cost(x,A,b);evals+=1
        if value<best: best=value;best_bits=x.copy()
        for step in range(min(steps_per_run,budget-evals)):
            t=step/max(1,steps_per_run-1)
            temp=max(0.005, 2.0*(0.005/2.0)**t)
            # flip one connected component to preserve all hard conflicts
            root=int(rng.integers(n));queue=[root];seen={root}
            for u in queue:
                for v in adj[u]:
                    if v not in seen:seen.add(v);queue.append(v)
            y=x.copy();y[list(seen)]^=1
            c=cost(y,A,b);evals+=1
            if c<value or rng.random()<np.exp(np.clip((value-c)/temp,-700,0)):
                x=y;value=c
                if value<best:best=value;best_bits=x.copy()
    return float(best),best_bits,evals


def run_one(kind,wsource,runs,shots,budget,reps,maxiter,seed,cmult=1.0):
    prob,n,W,A,b,conflicts=get_instance(kind,wsource,cmult)
    t0=time.perf_counter()
    costs,feas,opt,opt_mask=exact(n,A,b,conflicts)
    exact_time=time.perf_counter()-t0
    print(f'\n{n} nets [{kind}, {wsource}]: exact={opt:.8g}; '
          f'feasible={feas.sum()}/{len(feas)}; optima={opt_mask.sum()}; exact_time={exact_time:.3f}s')
    rows=[]
    rng=np.random.default_rng(seed)
    for method in ('greedy_local','simulated_annealing'):
        for trial in range(runs):
            trial_seed=int(rng.integers(1,2**31))
            r=np.random.default_rng(trial_seed)
            t=time.perf_counter()
            if method=='greedy_local':best,x,ev=greedy_local(A,b,conflicts,r,budget)
            else:best,x,ev=anneal(A,b,conflicts,r,budget)
            dt=time.perf_counter()-t
            rows.append(dict(kind=kind,wsource=wsource,cmult=cmult,method=method,trial=trial,
                             seed=trial_seed,n=n,budget=ev,time_s=dt,
                             best_cost=best,gap=best-opt,feasible=1,
                             success=int(abs(best-opt)<1e-8),
                             p_feasible='',p_optimal='',expected_cost=''))
    # QAOA: ensure multiple trials differ; fastqaoa uses fixed theta0=constant.
    # Vary initial theta0 scalar deterministically for genuine independent restarts.
    for trial in range(runs):
        trial_seed=int(rng.integers(1,2**31))
        r=np.random.default_rng(trial_seed)
        theta0_value=float(r.uniform(0.05,1.4))
        t=time.perf_counter()
        qa=fastqaoa.run_qaoa(prob['J'],prob['h'],reps=reps,maxiter=maxiter,
                             theta0_value=theta0_value)
        dt=time.perf_counter()-t
        probabilities=np.asarray(qa['probabilities'],dtype=float)
        probabilities=probabilities/probabilities.sum()
        assert len(probabilities)==len(costs)
        p_feas=float(probabilities[feas].sum())
        p_opt=float(probabilities[opt_mask].sum())
        exp_cost=float(probabilities@costs)
        draws=r.choice(len(probabilities),size=shots,p=probabilities)
        valid_draws=draws[feas[draws]]
        if len(valid_draws):
            idx=valid_draws[np.argmin(costs[valid_draws])]
            best=float(costs[idx]);valid=1
        else:best=np.nan;valid=0
        rows.append(dict(kind=kind,wsource=wsource,cmult=cmult,method='QAOA_statevector',trial=trial,
                         seed=trial_seed,n=n,budget=len(qa['history']),time_s=dt,
                         best_cost=best,gap=(best-opt if valid else np.nan),
                         feasible=valid,success=int(valid and abs(best-opt)<1e-8),
                         p_feasible=p_feas,p_optimal=p_opt,expected_cost=exp_cost))
    return rows


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--kind',choices=['1adc','2adc','both'],default='both')
    p.add_argument('--wsource',choices=['geom','comsol'],default='comsol')
    p.add_argument('--cmult',type=float,default=1.0)
    p.add_argument('--runs',type=int,default=10)
    p.add_argument('--shots',type=int,default=1024)
    p.add_argument('--budget',type=int,default=150)
    p.add_argument('--reps',type=int,default=3)
    p.add_argument('--maxiter',type=int,default=150)
    p.add_argument('--seed',type=int,default=42)
    p.add_argument('--out',default='benchmark_results.csv')
    a=p.parse_args()
    all_rows=[]
    kinds=['1adc','2adc'] if a.kind=='both' else [a.kind]
    for kind in kinds:
        rows=run_one(kind,a.wsource,a.runs,a.shots,a.budget,a.reps,a.maxiter,a.seed,a.cmult)
        all_rows.extend(rows)
        for method in ('greedy_local','simulated_annealing','QAOA_statevector'):
            r=[x for x in rows if x['method']==method]
            gaps=np.array([x['gap'] for x in r],dtype=float)
            succ=np.mean([x['success'] for x in r])
            print(f'  {method:22s} success={succ:.1%} '
                  f'median_gap={np.nanmedian(gaps):.5g} '
                  f'median_runtime={np.median([x["time_s"] for x in r]):.3f}s')
    dest=Path(a.out)
    with dest.open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(all_rows[0]))
        writer.writeheader();writer.writerows(all_rows)
    print('Saved:',dest)

if __name__=='__main__':main()

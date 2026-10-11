"""COMSOL-calibrated, pairwise capacitive weights for QuietTrace.

CSV: COMSOL 6.1 export; columns: separation (mm), charge (C), charge/length (C/m).
Assumes receiving terminal at 0 V, driven terminal at 1 V and 2D charge/length.
Only a quasi-electrostatic pairwise proxy. No inductive or frequency-dependent crosstalk.
"""
from functools import lru_cache
from pathlib import Path
import warnings
import numpy as np

# Root-relative literal so Qollab preloads the file (AGENTS.md §2.7). The
# file-relative path is tried first for local / notebook convenience.
CSV_RELATIVE = 'quantum/comsol_capacitance.csv'
CSV_DEFAULT = Path(__file__).resolve().with_name('comsol_capacitance.csv') \
    if '__file__' in globals() else None


def _resolve_csv(csv_path):
    if csv_path is not None:
        return Path(csv_path)
    if CSV_DEFAULT is not None and CSV_DEFAULT.exists():
        return CSV_DEFAULT
    return Path(CSV_RELATIVE)


@lru_cache(maxsize=8)
def load_comsol_curve(csv_path=None, excitation_v=1.0):
    path = _resolve_csv(csv_path)
    # Ignore COMSOL metadata and column-heading lines.
    data = np.loadtxt(path, delimiter=',', skiprows=5)
    if data.ndim != 2 or data.shape[1] < 3:
        raise ValueError('Expected 3 columns: gap_mm, charge_C, charge_per_length_C_per_m')
    gap_mm = data[:, 0]
    # Q2 is negative when trace 1 is driven and trace 2 is at ground.
    cm_pf_per_mm = -data[:, 2] / float(excitation_v) * 1e9
    order = np.argsort(gap_mm)
    gap_mm, cm_pf_per_mm = gap_mm[order], cm_pf_per_mm[order]
    if (np.any(np.diff(gap_mm) <= 0) or np.any(gap_mm <= 0)
            or np.any(cm_pf_per_mm <= 0)):
        raise ValueError('Expected distinct positive gaps and positive mutual capacitances')
    return gap_mm, cm_pf_per_mm


def capacitance_per_mm(gap_mm, *, csv_path=None, extrapolation='powerlaw'):
    """C'_m(gap) in pF/mm; positive log-log interpolation.

    extrapolation='error' disallows any extrapolation.
    extrapolation='powerlaw' fits last 3 points above max gap (model estimate,
    not COMSOL data); never extrapolates below minimum gap.
    """
    grid, values = load_comsol_curve(str(csv_path) if csv_path is not None else None)
    gap = np.asarray(gap_mm, dtype=float)
    if np.any(~np.isfinite(gap)) or np.any(gap < grid[0]):
        raise ValueError(f'Gap below COMSOL calibration minimum {grid[0]} mm or nonfinite')
    if extrapolation == 'error' and np.any(gap > grid[-1]):
        raise ValueError(f'Gap above COMSOL calibration maximum {grid[-1]} mm')
    if extrapolation not in ('error', 'powerlaw'):
        raise ValueError('extrapolation must be error or powerlaw')
    limited = np.minimum(gap, grid[-1])
    out = np.exp(np.interp(np.log(limited), np.log(grid), np.log(values)))
    if np.any(gap > grid[-1]):
        slope = np.polyfit(np.log(grid[-3:]), np.log(values[-3:]), 1)[0]
        out = np.where(gap > grid[-1], values[-1] * (gap / grid[-1]) ** slope, out)
    return out


def mutual_capacitance_weights(nets, routes, conflicts, *, length_mm=65.0,
                               width_mm=0.4, samples=251, c_ref_pf=1.0,
                               csv_path=None, extrapolation='powerlaw'):
    """Return symmetric W where W_ij ~ C_m,ij / c_ref_pf.

    Same-layer conflict pairs are excluded (the separate M penalty handles them).
    For nearly parallel traces, integrates local 2D coupled-microstrip C'_m.
    """
    if c_ref_pf <= 0:
        raise ValueError('c_ref_pf must be positive')
    n = len(nets)
    W = np.zeros((n, n), dtype=float)
    xx = np.linspace(0.0, length_mm, samples)
    largest_gap = 0.0
    conflict_set = set(conflicts)
    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) in conflict_set:
                continue
            yi0, yi1 = routes[nets[i]]
            yj0, yj1 = routes[nets[j]]
            yi = yi0 + (yi1 - yi0) * xx / length_mm
            yj = yj0 + (yj1 - yj0) * xx / length_mm
            gap = np.abs(yi - yj) - width_mm  # edge-to-edge, millimeters
            largest_gap = max(largest_gap, float(np.max(gap)))
            cm_prime = capacitance_per_mm(gap, csv_path=csv_path,
                                         extrapolation=extrapolation)
            slope_i = (yi1 - yi0) / length_mm
            slope_j = (yj1 - yj0) / length_mm
            ds_dx = 0.5 * (np.hypot(1.0, slope_i) + np.hypot(1.0, slope_j))
            cm_pf = float(np.trapezoid(cm_prime * ds_dx, xx))
            W[i, j] = W[j, i] = cm_pf / c_ref_pf
    grid, _ = load_comsol_curve(str(csv_path) if csv_path is not None else None)
    if largest_gap > grid[-1] and extrapolation == 'powerlaw':
        warnings.warn(f'Gap reaches {largest_gap:.2f} mm; COMSOL data ends at '
                      f'{grid[-1]:.2f} mm. Tail is power-law extrapolation, '
                      'not simulated.', stacklevel=2)
    return W

// Local shim: emulates `quantum.pipeline` (Pyodide) over the dev server API.
// Imported by main.js via an import map in dev/app-local.html.

async function call(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
  return { toJs: () => data };
}

const q = (o) => encodeURIComponent(o == null ? '' : o);

export const get_model = {
  callPromising: (kind = '1adc', init = null, order = null) =>
    call(`/api/model?kind=${kind}&init=${init ?? ''}&order=${q(order)}`),
};

export const run_backend = {
  callPromising: (backend, shots = 1024, reps = 3, maxiter = 150, kind = '1adc', init = null, order = null) =>
    call(`/api/run?shots=${shots}&kind=${kind}&order=${q(order)}`),
};

export const resample_ideal = {
  callPromising: (shots = 1024, seed = null, kind = '1adc', init = null, order = null) =>
    call(`/api/resample?shots=${shots}&kind=${kind}&order=${q(order)}`),
};

export const REPS = 3;
export const MAXITER = 150;

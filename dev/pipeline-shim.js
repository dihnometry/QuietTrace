// Local shim: emulates `quantum.pipeline` (Pyodide) over the dev server API.
// Imported by main.js via an import map in dev/app-local.html.

async function call(path) {
  const res = await fetch(path);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const txt = (await res.text()).slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(
      `expected JSON from ${path} but got ${res.status} ${ct || '(no content-type)'} ('${txt}'). ` +
      'Are you on the dev server (`./scripts/dev.sh`), not the static preview?'
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
  return { toJs: () => data };
}

const q = (o) => encodeURIComponent(o == null ? '' : o);

export const get_model = {
  callPromising: (kind = '1adc', init = null, order = null) =>
    call(`/api/model?kind=${kind}&init=${init ?? ''}&order=${q(order)}`),
};

export const get_problem = {
  callPromising: (kind = '1adc', order = null) =>
    call(`/api/problem?kind=${kind}&order=${q(order)}`),
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

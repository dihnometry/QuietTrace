"""Local dev server for QuietTracE.

Serves the repo statically AND runs the pipeline in Python, so the real UI
(`main.js` + `engine.js`) works locally without Qollab/Pyodide.

Endpoints:
  GET /api/model?kind=1adc|2adc&order=<csv>&init=<deg>&w=geom|comsol
  GET /api/problem?kind=...&order=...&w=...
  GET /api/resample?shots=<n>&kind=...&order=...&init=...
  GET /api/run?shots=<n>&kind=...&order=...&w=...   (local BasicSimulator, fallback)

Run with a Python that has qiskit/numpy/scipy:
  PYTHON=/tmp/opencode/qtvenv/bin/python ./scripts/dev.sh
Then open  http://localhost:8000/dev/app-local.html
"""

import json
import os
import sys
import importlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

try:
    import numpy  # noqa: F401
    import scipy  # noqa: F401
    from quantum import pipeline  # noqa: E402
except Exception as exc:  # noqa: BLE001
    print("ERROR: missing Python deps for the dev server:", exc)
    print("Use a Python with numpy+scipy (and qiskit for the local backend):")
    print("  PYTHON=./.venv/bin/python ./scripts/dev.sh")
    raise


def _opt(q, key):
    v = q.get(key, [""])[0]
    return v or None


# --- auto-reload: el servidor importa quantum/* una vez; si editas el pipeline,
# sin esto seguiria con la version vieja (p. ej. kind='25' devolvia 9 redes).
_RELOAD = ["quantum.modelo", "quantum.capacitance", "quantum.fastqaoa",
           "quantum.classical", "quantum.qaoa", "quantum.problem2",
           "quantum.problem25", "quantum.reduced", "quantum.pipeline"]
_MTIMES = {}


def _maybe_reload():
    changed = False
    for name in _RELOAD:
        mod = sys.modules.get(name)
        f = getattr(mod, "__file__", None) if mod else None
        if not f:
            continue
        try:
            mt = os.path.getmtime(f)
        except OSError:
            continue
        if _MTIMES.get(name) not in (None, mt):
            changed = True
        _MTIMES[name] = mt
    if changed:
        for name in _RELOAD:  # dependencias primero; pipeline al final
            if name in sys.modules:
                try:
                    importlib.reload(sys.modules[name])
                except Exception as exc:  # noqa: BLE001
                    print(f"(reload failed for {name}: {exc})")
        print("(recargados los modulos quantum/*)", flush=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *args):  # keep the console quiet-ish
        pass

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self._api(url)
        return super().do_GET()

    def _send(self, code, obj):
        body = json.dumps(obj, default=lambda o: o.item() if hasattr(o, "item") else str(o)).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _api(self, url):
        _maybe_reload()
        q = parse_qs(url.query)
        kind = _opt(q, "kind") or "1adc"
        order = _opt(q, "order")
        init = _opt(q, "init")
        wsource = _opt(q, "w") or "geom"
        cmult = float(_opt(q, "c") or 1)
        reps = int(_opt(q, "p") or pipeline.REPS)
        init_deg = int(init) if init not in (None, "null", "None") else None
        try:
            if url.path == "/api/model":
                return self._send(200, pipeline.get_model(kind, init_deg, order, wsource, cmult, reps))
            if url.path == "/api/problem":
                return self._send(200, pipeline.get_problem(kind, order, wsource, cmult))
            if url.path == "/api/random":
                return self._send(200, pipeline.random_order(kind))
            if url.path == "/api/resample":
                shots = int(_opt(q, "shots") or 1024)
                return self._send(200, pipeline.resample_ideal(shots, None, kind, init_deg, order, wsource, cmult, reps))
            if url.path == "/api/run":
                from qiskit.providers.basic_provider import BasicSimulator
                shots = int(_opt(q, "shots") or 3072)
                return self._send(200, pipeline.run_backend(
                    BasicSimulator(), shots, reps, pipeline.MAXITER, kind, init_deg, order, wsource, cmult))
            return self._send(404, {"error": f"unknown endpoint {url.path}"})
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = None
    port = start
    for _ in range(25):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    if httpd is None:
        raise SystemExit("no free port found (tried 25)")
    if port != start:
        print(f"(port {start} busy; using {port})")
    print(f"QuietTracE dev server:  http://localhost:{port}/dev/app-local.html")
    print(f"  check: curl 'http://localhost:{port}/api/model?kind=1adc'")
    httpd.serve_forever()

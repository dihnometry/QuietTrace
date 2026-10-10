#!/usr/bin/env bash
# Regenera dev/model.json para la vista local (scripts/preview.sh).
#
# Intenta el pipeline REAL (modelo + QAOA). Si faltan qiskit/scipy, cae al
# modelo mock (quantum/pcb.py). Para forzar un intérprete:
#   PYTHON=/tmp/opencode/qtvenv/bin/python ./scripts/export-model.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"

"$PY" - <<'PY'
import json, sys

sys.path.insert(0, ".")
model = None
try:
    from quantum import pipeline
    model = pipeline.get_model()
    print("dev/model.json generado (pipeline QAOA real)")
except Exception as exc:  # noqa: BLE001
    sys.path.insert(0, "quantum")
    import pcb
    model = pcb.get_model()
    print(f"dev/model.json generado (MOCK; pipeline no disponible: {exc})")

with open("dev/model.json", "w", encoding="utf-8") as f:
    json.dump(model, f, ensure_ascii=False, indent=2)
PY

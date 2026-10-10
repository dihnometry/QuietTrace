#!/usr/bin/env bash
# Regenera dev/model.json a partir del modelo mock de quantum/pcb.py,
# para la vista local (scripts/preview.sh).
set -euo pipefail

cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, sys
sys.path.insert(0, "quantum")
import pcb

with open("dev/model.json", "w", encoding="utf-8") as f:
    json.dump(pcb.get_model(), f, ensure_ascii=False, indent=2)

print("dev/model.json generado")
PY

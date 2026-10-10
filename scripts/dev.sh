#!/usr/bin/env bash
# Dynamic local preview of QuietTracE (runs the pipeline in Python).
# Needs a python with qiskit/numpy/scipy:
#   PYTHON=/tmp/opencode/qtvenv/bin/python ./scripts/dev.sh [port]
set -euo pipefail

cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
PORT="${1:-8000}"

echo "QuietTracE dynamic local preview:"
exec "$PY" scripts/devserver.py "$PORT"

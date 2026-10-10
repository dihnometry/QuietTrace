#!/usr/bin/env bash
# Dynamic local preview of QuietTracE (runs the pipeline in Python).
# Auto-detects ./.venv/bin/python if PYTHON is not set.
#   ./scripts/dev.sh [port]
#   PYTHON=/path/to/python ./scripts/dev.sh [port]
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif [ -x "./.venv/bin/python" ]; then
  PY="./.venv/bin/python"
elif [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

PORT="${1:-8000}"

echo "QuietTracE dynamic local preview"
echo "  python: $PY"
echo "  open:   http://localhost:${PORT}/dev/app-local.html"
exec "$PY" scripts/devserver.py "$PORT"

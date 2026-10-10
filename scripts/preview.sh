#!/usr/bin/env bash
# STATIC preview (no Python deps): a fixed dev/model.json rendered by engine.js.
# The interactive controls (problem tabs, connections, shots) DO NOT work here.
# For the dynamic preview use:  ./scripts/dev.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${1:-8000}"

echo "QuietTracE — STATIC preview (mock, fixed model.json)"
echo "  open: http://localhost:${PORT}/dev/preview.html"
echo "  (for the interactive preview use ./scripts/dev.sh and dev/app-local.html)"
echo "(Ctrl+C para parar)"
python3 -m http.server "$PORT"

#!/usr/bin/env bash
# Vista local de QuietTracE (mock del runtime de Qollab).
# Uso: ./scripts/preview.sh [puerto]
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${1:-8000}"

echo "QuietTracE — vista local"
echo "Abre: http://localhost:${PORT}/dev/preview.html"
echo "(Ctrl+C para parar)"
python3 -m http.server "$PORT"

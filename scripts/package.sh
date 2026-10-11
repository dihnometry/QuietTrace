#!/usr/bin/env bash
# Empaqueta SOLO los archivos de runtime para subir a Qollab.
# Excluye tooling local (dev/, scripts/, AGENTS.md).
# Uso: ./scripts/package.sh [salida.zip]
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-/tmp/quiettrace-qollab.zip}"

python3 - "$OUT" <<'PY'
import os, sys, zipfile

out = sys.argv[1]
entries = ["index.html", "main.css", "main.js", "engine.js",
           "requirements.txt", "README.md", "LICENSE", "quantum"]

# excluir tooling local y metadatos
EXCLUDE_DIRS = {".git", "dev", "scripts", "__MACOSX", "__pycache__"}
# problem25.py: instancia experimental de 25 redes, solo dev (la pestaña esta oculta en la UI)
EXCLUDE_FILES = {".DS_Store", "Thumbs.db", "problem25.py"}

if os.path.exists(out):
    os.remove(out)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for entry in entries:
        if not os.path.exists(entry):
            continue
        if os.path.isdir(entry):
            for root, dirs, files in os.walk(entry):
                dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
                for name in files:
                    if name in EXCLUDE_FILES or name.startswith("."):
                        continue
                    path = os.path.join(root, name)
                    z.write(path, path)
        else:
            z.write(entry, entry)

print("Paquete listo:", out)
with zipfile.ZipFile(out) as z:
    for info in z.infolist():
        print(f"  {info.file_size:>8}  {info.filename}")
PY

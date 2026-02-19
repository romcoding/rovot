#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/desktop/backend-bin"
rm -rf "$OUT"
mkdir -p "$OUT"
python -m pyinstaller --clean -F -n rovot-daemon -c -p "$ROOT/src" "$ROOT/src/rovot/cli.py"
cp "$ROOT/dist/rovot-daemon" "$OUT/rovot-daemon"
echo "Built backend: $OUT/rovot-daemon"

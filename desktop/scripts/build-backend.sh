#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/desktop/backend-bin"

ARCH="${1:-}"

rm -rf "$OUT"
mkdir -p "$OUT"

PYINSTALLER_ARGS=(--clean -F -n rovot-daemon -c -p "$ROOT/src" "$ROOT/src/rovot/cli.py")

if [[ "$(uname)" == "Darwin" && -n "$ARCH" ]]; then
  PYINSTALLER_ARGS+=(--target-architecture "$ARCH")
  echo "Building for macOS architecture: $ARCH"
fi

cd "$ROOT"
python -m PyInstaller "${PYINSTALLER_ARGS[@]}"

if [[ "$(uname)" == "Darwin" ]]; then
  cp "$ROOT/dist/rovot-daemon" "$OUT/rovot-daemon"
  chmod +x "$OUT/rovot-daemon"
else
  cp "$ROOT/dist/rovot-daemon.exe" "$OUT/rovot-daemon.exe" 2>/dev/null \
    || cp "$ROOT/dist/rovot-daemon" "$OUT/rovot-daemon"
  chmod +x "$OUT/rovot-daemon" 2>/dev/null || true
fi

echo "Built backend binary -> $OUT"
ls -lh "$OUT"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/desktop/backend-bin"

ARCH="${1:-}"
PYTHON_BIN="${PYTHON_BIN:-}"

if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    echo "Error: python/python3 not found in PATH."
    exit 1
  fi
fi

rm -rf "$OUT"
mkdir -p "$OUT"

PYINSTALLER_ARGS=(
  --clean -F -n rovot-daemon -c
  -p "$ROOT/src"
  --hidden-import uvicorn.logging
  --hidden-import uvicorn.loops.auto
  --hidden-import uvicorn.protocols.http.auto
  --hidden-import uvicorn.protocols.http.h11_impl
  --hidden-import uvicorn.protocols.websockets.auto
  --hidden-import uvicorn.protocols.websockets.wsproto_impl
  --hidden-import uvicorn.lifespan.on
  --hidden-import multipart
  --collect-submodules pydantic
  --collect-submodules keyring
  "$ROOT/src/rovot/cli.py"
)

if [[ "$(uname)" == "Darwin" && -n "$ARCH" ]]; then
  PYINSTALLER_ARGS+=(--target-architecture "$ARCH")
  echo "Building for macOS architecture: $ARCH"
fi

cd "$ROOT"
"$PYTHON_BIN" -m PyInstaller "${PYINSTALLER_ARGS[@]}"

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

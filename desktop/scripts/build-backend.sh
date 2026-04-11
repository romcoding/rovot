#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/desktop/backend-bin"

ARCH="${1:-}"
PYTHON_BIN="${PYTHON_BIN:-}"

if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "$ROOT/.venv/bin/python" ]]; then
    PYTHON_BIN="$ROOT/.venv/bin/python"
  elif command -v python >/dev/null 2>&1; then
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
  --hidden-import playwright
  --hidden-import playwright.async_api
  --collect-all playwright
  --add-data "$("$PYTHON_BIN" -c 'import playwright, os; print(os.path.join(os.path.dirname(playwright.__file__), "driver"))'):playwright/driver"
  --collect-all llama_cpp
  --hidden-import llama_cpp
  --hidden-import llama_cpp.llama
  --hidden-import llama_cpp.llama_chat_format
  --hidden-import llama_cpp.llama_grammar
  "$ROOT/src/rovot/cli.py"
)

if [[ "$(uname)" == "Darwin" && -n "$ARCH" ]]; then
  PYINSTALLER_ARGS+=(--target-architecture "$ARCH")
  echo "Building for macOS architecture: $ARCH"
fi

# Install llama-cpp-python with Metal support for Apple Silicon.
# On Intel Macs, fall back to standard CPU build.
echo "Installing llama-cpp-python..."
MACHINE="$(uname -m)"
if [[ "$MACHINE" == "arm64" || "$ARCH" == "arm64" || "$ARCH" == "universal2" ]]; then
  echo "Apple Silicon detected — building with Metal GPU support"
  CMAKE_ARGS="-DGGML_METAL=on" FORCE_CMAKE=1 "$PYTHON_BIN" -m pip install \
    llama-cpp-python --no-cache-dir --force-reinstall
else
  echo "Intel Mac — building CPU-only llama-cpp-python"
  "$PYTHON_BIN" -m pip install llama-cpp-python --no-cache-dir
fi

# Install Playwright browsers for bundling
echo "Installing Playwright Chromium..."
"$PYTHON_BIN" -m playwright install chromium

# Add Metal shader library for Apple Silicon
if [[ "$(uname -m)" == "arm64" || "$ARCH" == "arm64" || "$ARCH" == "universal2" ]]; then
  LLAMA_CPP_DIR="$("$PYTHON_BIN" -c 'import llama_cpp, os; print(os.path.dirname(llama_cpp.__file__))' 2>/dev/null || echo "")"
  if [[ -n "$LLAMA_CPP_DIR" ]]; then
    # Include the ggml-metal.metal shader file and any compiled .metallib
    for metal_file in "$LLAMA_CPP_DIR"/*.metal "$LLAMA_CPP_DIR"/*.metallib; do
      if [[ -f "$metal_file" ]]; then
        PYINSTALLER_ARGS+=("--add-data" "$metal_file:.")
        echo "Bundling Metal file: $metal_file"
      fi
    done
    # Include any .dylib files (ggml backends)
    for dylib in "$LLAMA_CPP_DIR"/*.dylib; do
      if [[ -f "$dylib" ]]; then
        PYINSTALLER_ARGS+=("--add-binary" "$dylib:.")
        echo "Bundling dylib: $dylib"
      fi
    done
  fi
fi

cd "$ROOT"
if ! "$PYTHON_BIN" -m PyInstaller --version >/dev/null 2>&1; then
  echo "Error: PyInstaller is not installed for interpreter: $PYTHON_BIN"
  echo "Install packaging deps in project venv:"
  echo "  python3 -m venv .venv"
  echo "  source .venv/bin/activate"
  echo "  python -m pip install -e '.[packaging]'"
  exit 1
fi

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

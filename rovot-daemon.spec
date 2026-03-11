# -*- mode: python ; coding: utf-8 -*-
import glob as _glob
import os
import sys

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = ['uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.http.h11_impl', 'uvicorn.protocols.websockets.auto', 'uvicorn.protocols.websockets.wsproto_impl', 'uvicorn.lifespan.on', 'multipart']
hiddenimports += collect_submodules('pydantic')
hiddenimports += collect_submodules('keyring')
hiddenimports += ['llama_cpp']

# Bundle llama-cpp-python shared libraries so the packaged binary can load them.
_llama_binaries = []
for _pattern in [
    'llama_cpp/lib/libllama.dylib',   # macOS
    'llama_cpp/lib/libllama.so',      # Linux
    'llama_cpp/lib/libllama.dll',     # Windows
    'llama_cpp/lib/libggml*.dylib',
    'llama_cpp/lib/libggml*.so',
]:
    for _sp in sys.path:
        for _m in _glob.glob(os.path.join(_sp, _pattern)):
            _llama_binaries.append((_m, 'llama_cpp/lib'))


a = Analysis(
    ['/Users/romanhess/Coding/2026/rovot/src/rovot/cli.py'],
    pathex=['/Users/romanhess/Coding/2026/rovot/src'],
    binaries=_llama_binaries,
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='rovot-daemon',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch='arm64',
    codesign_identity=None,
    entitlements_file=None,
)

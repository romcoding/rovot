# -*- mode: python ; coding: utf-8 -*-
import subprocess as _sp
import os as _os
import sys as _sys
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import collect_all

# Collect llama_cpp data (includes Metal shaders, grammars, etc.)
try:
    from PyInstaller.utils.hooks import collect_all as _collect_all
    _llama_datas, _llama_bins, _llama_hidden = _collect_all('llama_cpp')
except Exception:
    _llama_datas, _llama_bins, _llama_hidden = [], [], []

# Existing playwright data collection
try:
    _pw_driver = _sp.check_output(
        [_sys.executable, '-c',
         'import playwright, os; print(os.path.join(os.path.dirname(playwright.__file__), "driver"))'],
        text=True
    ).strip()
    _pw_datas = [(_pw_driver, 'playwright/driver')] if _os.path.isdir(_pw_driver) else []
except Exception:
    _pw_datas = []

datas = _pw_datas + _llama_datas
binaries = _llama_bins
hiddenimports = [
    'uvicorn.logging', 'uvicorn.loops.auto',
    'uvicorn.protocols.http.auto', 'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets.auto', 'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.lifespan.on', 'multipart',
    'playwright', 'playwright.async_api',
    'llama_cpp', 'llama_cpp.llama', 'llama_cpp.llama_chat_format', 'llama_cpp.llama_grammar',
] + _llama_hidden
hiddenimports += collect_submodules('pydantic')
hiddenimports += collect_submodules('keyring')
hiddenimports += collect_submodules('llama_cpp')
tmp_ret = collect_all('playwright')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret2 = collect_all('llama_cpp')
datas += tmp_ret2[0]; binaries += tmp_ret2[1]; hiddenimports += tmp_ret2[2]


a = Analysis(
    ['/Users/romanhess/Coding/2026/rovot/src/rovot/cli.py'],
    pathex=['/Users/romanhess/Coding/2026/rovot/src'],
    binaries=binaries,
    datas=datas,
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

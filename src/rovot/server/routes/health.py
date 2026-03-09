from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends

from rovot import __version__
from rovot.server.deps import AppState, get_state

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(state: AppState = Depends(get_state)) -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "host": state.settings.host,
        "port": state.settings.port,
        "workspace_dir": str(state.settings.workspace_dir),
        "use_keychain": state.secrets.use_keychain,
        "keychain_available": state.secrets.keychain_available,
        "daemon_session": {
            "pid": state.pid,
            "startup_ts": state.startup_ts,
            "uptime_seconds": round(time.time() - state.startup_ts, 3),
        },
        "secret_stats": state.secrets.debug_stats(),
    }

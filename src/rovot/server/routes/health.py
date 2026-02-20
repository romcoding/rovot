from __future__ import annotations

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
    }

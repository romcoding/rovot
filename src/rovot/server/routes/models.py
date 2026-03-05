from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends, Query

from rovot.policy.engine import AuthContext
from rovot.server.deps import AppState, get_auth_ctx, get_state

router = APIRouter(tags=["models"])


@router.get("/models/available")
async def models_available(
    base_url: str | None = Query(default=None),
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    url = base_url or state.config_store.config.model.base_url
    if not url:
        return {"models": [], "error": "No base_url configured"}

    endpoint = url.rstrip("/") + "/models"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(endpoint)
            r.raise_for_status()
            data = r.json()
            models = data.get("data", [])
            return {"models": models, "base_url": url}
    except Exception as exc:
        return {"models": [], "base_url": url, "error": str(exc)}


@router.get("/models/providers")
async def model_providers(
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    cfg = state.config_store.config.model
    return {
        "provider_mode": cfg.provider_mode,
        "local": {"base_url": cfg.base_url, "model": cfg.model},
        "cloud": {
            "base_url": cfg.cloud_base_url,
            "model": cfg.cloud_model,
            "api_key_configured": bool(state.secrets.get(cfg.cloud_api_key_secret)),
        },
        "fallback_to_cloud": cfg.fallback_to_cloud,
    }

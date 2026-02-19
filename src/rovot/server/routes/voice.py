from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from rovot.policy.engine import AuthContext
from rovot.server.deps import AppState, get_auth_ctx, get_state

router = APIRouter(tags=["voice"])


@router.post("/voice/transcribe")
async def transcribe(
    _: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
    audio: UploadFile = File(...),
) -> dict:
    cfg = state.config_store.config.voice
    if not cfg.enabled or not cfg.asr_base_url or not cfg.asr_model:
        raise HTTPException(status_code=400, detail="Voice transcription not configured")
    api_key = state.secrets.get(cfg.asr_api_key_secret) or ""
    files = {
        "file": (
            audio.filename or "audio.webm",
            await audio.read(),
            audio.content_type or "application/octet-stream",
        )
    }
    form = {"model": cfg.asr_model}
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{cfg.asr_base_url.rstrip('/')}/audio/transcriptions",
            data=form,
            files=files,
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()
    return {"text": data.get("text") or data.get("transcript") or data}

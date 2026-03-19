from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from rovot.policy.engine import AuthContext
from rovot.policy.scopes import OPERATOR_ADMIN, OPERATOR_WRITE
from rovot.server.deps import AppState, get_auth_ctx, get_state

router = APIRouter(tags=["config"])


class UpdateConfigRequest(BaseModel):
    path: str
    value: object


class SetSecretRequest(BaseModel):
    key: str
    value: str


@router.get("/config")
async def get_config(
    _: AuthContext = Depends(get_auth_ctx), state: AppState = Depends(get_state)
) -> dict:
    return state.config_store.config.model_dump()


@router.post("/config")
async def update_config(
    req: UpdateConfigRequest,
    ctx: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict:
    if OPERATOR_WRITE not in ctx.scopes:
        return {"error": "Missing scope operator.write"}
    state.config_store.update_path(req.path, req.value)
    if req.path == "use_keychain":
        state.secrets.set_use_keychain(bool(req.value))
    return {"ok": True}


@router.get("/config/system-prompt")
async def get_system_prompt(
    _: AuthContext = Depends(get_auth_ctx),
) -> dict:
    p = Path.home() / ".rovot" / "system_prompt.txt"
    if p.exists():
        return {"custom": True, "prompt": p.read_text("utf-8")}
    return {"custom": False, "prompt": ""}


class SystemPromptRequest(BaseModel):
    prompt: str


@router.post("/config/system-prompt")
async def set_system_prompt(
    req: SystemPromptRequest,
    ctx: AuthContext = Depends(get_auth_ctx),
) -> dict:
    if OPERATOR_WRITE not in ctx.scopes:
        return {"error": "Missing scope"}
    p = Path.home() / ".rovot" / "system_prompt.txt"
    if req.prompt.strip():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(req.prompt.strip(), "utf-8")
        return {"ok": True, "saved": True}
    else:
        if p.exists():
            p.unlink()
        return {"ok": True, "saved": False, "note": "Reset to default"}


@router.post("/secrets")
async def set_secret(
    req: SetSecretRequest,
    ctx: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict:
    if OPERATOR_ADMIN not in ctx.scopes:
        return {"error": "Missing scope operator.admin"}
    state.secrets.set(req.key, req.value)
    if req.key == "auth.token":
        state.auth_token = req.value
    return {"ok": True}

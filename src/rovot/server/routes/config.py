from __future__ import annotations

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
    return {"ok": True}


@router.post("/secrets")
async def set_secret(
    req: SetSecretRequest,
    ctx: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict:
    if OPERATOR_ADMIN not in ctx.scopes:
        return {"error": "Missing scope operator.admin"}
    state.secrets.set(req.key, req.value)
    return {"ok": True}

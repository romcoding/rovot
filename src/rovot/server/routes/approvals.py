from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from rovot.policy.engine import AuthContext
from rovot.policy.scopes import OPERATOR_APPROVALS
from rovot.server.deps import AppState, get_auth_ctx, get_state

router = APIRouter(tags=["approvals"])


class ResolveRequest(BaseModel):
    decision: str  # allow | deny


@router.get("/approvals/pending")
async def pending(
    ctx: AuthContext = Depends(get_auth_ctx), state: AppState = Depends(get_state)
) -> dict:
    if OPERATOR_APPROVALS not in ctx.scopes:
        return {"error": "Missing scope operator.approvals"}
    return {"pending": [a.__dict__ for a in state.approvals.pending()]}


@router.post("/approvals/{approval_id}/resolve")
async def resolve(
    approval_id: str,
    req: ResolveRequest,
    ctx: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict:
    if OPERATOR_APPROVALS not in ctx.scopes:
        return {"error": "Missing scope operator.approvals"}
    ok = state.approvals.resolve(approval_id, req.decision, resolved_by="desktop")
    if ok:
        await state.ws.broadcast(
            "approval.resolved", {"id": approval_id, "decision": req.decision}
        )
    return {"ok": ok}

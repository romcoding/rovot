from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from rovot.policy.engine import AuthContext
from rovot.server.deps import AppState, get_auth_ctx, get_state

router = APIRouter(tags=["audit"])


@router.get("/audit/recent")
async def audit_recent(
    n: int = 100,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    if state.audit is None:
        return {"entries": []}
    return {"entries": state.audit.recent(n)}

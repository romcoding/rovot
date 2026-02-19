"""Tool execution status and approval endpoints."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/pending")
async def pending_approvals() -> dict:
    """List tool-execution requests awaiting user approval.

    TODO: wire up PolicyEngine / ApprovalManager.
    """
    return {"pending": []}


@router.post("/approve/{request_id}")
async def approve(request_id: str) -> dict:
    """Approve a pending tool-execution request.

    TODO: wire up PolicyEngine / ApprovalManager.
    """
    return {"request_id": request_id, "status": "approved"}


@router.post("/deny/{request_id}")
async def deny(request_id: str) -> dict:
    """Deny a pending tool-execution request.

    TODO: wire up PolicyEngine / ApprovalManager.
    """
    return {"request_id": request_id, "status": "denied"}

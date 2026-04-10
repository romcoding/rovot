"""Memory management API endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from rovot.agent.memory import delete_memory, list_memories, read_memory, write_memory
from rovot.policy.engine import AuthContext
from rovot.policy.scopes import OPERATOR_WRITE
from rovot.server.deps import get_auth_ctx

router = APIRouter(prefix="/memory", tags=["memory"])


class WriteMemoryRequest(BaseModel):
    content: str


@router.get("")
async def list_memory_files(auth: AuthContext = Depends(get_auth_ctx)) -> dict:
    """List all persistent memory files."""
    return {"memories": list_memories()}


@router.get("/{path:path}")
async def get_memory(path: str, auth: AuthContext = Depends(get_auth_ctx)) -> dict:
    """Read a persistent memory file."""
    try:
        return {"path": path, "content": read_memory(path)}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Memory not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{path:path}")
async def put_memory(
    path: str,
    req: WriteMemoryRequest,
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict:
    """Write or update a persistent memory file."""
    if OPERATOR_WRITE not in auth.scopes:
        raise HTTPException(status_code=403, detail="Missing scope operator.write")
    try:
        write_memory(path, req.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


@router.delete("/{path:path}")
async def delete_memory_file(
    path: str,
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict:
    """Delete a persistent memory file."""
    if OPERATOR_WRITE not in auth.scopes:
        raise HTTPException(status_code=403, detail="Missing scope operator.write")
    try:
        delete_memory(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}

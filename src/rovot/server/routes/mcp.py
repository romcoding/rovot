"""MCP server status endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from rovot.connectors.loader import get_mcp_clients
from rovot.policy.engine import AuthContext
from rovot.server.deps import AppState, get_auth_ctx, get_state

router = APIRouter(tags=["mcp"])


@router.get("/mcp/servers")
async def list_mcp_servers(
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict:
    """List connected MCP servers and their available tools."""
    cfg = state.config_store.config
    clients = await get_mcp_clients(cfg)
    return {
        "servers": [
            {
                "name": c.config.name,
                "tools": [t["name"] for t in c._tools],
                "tool_count": len(c._tools),
            }
            for c in clients
        ]
    }

"""Register tools from active MCP clients into the ToolRegistry."""
from __future__ import annotations

from rovot.agent.tools.registry import Tool, ToolRegistry
from rovot.connectors.mcp_client import McpClient


def register_mcp_tools(registry: ToolRegistry, clients: list[McpClient]) -> None:
    """Register all tools from all connected MCP clients."""
    for client in clients:
        for t in client._tools:
            tool_name = f"mcp_{client.config.name}__{t['name']}"
            captured_client = client
            captured_t_name = t["name"]

            async def _invoke(
                _client: McpClient = captured_client,
                _t_name: str = captured_t_name,
                **kwargs: object,
            ) -> object:
                return await _client.call_tool(_t_name, kwargs)

            registry.register(
                Tool(
                    name=tool_name,
                    description=f"[{client.config.name}] {t.get('description', '')}",
                    parameters=t.get("inputSchema", {"type": "object", "properties": {}}),
                    fn=_invoke,
                    requires_approval=False,
                )
            )

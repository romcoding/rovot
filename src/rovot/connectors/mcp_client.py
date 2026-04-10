"""MCP (Model Context Protocol) client connector.

Connects to local MCP servers via stdio transport and registers their
tools into Rovot's ToolRegistry. Each MCP server runs as a subprocess;
Rovot communicates via JSON-RPC over stdin/stdout.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class McpServerConfig:
    name: str
    command: list[str]  # e.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path"]
    env: dict[str, str] = field(default_factory=dict)


class McpClient:
    """Minimal MCP stdio client. Starts the server as a subprocess."""

    def __init__(self, config: McpServerConfig):
        self.config = config
        self._proc: asyncio.subprocess.Process | None = None
        self._tools: list[dict[str, Any]] = []
        self._request_id = 0
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        """Start the MCP server subprocess and perform the initialize handshake."""
        import os

        env = {**os.environ, **self.config.env}
        self._proc = await asyncio.create_subprocess_exec(
            *self.config.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        # MCP initialize
        await self._send(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "rovot", "version": "0.1.0"},
                },
            }
        )
        await self._recv()  # discard initialize result
        await self._send(
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
        )
        # Fetch tools
        await self._send(
            {"jsonrpc": "2.0", "id": self._next_id(), "method": "tools/list", "params": {}}
        )
        result = await self._recv()
        self._tools = (result.get("result") or {}).get("tools", [])
        logger.info(
            "MCP server '%s' started with %d tools", self.config.name, len(self._tools)
        )

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def _send(self, msg: dict[str, Any]) -> None:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("MCP server not started")
        line = json.dumps(msg) + "\n"
        self._proc.stdin.write(line.encode())
        await self._proc.stdin.drain()

    async def _recv(self) -> dict[str, Any]:
        if not self._proc or not self._proc.stdout:
            raise RuntimeError("MCP server not started")
        line = await self._proc.stdout.readline()
        return json.loads(line.decode().strip())

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """Call a tool on the MCP server and return the result."""
        async with self._lock:
            req_id = self._next_id()
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": arguments},
                }
            )
            result = await self._recv()
        if "error" in result:
            return {"error": result["error"]}
        content = (result.get("result") or {}).get("content", [])
        # Extract text from content blocks
        texts = [block.get("text", "") for block in content if block.get("type") == "text"]
        return "\n".join(texts) if texts else result.get("result", {})

    def get_tool_definitions(self) -> list[dict[str, Any]]:
        """Return OpenAI-compatible tool definitions for all tools in this MCP server."""
        defs = []
        for t in self._tools:
            defs.append(
                {
                    "type": "function",
                    "function": {
                        "name": f"mcp_{self.config.name}__{t['name']}",
                        "description": t.get("description", ""),
                        "parameters": t.get(
                            "inputSchema", {"type": "object", "properties": {}}
                        ),
                    },
                }
            )
        return defs

    async def stop(self) -> None:
        """Stop the MCP server subprocess."""
        if self._proc:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:
                pass
            finally:
                self._proc = None

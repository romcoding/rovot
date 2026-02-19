from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from rovot.policy.engine import AuthContext, PolicyEngine


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    fn: Callable[..., Awaitable[Any]]
    requires_write: bool = False
    requires_approval: bool = False
    approval_summary: str = ""


class ToolRegistry:
    def __init__(self, policy: PolicyEngine):
        self._tools: dict[str, Tool] = {}
        self._policy = policy

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def definitions(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in self._tools.values()
        ]

    async def invoke(
        self,
        ctx: AuthContext,
        session_id: str,
        name: str,
        arguments: dict[str, Any],
        *,
        tool_call_id: str | None = None,
        approved: bool = False,
    ) -> Any:
        tool = self._tools.get(name)
        if not tool:
            return {"error": f"Unknown tool: {name}"}
        if tool.requires_write:
            self._policy.enforce_write_scope(ctx)
        if tool.requires_approval and not approved:
            self._policy.maybe_require_approval(
                ctx=ctx,
                session_id=session_id,
                tool_name=tool.name,
                tool_args=arguments,
                summary=tool.approval_summary or f"Run tool {tool.name}",
                require=True,
                tool_call_id=tool_call_id,
            )
        return await tool.fn(**arguments)

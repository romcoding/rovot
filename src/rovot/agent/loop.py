from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from rovot.agent.context import ContextBuilder, Message
from rovot.agent.tools.registry import ToolRegistry
from rovot.policy.approvals import ApprovalRequired
from rovot.policy.engine import AuthContext
from rovot.providers.base import Provider


@dataclass
class AgentResponse:
    reply: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    pending_approval_id: str | None = None


class AgentLoop:
    def __init__(
        self,
        provider: Provider,
        tools: ToolRegistry,
        ctx_builder: ContextBuilder,
        max_iterations: int = 25,
    ):
        self._provider = provider
        self._tools = tools
        self._ctx = ctx_builder
        self._max_iterations = max_iterations

    async def run(
        self, *, auth: AuthContext, session_id: str, history: list[Message]
    ) -> AgentResponse:
        all_tool_calls: list[dict[str, Any]] = []
        msgs = list(history)
        for _ in range(self._max_iterations):
            ctx = self._ctx.build(msgs, self._tools.definitions())
            response = await self._provider.chat(
                messages=ContextBuilder.to_provider_messages(ctx),
                tools=ctx.tool_definitions or None,
            )
            if not response.tool_calls:
                return AgentResponse(reply=response.content, tool_calls=all_tool_calls)
            for tc in response.tool_calls:
                all_tool_calls.append(tc)
                try:
                    result = await self._tools.invoke(
                        auth,
                        session_id,
                        tc.get("name") or "",
                        tc.get("arguments") or {},
                        tool_call_id=tc.get("id") or None,
                    )
                    msgs.append(
                        Message(role="tool", content=str(result), tool_call_id=tc.get("id"))
                    )
                except ApprovalRequired as ar:
                    return AgentResponse(
                        reply=str(ar),
                        tool_calls=all_tool_calls,
                        pending_approval_id=ar.approval_id,
                    )
        return AgentResponse(
            reply="Reached maximum iterations without a final answer.",
            tool_calls=all_tool_calls,
        )

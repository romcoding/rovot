"""Core agent loop: messages -> context -> LLM -> tool calls -> response.

Iterates tool calls until the model produces a final answer or
``max_iterations`` is reached.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from rovot.agent.context import ContextBuilder, Message
from rovot.agent.tools.registry import ToolRegistry
from rovot.providers.base import Provider


@dataclass
class AgentResponse:
    reply: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


class AgentLoop:
    def __init__(
        self,
        provider: Provider,
        tool_registry: ToolRegistry,
        context_builder: ContextBuilder | None = None,
        max_iterations: int = 25,
    ):
        self._provider = provider
        self._tools = tool_registry
        self._ctx = context_builder or ContextBuilder()
        self._max_iterations = max_iterations

    async def run(self, messages: list[Message]) -> AgentResponse:
        """Execute one full agent turn.

        The loop calls the provider, checks for tool-use requests, executes
        approved tools, feeds results back, and repeats until the model emits
        a final text response or the iteration cap is hit.
        """
        history = list(messages)
        all_tool_calls: list[dict[str, Any]] = []

        for _ in range(self._max_iterations):
            context = self._ctx.build(history, self._tools.definitions())

            response = await self._provider.chat(
                messages=[
                    {"role": "system", "content": context.system_prompt},
                    *[{"role": m.role, "content": m.content} for m in context.messages],
                ],
                tools=context.tool_definitions or None,
            )

            if not response.tool_calls:
                return AgentResponse(reply=response.content, tool_calls=all_tool_calls)

            for tc in response.tool_calls:
                all_tool_calls.append(tc)
                result = await self._tools.invoke(tc["name"], tc.get("arguments", {}))
                history.append(Message(role="tool", content=str(result), tool_call_id=tc.get("id")))

        return AgentResponse(
            reply="Reached maximum iterations without a final answer.",
            tool_calls=all_tool_calls,
        )

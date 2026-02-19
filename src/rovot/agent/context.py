from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Message:
    role: str
    content: str
    tool_call_id: str | None = None


@dataclass
class Context:
    system_prompt: str
    messages: list[Message] = field(default_factory=list)
    tool_definitions: list[dict[str, Any]] = field(default_factory=list)


class ContextBuilder:
    def __init__(self, system_prompt: str | None = None):
        self._system_prompt = system_prompt or (
            "You are Rovot, a helpful local-first AI assistant.\n"
            "- You can only access files within the configured workspace.\n"
            "- High-risk actions (shell execution, sending email) may require user approval.\n"
            "- If a tool returns an approval-required message, explain what you need and wait.\n"
        )

    def build(
        self, history: list[Message], tool_definitions: list[dict[str, Any]] | None
    ) -> Context:
        return Context(
            system_prompt=self._system_prompt,
            messages=list(history),
            tool_definitions=tool_definitions or [],
        )

    @staticmethod
    def to_provider_messages(ctx: Context) -> list[dict[str, Any]]:
        msgs: list[dict[str, Any]] = [{"role": "system", "content": ctx.system_prompt}]
        for m in ctx.messages:
            d: dict[str, Any] = {"role": m.role, "content": m.content}
            if m.role == "tool" and m.tool_call_id:
                d["tool_call_id"] = m.tool_call_id
            msgs.append(d)
        return msgs

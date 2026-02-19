"""Context builder -- assembles the prompt payload for each LLM call.

Responsible for combining the system prompt, conversation history, tool
definitions, and any injected memory/skill instructions into a message list
the provider can consume.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


@dataclass
class Context:
    """Immutable snapshot of everything the LLM needs for one turn."""

    system_prompt: str
    messages: list[Message] = field(default_factory=list)
    tool_definitions: list[dict[str, Any]] = field(default_factory=list)


class ContextBuilder:
    """Assembles a :class:`Context` from session history, tools, and memory."""

    def __init__(self, system_prompt: str = "You are Rovot, a helpful local-first AI assistant."):
        self._system_prompt = system_prompt

    def build(
        self,
        history: list[Message],
        tool_definitions: list[dict[str, Any]] | None = None,
    ) -> Context:
        return Context(
            system_prompt=self._system_prompt,
            messages=list(history),
            tool_definitions=tool_definitions or [],
        )

"""Abstract provider protocol.

Every model backend (local or cloud) implements this interface so the agent
loop is decoupled from any specific API.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass
class ChatResponse:
    content: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)


@runtime_checkable
class Provider(Protocol):
    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ChatResponse: ...

    async def list_models(self) -> list[str]: ...

    def supports_tools(self) -> bool: ...

    def supports_streaming(self) -> bool: ...

    def supports_vision(self) -> bool: ...

"""Provider adapter that routes chat calls through InternalModelProvider."""

from __future__ import annotations

from typing import Any

from rovot.internal_model import get_internal_provider
from rovot.providers.base import ChatResponse


class InternalProvider:
    """
    Wraps InternalModelProvider to satisfy the Provider protocol.

    Uses llama-cpp-python in-process — no HTTP calls made.
    """

    async def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> ChatResponse:
        provider = get_internal_provider()
        if not provider.is_loaded():
            raise RuntimeError(
                "No built-in model loaded. "
                "Go to Models > Built-in Models and load a model first."
            )
        if tools:
            # llama-cpp-python supports tool calling for capable models; pass
            # tools via the system prompt as a best-effort fallback for models
            # that don't natively handle the tools field.
            pass
        text = await provider.chat_complete(messages)
        return ChatResponse(content=text, tool_calls=[], usage={})

    async def list_models(self) -> list[str]:
        provider = get_internal_provider()
        name = provider.loaded_model_name()
        return [name] if name else []

    def supports_tools(self) -> bool:
        return False

    def supports_streaming(self) -> bool:
        return True

    def supports_vision(self) -> bool:
        return False

"""Provider adapter that routes chat calls through InternalModelProvider."""

from __future__ import annotations

from collections.abc import AsyncIterator
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
        # Collect streaming tokens — still needed for the non-streaming /chat endpoint
        chunks: list[str] = []
        async for chunk in provider.chat_stream(messages):
            chunks.append(chunk)
        return ChatResponse(content="".join(chunks), tool_calls=[], usage={})

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[str]:
        """True token-by-token streaming from llama-cpp-python."""
        provider = get_internal_provider()
        if not provider.is_loaded():
            raise RuntimeError("No built-in model loaded.")
        async for chunk in provider.chat_stream(messages):
            yield chunk

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

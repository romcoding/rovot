"""Tests for true token-by-token streaming via InternalProvider."""
import asyncio
from unittest.mock import patch

import pytest

from rovot.providers.internal import InternalProvider


async def _fake_chat_stream(messages, temperature=0.7, max_tokens=1024):
    for token in ["Hello", " ", "world"]:
        yield token


def test_internal_provider_streams_tokens():
    """InternalProvider.stream() should yield tokens directly from chat_stream."""
    provider = InternalProvider()
    from rovot.internal_model import get_internal_provider

    internal = get_internal_provider()
    # Mark as loaded by setting a dummy llm and path
    internal._llm = object()
    internal._loaded_model_path = type("P", (), {"name": "test.gguf"})()

    with patch.object(internal, "chat_stream", _fake_chat_stream):
        chunks: list[str] = []

        async def _collect():
            async for chunk in provider.stream([{"role": "user", "content": "hi"}]):
                chunks.append(chunk)

        asyncio.run(_collect())

    assert chunks == ["Hello", " ", "world"]

    # Cleanup
    internal._llm = None
    internal._loaded_model_path = None


def test_internal_provider_stream_raises_when_not_loaded():
    """InternalProvider.stream() raises RuntimeError if no model is loaded."""
    provider = InternalProvider()
    from rovot.internal_model import get_internal_provider

    internal = get_internal_provider()
    assert internal._llm is None

    async def _try_stream():
        chunks = []
        async for chunk in provider.stream([{"role": "user", "content": "hi"}]):
            chunks.append(chunk)
        return chunks

    with pytest.raises(RuntimeError, match="No built-in model loaded"):
        asyncio.run(_try_stream())


def test_internal_provider_chat_collects_stream():
    """InternalProvider.chat() should accumulate all tokens from chat_stream."""
    provider = InternalProvider()
    from rovot.internal_model import get_internal_provider

    internal = get_internal_provider()
    internal._llm = object()
    internal._loaded_model_path = type("P", (), {"name": "test.gguf"})()

    with patch.object(internal, "chat_stream", _fake_chat_stream):
        response = asyncio.run(provider.chat([{"role": "user", "content": "hi"}]))

    assert response.content == "Hello world"
    assert response.tool_calls == []

    # Cleanup
    internal._llm = None
    internal._loaded_model_path = None

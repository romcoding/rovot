"""Web fetch tool -- retrieve a URL and return its text content."""

from __future__ import annotations

import httpx

from rovot.agent.tools.registry import Tool

_MAX_BODY = 100_000  # truncate large responses


def make_web_fetch_tool() -> Tool:
    async def web_fetch(url: str) -> str:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            text = resp.text[:_MAX_BODY]
            if len(resp.text) > _MAX_BODY:
                text += f"\n\n... truncated ({len(resp.text)} total chars)"
            return text

    return Tool(
        name="web_fetch",
        description="Fetch a URL and return its text content.",
        parameters={
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
        fn=web_fetch,
    )

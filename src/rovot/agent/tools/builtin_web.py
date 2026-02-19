from __future__ import annotations

import httpx

from rovot.agent.tools.registry import Tool


def register_web_tools(registry) -> None:
    registry.register(
        Tool(
            name="web.fetch",
            description="Fetch a URL via HTTP GET and return truncated text.",
            parameters={
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
                "additionalProperties": False,
            },
            fn=_fetch,
        )
    )


async def _fetch(url: str) -> dict:
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        text = r.text
        return {"status": r.status_code, "text": text[:5000]}

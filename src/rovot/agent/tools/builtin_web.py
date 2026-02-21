from __future__ import annotations

from urllib.parse import urlparse

import httpx

from rovot.agent.tools.registry import Tool


def register_web_tools(registry, allowed_domains: list[str] | None = None) -> None:
    registry.register(
        Tool(
            name="web.fetch",
            description="Fetch a URL via HTTP GET and return truncated text. Requires approval.",
            parameters={
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
                "additionalProperties": False,
            },
            fn=lambda url: _fetch(url, allowed_domains or []),
            requires_approval=True,
            approval_summary="Fetch a URL",
        )
    )


async def _fetch(url: str, allowed_domains: list[str]) -> dict:
    if allowed_domains:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        if not any(hostname == d or hostname.endswith("." + d) for d in allowed_domains):
            return {"error": f"Domain '{hostname}' not in allowed list: {allowed_domains}"}

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        text = r.text
        return {"status": r.status_code, "text": text[:5000]}

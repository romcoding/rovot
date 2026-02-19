from __future__ import annotations

import json
from typing import Any

import httpx

from rovot.providers.base import ChatResponse


class OpenAICompatProvider:
    def __init__(
        self, base_url: str, api_key: str = "", model: str = "", timeout: float = 120.0
    ):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        return h

    async def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> ChatResponse:
        payload: dict[str, Any] = {"messages": messages}
        if self._model:
            payload["model"] = self._model
        if tools:
            payload["tools"] = tools
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                f"{self._base_url}/chat/completions",
                json=payload,
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()
        msg = data["choices"][0]["message"]
        tool_calls: list[dict[str, Any]] = []
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            args_raw = fn.get("arguments", "{}")
            if isinstance(args_raw, str):
                try:
                    args = json.loads(args_raw) if args_raw.strip() else {}
                except Exception:
                    args = {"_raw": args_raw}
            elif isinstance(args_raw, dict):
                args = args_raw
            else:
                args = {"_raw": str(args_raw)}
            tool_calls.append(
                {"id": tc.get("id", ""), "name": fn.get("name", ""), "arguments": args}
            )
        return ChatResponse(
            content=(msg.get("content") or ""),
            tool_calls=tool_calls,
            usage=data.get("usage") or {},
        )

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self._base_url}/models", headers=self._headers())
            resp.raise_for_status()
            data = resp.json()
        return [m["id"] for m in data.get("data") or [] if "id" in m]

    def supports_tools(self) -> bool:
        return True

    def supports_streaming(self) -> bool:
        return True

    def supports_vision(self) -> bool:
        return False

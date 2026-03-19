from __future__ import annotations

import json
from collections.abc import AsyncIterator
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
        self._resolved_model = ""
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        return h

    async def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> ChatResponse:
        payload: dict[str, Any] = {"messages": messages, "model": await self._model_for_request()}
        if tools:
            payload["tools"] = tools
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            try:
                resp = await client.post(
                    f"{self._base_url}/chat/completions",
                    json=payload,
                    headers=self._headers(),
                )
                resp.raise_for_status()
                data = resp.json()
            except httpx.HTTPStatusError as exc:
                body = exc.response.text[:500] if exc.response is not None else ""
                detail = body or str(exc)
                raise RuntimeError(
                    f"{self._base_url}/chat/completions returned HTTP {exc.response.status_code}: {detail}"
                ) from exc
            except httpx.HTTPError as exc:
                raise RuntimeError(
                    f"Failed to reach model provider at {self._base_url}: {exc}"
                ) from exc
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

    async def _model_for_request(self) -> str:
        if self._model:
            return self._model
        if self._resolved_model:
            return self._resolved_model
        models = await self.list_models()
        if models:
            self._resolved_model = models[0]
            return self._resolved_model
        raise RuntimeError(
            "No model configured and none detected at /models. Set model.model or load a model in your local server."
        )

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self._base_url}/models", headers=self._headers())
            resp.raise_for_status()
            data = resp.json()
        return [m["id"] for m in data.get("data") or [] if "id" in m]

    async def chat_stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> AsyncIterator[str]:
        """Stream tokens from chat completions endpoint. Yields text delta chunks."""
        payload: dict[str, Any] = {
            "messages": messages,
            "model": await self._model_for_request(),
            "stream": True,
        }
        if tools:
            payload["tools"] = tools
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            try:
                async with client.stream(
                    "POST",
                    f"{self._base_url}/chat/completions",
                    json=payload,
                    headers=self._headers(),
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data.strip() == "[DONE]":
                            return
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content")
                        if content:
                            yield content
            except httpx.HTTPStatusError as exc:
                body = exc.response.text[:500] if exc.response is not None else ""
                raise RuntimeError(
                    f"{self._base_url}/chat/completions stream returned HTTP {exc.response.status_code}: {body}"
                ) from exc
            except httpx.HTTPError as exc:
                raise RuntimeError(
                    f"Failed to reach model provider at {self._base_url}: {exc}"
                ) from exc

    def supports_tools(self) -> bool:
        return True

    def supports_streaming(self) -> bool:
        return True

    def supports_vision(self) -> bool:
        return False

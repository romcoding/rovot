from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket


@dataclass
class WsClient:
    ws: WebSocket
    scopes: list[str]


class WebSocketHub:
    def __init__(self):
        self._clients: list[WsClient] = []
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket, scopes: list[str]) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.append(WsClient(ws=ws, scopes=scopes))

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients = [c for c in self._clients if c.ws is not ws]

    async def broadcast(self, event: str, payload: dict[str, Any]) -> None:
        msg = json.dumps(
            {"type": "event", "event": event, "payload": payload}, ensure_ascii=False
        )
        async with self._lock:
            clients = list(self._clients)
        for c in clients:
            try:
                await c.ws.send_text(msg)
            except Exception:
                await self.disconnect(c.ws)

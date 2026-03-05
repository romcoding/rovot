from __future__ import annotations

from rovot.channels.base import ChannelAdapter, IncomingMessage


class SignalCliAdapter(ChannelAdapter):
    def __init__(self, verify_secret: str):
        self._verify_secret = verify_secret

    def parse_incoming(self, payload: dict, headers: dict[str, str]) -> IncomingMessage:
        if self._verify_secret and headers.get("x-rovot-channel-secret", "") != self._verify_secret:
            raise ValueError("Invalid Signal webhook secret")
        envelope = payload.get("envelope") or {}
        data = payload.get("dataMessage") or {}
        return IncomingMessage(
            user_id=str(envelope.get("sourceNumber", "unknown")),
            text=str(data.get("message", "")).strip(),
            channel="signal",
        )

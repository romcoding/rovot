from __future__ import annotations

from dataclasses import dataclass


@dataclass
class IncomingMessage:
    user_id: str
    text: str
    channel: str


class ChannelAdapter:
    def parse_incoming(self, payload: dict, headers: dict[str, str]) -> IncomingMessage:
        raise NotImplementedError

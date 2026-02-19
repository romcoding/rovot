from __future__ import annotations

from dataclasses import dataclass


@dataclass
class MessagingLocalConnector:
    enabled: bool = False

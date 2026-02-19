from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from rovot.agent.tools.registry import ToolRegistry


@dataclass
class ConnectorManifest:
    id: str
    description: str


class Connector(Protocol):
    manifest: ConnectorManifest

    def register_tools(self, registry: ToolRegistry) -> None: ...

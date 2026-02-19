"""Abstract connector protocol.

A connector bridges the agent to an external service (email, calendar,
messaging, etc.).  Every connector declares its manifest so the policy
engine and the UI can reason about what it needs and what it can do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, runtime_checkable


class Capability(str, Enum):
    MESSAGING = "messaging"
    EMAIL = "email"
    CALENDAR = "calendar"
    FILES = "files"
    BROWSER = "browser"
    AUTOMATION = "automation"


@dataclass
class ConnectorManifest:
    """Declarative description of what a connector needs and does."""

    id: str
    name: str
    capabilities: list[Capability]
    required_scopes: list[str] = field(default_factory=list)
    data_domains: list[str] = field(default_factory=list)
    can_write: bool = False
    approval_required_actions: list[str] = field(default_factory=list)
    retention_policy: str = "none"


@runtime_checkable
class Connector(Protocol):
    @property
    def manifest(self) -> ConnectorManifest: ...

    async def connect(self, credentials: dict[str, Any]) -> None: ...

    async def disconnect(self) -> None: ...

    async def health_check(self) -> bool: ...

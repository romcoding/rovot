"""Two-phase approval flow for high-risk tool execution.

Mirrors the exec-approval pattern from OpenClaw: a tool call is created as
a pending request, the UI (or an automated policy) resolves it, and only then
does execution proceed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    EXPIRED = "expired"


@dataclass
class ApprovalRequest:
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    tool_name: str = ""
    arguments: dict[str, Any] = field(default_factory=dict)
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    timeout: timedelta = field(default_factory=lambda: timedelta(minutes=5))

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.created_at + self.timeout


class ApprovalManager:
    """Tracks pending approval requests with idempotency and expiry."""

    def __init__(self) -> None:
        self._requests: dict[str, ApprovalRequest] = {}

    def create(self, tool_name: str, arguments: dict[str, Any]) -> ApprovalRequest:
        req = ApprovalRequest(tool_name=tool_name, arguments=arguments)
        self._requests[req.id] = req
        return req

    def resolve(self, request_id: str, approved: bool) -> ApprovalRequest | None:
        req = self._requests.get(request_id)
        if req is None or req.status != ApprovalStatus.PENDING:
            return None
        if req.is_expired:
            req.status = ApprovalStatus.EXPIRED
            return req
        req.status = ApprovalStatus.APPROVED if approved else ApprovalStatus.DENIED
        return req

    def pending(self) -> list[ApprovalRequest]:
        self._expire_stale()
        return [r for r in self._requests.values() if r.status == ApprovalStatus.PENDING]

    def _expire_stale(self) -> None:
        for req in self._requests.values():
            if req.status == ApprovalStatus.PENDING and req.is_expired:
                req.status = ApprovalStatus.EXPIRED

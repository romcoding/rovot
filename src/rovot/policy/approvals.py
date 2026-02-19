from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


class ApprovalRequired(Exception):
    def __init__(self, approval_id: str, message: str):
        super().__init__(message)
        self.approval_id = approval_id


@dataclass
class Approval:
    id: str
    created_at_ms: int
    expires_at_ms: int
    tool_name: str
    summary: str
    session_id: str
    status: str = "pending"  # pending | allow | deny | expired
    resolved_by: str | None = None
    resolved_at_ms: int | None = None
    tool_arguments: dict[str, Any] | None = None


class ApprovalManager:
    def __init__(self, path: Path):
        self._path = path
        self._approvals: dict[str, Approval] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text("utf-8"))
            for rec in raw:
                a = Approval(**rec)
                self._approvals[a.id] = a
        except Exception:
            self._approvals = {}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps([asdict(a) for a in self._approvals.values()], indent=2), "utf-8"
        )

    def create(
        self,
        *,
        tool_name: str,
        summary: str,
        session_id: str,
        tool_arguments: dict[str, Any],
        timeout_ms: int = 300000,
    ) -> Approval:
        now = int(time.time() * 1000)
        a = Approval(
            id=str(uuid.uuid4()),
            created_at_ms=now,
            expires_at_ms=now + timeout_ms,
            tool_name=tool_name,
            summary=summary,
            session_id=session_id,
            tool_arguments=tool_arguments,
        )
        self._approvals[a.id] = a
        self._save()
        return a

    def pending(self) -> list[Approval]:
        now = int(time.time() * 1000)
        out: list[Approval] = []
        for a in self._approvals.values():
            if a.status == "pending" and now <= a.expires_at_ms:
                out.append(a)
            elif a.status == "pending" and now > a.expires_at_ms:
                a.status = "expired"
        self._save()
        return out

    def get(self, approval_id: str) -> Approval | None:
        return self._approvals.get(approval_id)

    def resolve(
        self, approval_id: str, decision: str, resolved_by: str | None = None
    ) -> bool:
        a = self._approvals.get(approval_id)
        if not a or a.status != "pending":
            return False
        now = int(time.time() * 1000)
        if now > a.expires_at_ms:
            a.status = "expired"
            self._save()
            return False
        if decision not in ("allow", "deny"):
            return False
        a.status = decision
        a.resolved_by = resolved_by
        a.resolved_at_ms = now
        self._save()
        return True

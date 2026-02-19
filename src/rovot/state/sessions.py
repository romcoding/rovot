"""Session store -- persist conversation sessions as local JSON files.

Supports save/load/prune with TTL-based expiry and file rotation to
prevent unbounded growth.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


class SessionStore:
    def __init__(self, base_dir: Path, ttl: timedelta = timedelta(days=30)):
        self._dir = base_dir / "sessions"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._ttl = ttl

    def new_id(self) -> str:
        return uuid.uuid4().hex[:16]

    def _path(self, session_id: str) -> Path:
        return self._dir / f"{session_id}.json"

    def save(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        payload = {
            "session_id": session_id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "messages": messages,
        }
        self._path(session_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def load(self, session_id: str) -> list[dict[str, Any]]:
        path = self._path(session_id)
        if not path.exists():
            return []
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("messages", [])

    def list_sessions(self) -> list[str]:
        return [p.stem for p in sorted(self._dir.glob("*.json"))]

    def prune(self) -> int:
        """Delete sessions older than the TTL. Returns the number pruned."""
        cutoff = datetime.now(timezone.utc) - self._ttl
        pruned = 0
        for path in self._dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                updated = datetime.fromisoformat(data["updated_at"])
                if updated < cutoff:
                    path.unlink()
                    pruned += 1
            except (json.JSONDecodeError, KeyError, OSError):
                continue
        return pruned

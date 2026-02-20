from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_REDACTED_KEYS = frozenset({
    "password", "secret", "token", "api_key", "apikey",
    "credential", "auth", "authorization",
})


def _redact(obj: Any, depth: int = 0) -> Any:
    if depth > 10:
        return obj
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if any(rk in k.lower() for rk in _REDACTED_KEYS):
                out[k] = "**REDACTED**"
            else:
                out[k] = _redact(v, depth + 1)
        return out
    if isinstance(obj, list):
        return [_redact(item, depth + 1) for item in obj]
    return obj


@dataclass
class AuditLogger:
    path: Path
    max_recent: int = field(default=200)

    def log(self, event: str, payload: dict[str, Any]) -> None:
        safe_payload = _redact(payload)
        rec = {"ts": int(time.time() * 1000), "event": event, "payload": safe_payload}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def recent(self, n: int | None = None) -> list[dict[str, Any]]:
        limit = n or self.max_recent
        if not self.path.exists():
            return []
        lines = self.path.read_text("utf-8").strip().splitlines()
        entries = []
        for line in lines[-limit:]:
            try:
                entries.append(json.loads(line))
            except Exception:
                continue
        return entries

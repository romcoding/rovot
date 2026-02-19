from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class AuditLogger:
    path: Path

    def log(self, event: str, payload: dict[str, Any]) -> None:
        rec = {"ts": int(time.time() * 1000), "event": event, "payload": payload}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from rovot.agent.context import Message


@dataclass
class Session:
    id: str
    path: Path

    def append(self, msg: Message) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        rec = {
            "ts": int(time.time() * 1000),
            "role": msg.role,
            "content": msg.content,
            "tool_call_id": msg.tool_call_id,
        }
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def read_all(self) -> list[Message]:
        if not self.path.exists():
            return []
        out: list[Message] = []
        for line in self.path.read_text("utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            out.append(
                Message(
                    role=rec["role"],
                    content=rec["content"],
                    tool_call_id=rec.get("tool_call_id"),
                )
            )
        return out


class SessionStore:
    def __init__(self, root: Path):
        self._root = root

    def create(self) -> Session:
        sid = str(uuid.uuid4())
        return Session(id=sid, path=self._root / f"{sid}.jsonl")

    def get(self, session_id: str) -> Session:
        return Session(id=session_id, path=self._root / f"{session_id}.jsonl")

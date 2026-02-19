from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from rovot.utils_paths import resolve_in_workspace


@dataclass
class FileSystemConnector:
    workspace: Path

    def read_text(self, path: str) -> str:
        p = resolve_in_workspace(self.workspace, path)
        return p.read_text("utf-8")

    def write_text(self, path: str, content: str) -> str:
        p = resolve_in_workspace(self.workspace, path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, "utf-8")
        return "ok"

    def list_dir(self, path: str = ".") -> list[str]:
        p = resolve_in_workspace(self.workspace, path)
        if not p.exists() or not p.is_dir():
            return []
        return sorted([x.name for x in p.iterdir()])

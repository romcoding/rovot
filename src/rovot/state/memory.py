"""Markdown-based memory consolidation.

Long-running sessions periodically consolidate key facts into a
human-readable MEMORY.md file that persists across sessions and can be
reviewed or edited by the user.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path


class MemoryStore:
    def __init__(self, base_dir: Path):
        self._path = base_dir / "MEMORY.md"

    def read(self) -> str:
        if self._path.exists():
            return self._path.read_text(encoding="utf-8")
        return ""

    def append(self, entry: str) -> None:
        """Append a timestamped entry to the memory file."""
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        block = f"\n## {timestamp}\n\n{entry.strip()}\n"

        with self._path.open("a", encoding="utf-8") as f:
            if self._path.stat().st_size == 0:
                f.write("# Rovot Memory\n")
            f.write(block)

    def clear(self) -> None:
        if self._path.exists():
            self._path.unlink()

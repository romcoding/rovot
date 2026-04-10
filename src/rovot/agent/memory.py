"""Local workspace memory — persistent markdown files the agent reads each session.

Inspired by Claude Managed Agents' memory stores, but running entirely locally.
Files live in ~/.rovot/memory/ and are injected into the system prompt context.
"""
from __future__ import annotations

from pathlib import Path

MEMORY_DIR = Path.home() / ".rovot" / "memory"
MAX_MEMORY_TOKENS = 2000  # rough limit to avoid bloating context


def ensure_memory_dir() -> Path:
    """Create the memory directory if it doesn't exist."""
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    return MEMORY_DIR


def list_memories() -> list[dict]:
    """List all memory files with metadata."""
    ensure_memory_dir()
    memories = []
    for f in sorted(MEMORY_DIR.glob("**/*.md")):
        memories.append(
            {
                "path": str(f.relative_to(MEMORY_DIR)),
                "size_bytes": f.stat().st_size,
                "content_preview": f.read_text("utf-8")[:200],
            }
        )
    return memories


def read_memory(path: str) -> str:
    """Read a memory file."""
    p = MEMORY_DIR / path
    if not p.is_relative_to(MEMORY_DIR):
        raise ValueError("Path escapes memory directory")
    return p.read_text("utf-8")


def write_memory(path: str, content: str) -> None:
    """Write a memory file, creating directories as needed."""
    p = MEMORY_DIR / path
    if not p.is_relative_to(MEMORY_DIR):
        raise ValueError("Path escapes memory directory")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, "utf-8")


def delete_memory(path: str) -> None:
    """Delete a memory file."""
    p = MEMORY_DIR / path
    if not p.is_relative_to(MEMORY_DIR):
        raise ValueError("Path escapes memory directory")
    if p.exists():
        p.unlink()


def build_memory_context() -> str:
    """Load all memory files and return them as a context block.

    Injected into the agent's system prompt when memory files exist.
    Truncated to MAX_MEMORY_TOKENS worth of characters.
    """
    ensure_memory_dir()
    files = sorted(MEMORY_DIR.glob("**/*.md"))
    if not files:
        return ""

    parts = [
        "\n\n## Persistent Memory\n",
        "The following information persists across sessions:\n",
    ]
    total_chars = 0
    char_budget = MAX_MEMORY_TOKENS * 4  # ~4 chars per token

    for f in files:
        try:
            text = f.read_text("utf-8")
            header = f"### {f.relative_to(MEMORY_DIR)}\n"
            chunk = header + text + "\n"
            if total_chars + len(chunk) > char_budget:
                break
            parts.append(chunk)
            total_chars += len(chunk)
        except Exception:
            continue

    return "".join(parts)

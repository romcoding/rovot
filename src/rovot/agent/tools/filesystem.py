"""Filesystem tools -- read/write/list/edit confined to the workspace."""

from __future__ import annotations

from pathlib import Path

from rovot.agent.tools.registry import Tool
from rovot.isolation.workspace import WorkspaceGuard


def make_filesystem_tools(guard: WorkspaceGuard) -> list[Tool]:
    """Return the set of filesystem tools bound to a workspace guard."""

    async def read_file(path: str) -> str:
        resolved = guard.resolve(path)
        return resolved.read_text(encoding="utf-8")

    async def write_file(path: str, content: str) -> str:
        resolved = guard.resolve(path)
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding="utf-8")
        return f"Wrote {len(content)} chars to {resolved.relative_to(guard.root)}"

    async def list_dir(path: str = ".") -> str:
        resolved = guard.resolve(path)
        if not resolved.is_dir():
            return f"Not a directory: {path}"
        entries = sorted(resolved.iterdir())
        return "\n".join(
            f"{'[dir]  ' if e.is_dir() else '[file] '}{e.name}" for e in entries
        )

    return [
        Tool(
            name="read_file",
            description="Read the contents of a file inside the workspace.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            fn=read_file,
        ),
        Tool(
            name="write_file",
            description="Write content to a file inside the workspace.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
            fn=write_file,
        ),
        Tool(
            name="list_dir",
            description="List entries in a workspace directory.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
            },
            fn=list_dir,
        ),
    ]

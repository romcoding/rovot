from __future__ import annotations

from pathlib import Path

from rovot.agent.tools.registry import Tool
from rovot.connectors.filesystem import FileSystemConnector


def register_fs_tools(registry, fs: FileSystemConnector, workspace: Path) -> None:
    registry.register(
        Tool(
            name="fs.read",
            description="Read a UTF-8 text file within the workspace.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            fn=lambda path: _async_wrap(lambda: fs.read_text(path)),
        )
    )
    registry.register(
        Tool(
            name="fs.write",
            description="Write a UTF-8 text file within the workspace.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
                "additionalProperties": False,
            },
            fn=lambda path, content: _async_wrap(lambda: fs.write_text(path, content)),
            requires_write=True,
        )
    )
    registry.register(
        Tool(
            name="fs.list_dir",
            description="List a directory within the workspace.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": [],
                "additionalProperties": False,
            },
            fn=lambda path=".": _async_wrap(lambda: fs.list_dir(path)),
        )
    )


async def _async_wrap(fn):
    return fn()

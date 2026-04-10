"""Memory tools — let the agent read and write persistent memory files."""
from __future__ import annotations

from rovot.agent.memory import list_memories, read_memory, write_memory
from rovot.agent.tools.registry import Tool, ToolRegistry


async def _async_list() -> object:
    return list_memories()


async def _async_read(path: str) -> str:
    return read_memory(path)


async def _async_write(path: str, content: str) -> dict:
    write_memory(path, content)
    return {"ok": True, "path": path}


def register_memory_tools(registry: ToolRegistry) -> None:
    """Register memory read/write tools into the ToolRegistry."""
    registry.register(
        Tool(
            name="memory.list",
            description="List all persistent memory files. Memory persists across sessions.",
            parameters={"type": "object", "properties": {}, "required": []},
            fn=lambda: _async_list(),
        )
    )
    registry.register(
        Tool(
            name="memory.read",
            description="Read a persistent memory file by path (relative to memory root).",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            fn=lambda path: _async_read(path),
        )
    )
    registry.register(
        Tool(
            name="memory.write",
            description=(
                "Write or update a persistent memory file. Use this to save important "
                "information that should be remembered in future sessions. "
                "Path is relative (e.g. 'preferences.md')."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
            fn=lambda path, content: _async_write(path, content),
            requires_write=True,
        )
    )

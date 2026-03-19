"""macOS automation tools: AppleScript, screenshots, clipboard, and app control."""
from __future__ import annotations

import asyncio
import base64
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from rovot.agent.tools.registry import Tool, ToolRegistry


async def run_applescript(script: str) -> dict[str, Any]:
    """Run an AppleScript string. Returns stdout/stderr/exit_code."""
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return {
        "exit_code": proc.returncode,
        "stdout": out.decode("utf-8", "ignore"),
        "stderr": err.decode("utf-8", "ignore"),
    }


async def take_screenshot(region: str = "full") -> dict[str, Any]:
    """Take a screenshot. region: 'full' | 'active_window'.

    Returns {"base64": "...", "format": "png"}.
    """
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    try:
        if region == "active_window":
            cmd = ["screencapture", "-x", "-w", path]
        else:
            cmd = ["screencapture", "-x", path]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        data = Path(path).read_bytes()
        return {"base64": base64.b64encode(data).decode(), "format": "png"}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


async def get_frontmost_app() -> dict[str, Any]:
    """Get the name and bundle ID of the currently focused application."""
    script = (
        'tell application "System Events" to get {name, bundle identifier} '
        "of first application process whose frontmost is true"
    )
    result = await run_applescript(script)
    return {"output": result.get("stdout", "").strip(), "exit_code": result.get("exit_code")}


async def open_application(app_name: str) -> dict[str, Any]:
    """Open an application by name using `open -a`."""
    proc = await asyncio.create_subprocess_exec(
        "open", "-a", app_name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return {
        "exit_code": proc.returncode,
        "stdout": out.decode("utf-8", "ignore"),
        "stderr": err.decode("utf-8", "ignore"),
    }


async def get_clipboard() -> dict[str, Any]:
    """Get current clipboard text content using pbpaste."""
    proc = await asyncio.create_subprocess_exec(
        "pbpaste",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return {
        "text": out.decode("utf-8", "ignore"),
        "exit_code": proc.returncode,
    }


async def set_clipboard(text: str) -> dict[str, Any]:
    """Set clipboard text content using pbcopy."""
    proc = await asyncio.create_subprocess_exec(
        "pbcopy",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate(input=text.encode("utf-8"))
    return {
        "exit_code": proc.returncode,
        "stderr": err.decode("utf-8", "ignore"),
    }


def register_macos_tools(registry: ToolRegistry, enabled: bool = False) -> None:
    """Register macOS automation tools. Only active on macOS when enabled."""
    if not enabled or sys.platform != "darwin":
        return

    registry.register(
        Tool(
            name="macos.applescript",
            description="Run an AppleScript to control macOS applications and the OS itself.",
            parameters={
                "type": "object",
                "properties": {
                    "script": {
                        "type": "string",
                        "description": "The AppleScript code to execute",
                    },
                },
                "required": ["script"],
            },
            fn=run_applescript,
            requires_approval=True,
            approval_summary="Execute AppleScript (can control apps, files, and system settings)",
        )
    )

    registry.register(
        Tool(
            name="macos.screenshot",
            description="Take a screenshot of the screen or active window.",
            parameters={
                "type": "object",
                "properties": {
                    "region": {
                        "type": "string",
                        "enum": ["full", "active_window"],
                        "description": "Area to capture: 'full' for full screen, 'active_window' for focused window",
                    },
                },
                "required": [],
            },
            fn=take_screenshot,
            requires_approval=False,
        )
    )

    registry.register(
        Tool(
            name="macos.get_frontmost_app",
            description="Get the name and bundle ID of the currently focused macOS application.",
            parameters={
                "type": "object",
                "properties": {},
                "required": [],
            },
            fn=get_frontmost_app,
            requires_approval=False,
        )
    )

    registry.register(
        Tool(
            name="macos.open_app",
            description="Open an application by name.",
            parameters={
                "type": "object",
                "properties": {
                    "app_name": {
                        "type": "string",
                        "description": "The name of the application to open (e.g., 'Safari', 'Finder')",
                    },
                },
                "required": ["app_name"],
            },
            fn=open_application,
            requires_approval=True,
            approval_summary="Open a macOS application",
        )
    )

    registry.register(
        Tool(
            name="macos.get_clipboard",
            description="Get the current clipboard text content.",
            parameters={
                "type": "object",
                "properties": {},
                "required": [],
            },
            fn=get_clipboard,
            requires_approval=False,
        )
    )

    registry.register(
        Tool(
            name="macos.set_clipboard",
            description="Set the clipboard text content.",
            parameters={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Text to copy to the clipboard",
                    },
                },
                "required": ["text"],
            },
            fn=set_clipboard,
            requires_approval=True,
            approval_summary="Overwrite clipboard contents",
        )
    )

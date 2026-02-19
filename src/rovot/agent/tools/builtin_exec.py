from __future__ import annotations

import asyncio
import os
import shlex
from dataclasses import dataclass
from pathlib import Path

from rovot.agent.tools.registry import Tool
from rovot.utils_paths import resolve_in_workspace


@dataclass
class ExecConfig:
    workspace: Path
    security_mode: str


async def _run_host(command: str, cwd: Path) -> dict:
    args = shlex.split(command)
    p = await asyncio.create_subprocess_exec(
        *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ},
    )
    out, err = await p.communicate()
    return {
        "exit_code": p.returncode,
        "stdout": out.decode("utf-8", "ignore"),
        "stderr": err.decode("utf-8", "ignore"),
    }


async def _run_docker(command: str, workspace: Path) -> dict:
    args = [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "-v",
        f"{workspace}:/workspace:rw",
        "-w",
        "/workspace",
        "python:3.11-slim",
        "bash",
        "-lc",
        command,
    ]
    p = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await p.communicate()
    return {
        "exit_code": p.returncode,
        "stdout": out.decode("utf-8", "ignore"),
        "stderr": err.decode("utf-8", "ignore"),
    }


def register_exec_tool(registry, cfg: ExecConfig) -> None:
    registry.register(
        Tool(
            name="exec.run",
            description="Run a shell command (high risk; requires approval).",
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string", "default": "."},
                },
                "required": ["command"],
                "additionalProperties": False,
            },
            fn=lambda command, cwd=".": _exec_impl(cfg, command, cwd),
            requires_write=True,
            requires_approval=True,
            approval_summary="Execute a shell command",
        )
    )


async def _exec_impl(cfg: ExecConfig, command: str, cwd: str = ".") -> dict:
    cwd_abs = resolve_in_workspace(cfg.workspace, cwd)
    if cfg.security_mode == "container":
        return await _run_docker(command, cfg.workspace)
    return await _run_host(command, cwd_abs)

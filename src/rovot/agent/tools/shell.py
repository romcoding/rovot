"""Shell exec tool -- runs commands inside the workspace with an approval gate."""

from __future__ import annotations

import asyncio

from rovot.agent.tools.registry import Tool


def make_shell_tool(workspace_dir: str, *, timeout: float = 30.0) -> Tool:
    """Return a shell-exec tool bound to a working directory.

    Approval gating is handled by the policy engine *before* this function
    is called -- by the time ``run_shell`` executes, the action has already
    been approved.
    """

    async def run_shell(command: str) -> str:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=workspace_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return f"Command timed out after {timeout}s"

        output = stdout.decode(errors="replace")
        if stderr:
            output += "\n[stderr]\n" + stderr.decode(errors="replace")
        return output.strip() or "(no output)"

    return Tool(
        name="shell_exec",
        description="Execute a shell command inside the workspace directory.",
        parameters={
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
        fn=run_shell,
    )

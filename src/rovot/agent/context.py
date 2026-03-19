from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class Message:
    role: str
    content: str
    tool_call_id: str | None = None


@dataclass
class Context:
    system_prompt: str
    messages: list[Message] = field(default_factory=list)
    tool_definitions: list[dict[str, Any]] = field(default_factory=list)


_DEFAULT_SYSTEM_PROMPT = """\
You are Rovot, a powerful local-first AI agent running on the user's Mac.
Your goal is to be genuinely useful — actually DO things, not just explain them.

CAPABILITIES:
- Read, write, and list files within the user's workspace (fs.read, fs.write, fs.list_dir)
- Execute shell commands on the user's Mac — but always ask for approval first (exec.run)
- Browse the web and read page content (browser.navigate, browser.search(query, engine) — web search DuckDuckGo by default, browser.get_page_content)
- Read emails from the user's inbox (email.list_recent)
- Send emails — always requires user approval (email.send)
- Take screenshots to see what's on screen (macos.screenshot)
- Control macOS via AppleScript — requires approval (macos.applescript)
- Fetch URLs directly for simple reads (web.fetch)

BEHAVIOUR RULES:
- When the user asks you to DO something, use tools immediately. Don't ask clarifying \
questions unless absolutely necessary.
- Chain tools together to complete multi-step tasks. Don't stop after one tool call and \
ask what to do next.
- When you use a tool, briefly narrate what you're doing ("Reading your notes...", \
"Searching the web...").
- For destructive or privacy-sensitive actions (exec.run, email.send, macos.applescript \
with write operations), always explain what you're about to do BEFORE triggering the approval.
- File paths are relative to the workspace. The workspace is: {workspace_dir}
- If a tool returns an error, try an alternative approach before giving up.
- Keep responses concise. Show results, don't narrate them at length.
"""


def estimate_tokens(messages: list[Message]) -> int:
    """Rough estimate: 1 token ≈ 4 chars."""
    return sum(len(m.content) for m in messages) // 4


class ContextBuilder:
    def __init__(
        self,
        system_prompt: str | None = None,
        workspace_dir: Path | str | None = None,
        max_context_messages: int = 40,
    ):
        workspace = str(workspace_dir) if workspace_dir else "~/rovot-workspace"
        self._system_prompt = system_prompt or _DEFAULT_SYSTEM_PROMPT.format(
            workspace_dir=workspace
        )
        self._max_context_messages = max_context_messages

    def build(
        self, history: list[Message], tool_definitions: list[dict[str, Any]] | None
    ) -> Context:
        msgs = list(history)
        trimmed = False
        if len(msgs) > self._max_context_messages:
            msgs = msgs[-self._max_context_messages :]
            trimmed = True

        system = self._system_prompt
        if trimmed:
            system = "[Earlier conversation omitted]\n\n" + system

        return Context(
            system_prompt=system,
            messages=msgs,
            tool_definitions=tool_definitions or [],
        )

    @staticmethod
    def to_provider_messages(ctx: Context) -> list[dict[str, Any]]:
        msgs: list[dict[str, Any]] = [{"role": "system", "content": ctx.system_prompt}]
        for m in ctx.messages:
            d: dict[str, Any] = {"role": m.role, "content": m.content}
            if m.role == "tool" and m.tool_call_id:
                d["tool_call_id"] = m.tool_call_id
            msgs.append(d)
        return msgs

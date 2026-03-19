"""Tests for Phase 4 features: tool_calls serialization, session messages endpoint,
and system prompt customization."""
from __future__ import annotations

import asyncio
from pathlib import Path

from rovot.agent.context import ContextBuilder, Message, _DEFAULT_SYSTEM_PROMPT
from rovot.agent.sessions import SessionStore


# ── Helper ────────────────────────────────────────────────────────────────────

def _make_state(tmp_path: Path):
    from rovot.config import ConfigStore, Settings
    from rovot.policy.approvals import ApprovalManager
    from rovot.policy.engine import PolicyEngine
    from rovot.secrets import SecretsStore
    from rovot.server.deps import AppState
    from unittest.mock import AsyncMock, MagicMock

    settings = Settings(data_dir=tmp_path / "data", workspace_dir=tmp_path / "ws")
    (tmp_path / "data").mkdir(parents=True, exist_ok=True)
    cfg = ConfigStore(path=tmp_path / "data" / "config.json")
    cfg.load()
    secrets = SecretsStore(service="rovot", fallback_path=tmp_path / "data" / "secrets.json")
    approvals = ApprovalManager(tmp_path / "data" / "approvals.json")
    policy = PolicyEngine(approvals=approvals)
    ws_mock = MagicMock()
    ws_mock.broadcast = AsyncMock()
    return AppState(
        settings=settings,
        config_store=cfg,
        secrets=secrets,
        auth_token="test-token",
        startup_ts=0.0,
        pid=1,
        approvals=approvals,
        policy=policy,
        ws=ws_mock,
        audit=None,
    )


# ── 1. test_message_tool_calls_serialized ─────────────────────────────────────

def test_message_tool_calls_serialized(tmp_path: Path):
    """tool_calls are persisted and read back correctly."""
    store = SessionStore(root=tmp_path / "sessions")
    session = store.create()

    tool_calls = [
        {"id": "tc1", "name": "fs.read", "arguments": {"path": "foo.txt"}},
        {"id": "tc2", "name": "fs.write", "arguments": {"path": "bar.txt", "content": "hi"}},
    ]
    msg = Message(role="assistant", content="Reading files...", tool_calls=tool_calls)
    session.append(msg)

    history = session.read_all()
    assert len(history) == 1
    assert history[0].role == "assistant"
    assert history[0].tool_calls == tool_calls


# ── 2. test_session_messages_endpoint ─────────────────────────────────────────

def test_session_messages_endpoint(tmp_path: Path):
    """Endpoint returns only user+assistant messages, filtering out tool results."""
    from rovot.server.routes.chat import session_messages
    from rovot.policy.engine import AuthContext
    from rovot.policy.scopes import OPERATOR_READ

    state = _make_state(tmp_path)
    store = SessionStore(root=state.settings.data_dir / "sessions")
    session = store.create()

    session.append(Message(role="user", content="Hello"))
    session.append(Message(role="assistant", content="Hi!"))
    session.append(Message(role="user", content="Run a command"))
    session.append(Message(role="assistant", content="Sure, running..."))
    # Tool result message — should be filtered out
    session.append(Message(role="tool", content="output", tool_call_id="tc1"))

    auth = AuthContext(token="test-token", scopes=[OPERATOR_READ])
    result = asyncio.run(session_messages(session.id, auth, state))

    assert result["session_id"] == session.id
    msgs = result["messages"]
    assert len(msgs) == 4
    assert all(m["role"] in ("user", "assistant") for m in msgs)
    assert msgs[0]["content"] == "Hello"
    assert msgs[1]["content"] == "Hi!"
    assert msgs[2]["content"] == "Run a command"
    assert msgs[3]["content"] == "Sure, running..."


# ── 3. test_system_prompt_custom_file ─────────────────────────────────────────

def test_system_prompt_custom_file(tmp_path: Path, monkeypatch):
    """ContextBuilder uses the custom system_prompt.txt if present."""
    rovot_dir = tmp_path / ".rovot"
    rovot_dir.mkdir(parents=True, exist_ok=True)
    custom_prompt = "You are a custom test agent."
    (rovot_dir / "system_prompt.txt").write_text(custom_prompt, "utf-8")

    # Patch Path.home() so ContextBuilder reads from our tmp dir
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    builder = ContextBuilder(workspace_dir="/tmp/ws")
    assert builder._system_prompt == custom_prompt


# ── 4. test_system_prompt_default_when_missing ────────────────────────────────

def test_system_prompt_default_when_missing(tmp_path: Path, monkeypatch):
    """ContextBuilder uses the default prompt when no custom file exists."""
    # Point home to a temp dir that has no system_prompt.txt
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    workspace = "/tmp/workspace"
    builder = ContextBuilder(workspace_dir=workspace)
    expected = _DEFAULT_SYSTEM_PROMPT.format(workspace_dir=workspace)
    assert builder._system_prompt == expected

"""Tests for the streaming chat endpoint and context trimming."""
from __future__ import annotations

import asyncio
from pathlib import Path

from rovot.agent.context import ContextBuilder, Message, estimate_tokens
from rovot.config import ConfigStore, Settings
from rovot.policy.approvals import ApprovalManager
from rovot.policy.engine import PolicyEngine
from rovot.secrets import SecretsStore
from rovot.server.deps import AppState


# ── estimate_tokens ──────────────────────────────────────────────────────────

def test_estimate_tokens_empty():
    assert estimate_tokens([]) == 0


def test_estimate_tokens_rough():
    msgs = [Message(role="user", content="a" * 400)]
    assert estimate_tokens(msgs) == 100


# ── ContextBuilder trimming ───────────────────────────────────────────────────

def test_context_builder_trims_history():
    builder = ContextBuilder(max_context_messages=3)
    history = [Message(role="user", content=f"msg{i}") for i in range(10)]
    ctx = builder.build(history, None)
    assert len(ctx.messages) == 3
    assert ctx.messages[0].content == "msg7"
    assert "[Earlier conversation omitted]" in ctx.system_prompt


def test_context_builder_no_trim_when_within_limit():
    builder = ContextBuilder(max_context_messages=10)
    history = [Message(role="user", content=f"msg{i}") for i in range(5)]
    ctx = builder.build(history, None)
    assert len(ctx.messages) == 5
    assert "[Earlier conversation omitted]" not in ctx.system_prompt


def test_context_builder_workspace_in_prompt():
    builder = ContextBuilder(workspace_dir="/tmp/my-workspace")
    history: list[Message] = []
    ctx = builder.build(history, None)
    assert "/tmp/my-workspace" in ctx.system_prompt


# ── Session stats endpoint ────────────────────────────────────────────────────

def _make_state(tmp_path: Path) -> AppState:
    settings = Settings(data_dir=tmp_path / "data", workspace_dir=tmp_path / "ws")
    (tmp_path / "data").mkdir(parents=True, exist_ok=True)
    cfg = ConfigStore(path=tmp_path / "data" / "config.json")
    cfg.load()
    secrets = SecretsStore(service="rovot", fallback_path=tmp_path / "data" / "secrets.json")
    approvals = ApprovalManager(tmp_path / "data" / "approvals.json")
    policy = PolicyEngine(approvals=approvals)
    from unittest.mock import AsyncMock, MagicMock
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


def test_session_stats_endpoint(tmp_path: Path):
    from rovot.agent.sessions import SessionStore
    from rovot.policy.scopes import OPERATOR_READ
    from rovot.policy.engine import AuthContext
    from rovot.server.routes.chat import session_stats

    state = _make_state(tmp_path)
    store = SessionStore(root=state.settings.data_dir / "sessions")
    session = store.create()
    session.append(Message(role="user", content="Hello"))
    session.append(Message(role="assistant", content="Hi there!"))

    auth = AuthContext(token="test-token", scopes=[OPERATOR_READ])
    result = asyncio.run(session_stats(session.id, auth, state))
    assert result.session_id == session.id
    assert result.message_count == 2
    assert result.estimated_tokens > 0
    assert result.trimmed is False


# ── Browser connector registration ────────────────────────────────────────────

def test_browser_tools_not_registered_when_disabled():
    from rovot.agent.tools.builtin_browser import register_browser_tools
    from rovot.agent.tools.registry import ToolRegistry
    from rovot.policy.approvals import ApprovalManager
    from rovot.policy.engine import PolicyEngine

    approvals = ApprovalManager(Path("/tmp/test_approvals.json"))
    policy = PolicyEngine(approvals=approvals)
    registry = ToolRegistry(policy=policy)
    register_browser_tools(registry, browser=None)
    assert len(registry.definitions()) == 0


def test_browser_tools_registered_when_provided():
    from rovot.agent.tools.builtin_browser import register_browser_tools
    from rovot.agent.tools.registry import ToolRegistry
    from rovot.connectors.browser import BrowserConnector
    from rovot.policy.approvals import ApprovalManager
    from rovot.policy.engine import PolicyEngine

    approvals = ApprovalManager(Path("/tmp/test_approvals2.json"))
    policy = PolicyEngine(approvals=approvals)
    registry = ToolRegistry(policy=policy)
    browser = BrowserConnector()
    register_browser_tools(registry, browser=browser)
    names = {d["function"]["name"] for d in registry.definitions()}
    assert "browser.navigate" in names
    assert "browser.search" in names
    assert "browser.get_page_content" in names
    assert "browser.screenshot" in names
    assert "browser.click" in names
    assert "browser.type" in names


# ── AgentLoop.stream() single model call ─────────────────────────────────────

def test_stream_single_model_call():
    from rovot.agent.loop import AgentLoop
    from rovot.agent.context import ContextBuilder, Message
    from rovot.providers.base import ChatResponse
    from rovot.agent.tools.registry import ToolRegistry
    from rovot.policy.approvals import ApprovalManager
    from rovot.policy.engine import PolicyEngine, AuthContext

    call_count = 0

    class FakeProvider:
        async def chat(self, messages, tools=None):
            nonlocal call_count
            call_count += 1
            return ChatResponse(content="Hello world", tool_calls=[])

        async def list_models(self):
            return []

        def supports_tools(self):
            return False

        def supports_streaming(self):
            return False

        def supports_vision(self):
            return False

    approvals = ApprovalManager(Path("/tmp/test_stream.json"))
    policy = PolicyEngine(approvals)
    tools = ToolRegistry(policy=policy)
    loop = AgentLoop(
        provider=FakeProvider(),
        tools=tools,
        ctx_builder=ContextBuilder(),
    )
    auth = AuthContext(
        token="t",
        scopes=["operator.read", "operator.write", "operator.approvals"],
    )
    history = [Message(role="user", content="hi")]

    async def _run():
        events = []
        async for event in loop.stream(auth=auth, session_id="s1", history=history):
            events.append(event)
        return events

    events = asyncio.run(_run())
    assert call_count == 1, f"Expected 1 model call, got {call_count}"
    token_events = [e for e in events if e["type"] == "token"]
    assert len(token_events) > 0
    done_events = [e for e in events if e["type"] == "done"]
    assert len(done_events) == 1


# ── macOS tools registration ──────────────────────────────────────────────────

def test_macos_tools_not_registered_when_disabled():
    from rovot.agent.tools.builtin_macos import register_macos_tools
    from rovot.agent.tools.registry import ToolRegistry
    from rovot.policy.approvals import ApprovalManager
    from rovot.policy.engine import PolicyEngine
    from pathlib import Path

    approvals = ApprovalManager(Path("/tmp/test_approvals3.json"))
    policy = PolicyEngine(approvals=approvals)
    registry = ToolRegistry(policy=policy)
    register_macos_tools(registry, enabled=False)
    assert len(registry.definitions()) == 0

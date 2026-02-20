from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from rovot.agent.context import ContextBuilder, Message
from rovot.agent.loop import AgentLoop
from rovot.agent.sessions import SessionStore
from rovot.agent.tools.builtin_email import register_email_tools
from rovot.agent.tools.builtin_exec import ExecConfig, register_exec_tool
from rovot.agent.tools.builtin_fs import register_fs_tools
from rovot.agent.tools.builtin_web import register_web_tools
from rovot.agent.tools.registry import ToolRegistry
from rovot.connectors.loader import load_connectors
from rovot.policy.engine import AuthContext
from rovot.providers.openai_compat import OpenAICompatProvider
from rovot.server.deps import AppState, get_auth_ctx, get_state

router = APIRouter(tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class ContinueRequest(BaseModel):
    session_id: str
    approval_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    session_id: str
    tool_calls: list[dict[str, Any]] = []
    pending_approval_id: str | None = None


def _build_agent(state: AppState) -> AgentLoop:
    cfg = state.config_store.config
    settings = state.settings
    model_key = state.secrets.get(cfg.model.api_key_secret) or ""
    provider = OpenAICompatProvider(
        base_url=cfg.model.base_url, api_key=model_key, model=cfg.model.model
    )
    connectors = load_connectors(cfg, workspace=settings.workspace_dir, secrets=state.secrets)
    tools = ToolRegistry(policy=state.policy)
    register_web_tools(tools)
    register_fs_tools(tools, connectors.fs, settings.workspace_dir)
    register_exec_tool(
        tools, ExecConfig(workspace=settings.workspace_dir, security_mode=cfg.security_mode.value)
    )
    register_email_tools(tools, connectors.email)
    return AgentLoop(
        provider=provider,
        tools=tools,
        ctx_builder=ContextBuilder(),
        max_iterations=cfg.max_iterations,
    )


@router.post("/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> ChatResponse:
    settings = state.settings
    store = SessionStore(root=settings.data_dir / "sessions")
    session = store.create() if not req.session_id else store.get(req.session_id)
    history = session.read_all()
    history.append(Message(role="user", content=req.message))
    session.append(Message(role="user", content=req.message))
    agent = _build_agent(state)
    resp = await agent.run(auth=auth, session_id=session.id, history=history)
    session.append(Message(role="assistant", content=resp.reply))
    if state.audit:
        state.audit.log(
            "chat.turn", {"session_id": session.id, "pending": bool(resp.pending_approval_id)}
        )
    await state.ws.broadcast(
        "chat.reply",
        {"session_id": session.id, "pending_approval_id": resp.pending_approval_id},
    )
    return ChatResponse(
        reply=resp.reply,
        session_id=session.id,
        tool_calls=resp.tool_calls,
        pending_approval_id=resp.pending_approval_id,
    )


@router.post("/chat/continue", response_model=ChatResponse)
async def chat_continue(
    req: ContinueRequest,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> ChatResponse:
    settings = state.settings
    store = SessionStore(root=settings.data_dir / "sessions")
    session = store.get(req.session_id)
    history = session.read_all()
    agent = _build_agent(state)

    if req.approval_id:
        a = state.approvals.get(req.approval_id)
        if not a or a.session_id != session.id or a.status != "allow":
            return ChatResponse(
                reply="Invalid or non-allowed approval_id.",
                session_id=session.id,
                tool_calls=[],
                pending_approval_id=None,
            )
        result = await agent._tools.invoke(  # noqa: SLF001
            auth,
            session.id,
            a.tool_name,
            a.tool_arguments or {},
            tool_call_id=a.tool_call_id,
            approved=True,
        )
        history.append(Message(role="tool", content=str(result), tool_call_id=a.tool_call_id))
        session.append(Message(role="tool", content=str(result), tool_call_id=a.tool_call_id))
        state.approvals.consume(a.id)

    resp = await agent.run(auth=auth, session_id=session.id, history=history)
    session.append(Message(role="assistant", content=resp.reply))
    await state.ws.broadcast(
        "chat.reply",
        {"session_id": session.id, "pending_approval_id": resp.pending_approval_id},
    )
    return ChatResponse(
        reply=resp.reply,
        session_id=session.id,
        tool_calls=resp.tool_calls,
        pending_approval_id=resp.pending_approval_id,
    )

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from rovot.agent.context import ContextBuilder, Message, estimate_tokens
from rovot.agent.loop import AgentLoop
from rovot.agent.sessions import SessionStore
from rovot.agent.tools.builtin_browser import register_browser_tools
from rovot.agent.tools.builtin_email import register_email_tools
from rovot.agent.tools.builtin_exec import ExecConfig, register_exec_tool
from rovot.agent.tools.builtin_fs import register_fs_tools
from rovot.agent.tools.builtin_macos import register_macos_tools
from rovot.agent.tools.builtin_web import register_web_tools
from rovot.agent.tools.registry import ToolRegistry
from rovot.connectors.loader import load_connectors
from rovot.config import ModelProviderMode
from rovot.policy.engine import AuthContext
from rovot.providers.openai_compat import OpenAICompatProvider
from rovot.providers.router import ProviderRouter
from rovot.server.deps import AppState, get_auth_ctx, get_state

logger = logging.getLogger(__name__)

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


class SessionStatsResponse(BaseModel):
    session_id: str
    message_count: int
    estimated_tokens: int
    trimmed: bool


def _build_agent(state: AppState) -> AgentLoop:
    cfg = state.config_store.config
    settings = state.settings
    model_key = state.secrets.get(cfg.model.api_key_secret, source="chat.local_api_key") or ""
    need_cloud = cfg.model.provider_mode == ModelProviderMode.CLOUD or (
        cfg.model.provider_mode == ModelProviderMode.AUTO and cfg.model.fallback_to_cloud
    )
    cloud_provider = None
    if cfg.model.cloud_base_url and need_cloud:
        cloud_provider = OpenAICompatProvider(
            base_url=cfg.model.cloud_base_url,
            api_key=(
                state.secrets.get(
                    cfg.model.cloud_api_key_secret,
                    source="chat.cloud_api_key",
                )
                or ""
            ),
            model=cfg.model.cloud_model,
        )
    provider = ProviderRouter(
        local=OpenAICompatProvider(
            base_url=cfg.model.base_url,
            api_key=model_key,
            model=cfg.model.model,
        ),
        cloud=cloud_provider,
        mode=cfg.model.provider_mode,
        fallback_to_cloud=cfg.model.fallback_to_cloud,
    )
    connectors = load_connectors(cfg, workspace=settings.workspace_dir, secrets=state.secrets)
    tools = ToolRegistry(policy=state.policy)
    register_web_tools(tools, allowed_domains=cfg.allowed_domains)
    register_fs_tools(tools, connectors.fs, settings.workspace_dir)
    register_exec_tool(
        tools, ExecConfig(workspace=settings.workspace_dir, security_mode=cfg.security_mode.value)
    )
    register_email_tools(tools, connectors.email)
    register_browser_tools(tools, connectors.browser)
    register_macos_tools(tools, enabled=cfg.connectors.macos_automation_enabled)
    return AgentLoop(
        provider=provider,
        tools=tools,
        ctx_builder=ContextBuilder(
            workspace_dir=settings.workspace_dir,
            max_context_messages=cfg.max_context_messages,
        ),
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
    try:
        resp = await agent.run(auth=auth, session_id=session.id, history=history)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Model provider request failed: {exc}",
        ) from exc
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


@router.post("/chat/stream")
async def chat_stream(
    req: ChatRequest,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> StreamingResponse:
    """Stream chat response as Server-Sent Events."""
    settings = state.settings
    store = SessionStore(root=settings.data_dir / "sessions")
    session = store.create() if not req.session_id else store.get(req.session_id)
    history = session.read_all()
    history.append(Message(role="user", content=req.message))
    session.append(Message(role="user", content=req.message))
    agent = _build_agent(state)

    async def event_generator() -> AsyncIterator[str]:
        full_reply = ""
        pending_approval_id: str | None = None
        tool_calls: list[dict[str, Any]] = []
        try:
            async for event in agent.stream(auth=auth, session_id=session.id, history=history):
                event_type = event.get("type")
                if event_type == "token":
                    full_reply += event["content"]
                elif event_type == "tool_call":
                    tool_calls.append(
                        {"name": event.get("name", ""), "arguments": event.get("args", {})}
                    )
                elif event_type == "approval_required":
                    pending_approval_id = event.get("approval_id")
                elif event_type == "done":
                    pending_approval_id = event.get("pending_approval_id")
                    tool_calls = event.get("tool_calls", tool_calls)

                data = json.dumps(event)
                yield f"data: {data}\n\n"

            # Persist the assistant reply
            if full_reply:
                session.append(Message(role="assistant", content=full_reply))

            if state.audit:
                state.audit.log(
                    "chat.turn",
                    {"session_id": session.id, "pending": bool(pending_approval_id), "stream": True},
                )
            await state.ws.broadcast(
                "chat.reply",
                {"session_id": session.id, "pending_approval_id": pending_approval_id},
            )
        except Exception as exc:
            logger.exception("Error during streaming chat: %s", exc)
            error_data = json.dumps({"type": "error", "message": str(exc)})
            yield f"data: {error_data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
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

    try:
        resp = await agent.run(auth=auth, session_id=session.id, history=history)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Model provider request failed: {exc}",
        ) from exc
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


class MessageOut(BaseModel):
    role: str
    content: str
    tool_call_id: str | None = None
    tool_calls: list[dict] = []


@router.get("/sessions/{session_id}/messages")
async def session_messages(
    session_id: str,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict:
    store = SessionStore(root=state.settings.data_dir / "sessions")
    session = store.get(session_id)
    history = session.read_all()
    return {
        "session_id": session_id,
        "messages": [
            MessageOut(
                role=m.role,
                content=m.content,
                tool_call_id=m.tool_call_id,
                tool_calls=m.tool_calls,
            ).model_dump()
            for m in history
            if m.role in ("user", "assistant")
        ],
    }


@router.get("/sessions/{session_id}/stats", response_model=SessionStatsResponse)
async def session_stats(
    session_id: str,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> SessionStatsResponse:
    """Return message count and estimated token usage for a session."""
    settings = state.settings
    store = SessionStore(root=settings.data_dir / "sessions")
    session = store.get(session_id)
    history = session.read_all()
    cfg = state.config_store.config
    max_msgs = cfg.max_context_messages
    trimmed = len(history) > max_msgs
    return SessionStatsResponse(
        session_id=session_id,
        message_count=len(history),
        estimated_tokens=estimate_tokens(history),
        trimmed=trimmed,
    )

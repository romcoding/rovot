from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from rovot.agent.context import ContextBuilder, Message
from rovot.agent.tools.registry import ToolRegistry
from rovot.policy.approvals import ApprovalRequired
from rovot.policy.engine import AuthContext
from rovot.providers.base import Provider


@dataclass
class AgentResponse:
    reply: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    pending_approval_id: str | None = None


class AgentLoop:
    def __init__(
        self,
        provider: Provider,
        tools: ToolRegistry,
        ctx_builder: ContextBuilder,
        max_iterations: int = 25,
    ):
        self._provider = provider
        self._tools = tools
        self._ctx = ctx_builder
        self._max_iterations = max_iterations

    async def run(
        self, *, auth: AuthContext, session_id: str, history: list[Message]
    ) -> AgentResponse:
        all_tool_calls: list[dict[str, Any]] = []
        msgs = list(history)
        for _ in range(self._max_iterations):
            ctx = self._ctx.build(msgs, self._tools.definitions())
            response = await self._provider.chat(
                messages=ContextBuilder.to_provider_messages(ctx),
                tools=ctx.tool_definitions or None,
            )
            if not response.tool_calls:
                return AgentResponse(reply=response.content, tool_calls=all_tool_calls)
            for tc in response.tool_calls:
                all_tool_calls.append(tc)
                try:
                    result = await self._tools.invoke(
                        auth,
                        session_id,
                        tc.get("name") or "",
                        tc.get("arguments") or {},
                        tool_call_id=tc.get("id") or None,
                    )
                    msgs.append(
                        Message(role="tool", content=str(result), tool_call_id=tc.get("id"))
                    )
                except ApprovalRequired as ar:
                    return AgentResponse(
                        reply=str(ar),
                        tool_calls=all_tool_calls,
                        pending_approval_id=ar.approval_id,
                    )
        return AgentResponse(
            reply="Reached maximum iterations without a final answer.",
            tool_calls=all_tool_calls,
        )

    async def stream(
        self,
        *,
        auth: AuthContext,
        session_id: str,
        history: list[Message],
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream agent execution as events.

        Yields dicts with keys: type, and type-specific fields.
        Event types: token, tool_call, tool_result, approval_required, done, error.
        """
        all_tool_calls: list[dict[str, Any]] = []
        msgs = list(history)

        for _ in range(self._max_iterations):
            ctx = self._ctx.build(msgs, self._tools.definitions())
            provider_msgs = ContextBuilder.to_provider_messages(ctx)
            tool_defs = ctx.tool_definitions or None

            # Try to stream tokens from the provider
            streamed_content = ""
            has_stream = hasattr(self._provider, "chat_stream")

            if has_stream:
                try:
                    token_stream = self._provider.chat_stream(  # type: ignore[attr-defined]
                        messages=provider_msgs,
                        tools=tool_defs,
                    )
                    async for token in token_stream:
                        streamed_content += token
                        yield {"type": "token", "content": token}
                except Exception:
                    # Fall back to non-streaming if stream fails
                    has_stream = False
                    streamed_content = ""

            # If streaming failed or unavailable, do a regular chat call
            if not has_stream:
                try:
                    response = await self._provider.chat(
                        messages=provider_msgs,
                        tools=tool_defs,
                    )
                except Exception as exc:
                    yield {"type": "error", "message": str(exc)}
                    return

                if not response.tool_calls:
                    # Emit the reply as tokens for consistent UX
                    for token in response.content:
                        streamed_content += token
                        yield {"type": "token", "content": token}
                        await asyncio.sleep(0)
                else:
                    # Has tool calls — handle below after yielding content
                    if response.content:
                        for token in response.content:
                            streamed_content += token
                            yield {"type": "token", "content": token}
                            await asyncio.sleep(0)
                    for tc in response.tool_calls:
                        all_tool_calls.append(tc)
                        yield {
                            "type": "tool_call",
                            "name": tc.get("name", ""),
                            "args": tc.get("arguments", {}),
                        }
                        try:
                            result = await self._tools.invoke(
                                auth,
                                session_id,
                                tc.get("name") or "",
                                tc.get("arguments") or {},
                                tool_call_id=tc.get("id") or None,
                            )
                            summary = str(result)[:200]
                            msgs.append(
                                Message(
                                    role="tool",
                                    content=str(result),
                                    tool_call_id=tc.get("id"),
                                )
                            )
                            yield {
                                "type": "tool_result",
                                "name": tc.get("name", ""),
                                "summary": summary,
                            }
                        except ApprovalRequired as ar:
                            yield {
                                "type": "approval_required",
                                "approval_id": ar.approval_id,
                            }
                            yield {
                                "type": "done",
                                "session_id": session_id,
                                "pending_approval_id": ar.approval_id,
                                "tool_calls": all_tool_calls,
                            }
                            return
                    # Continue loop with updated history
                    msgs.append(Message(role="assistant", content=streamed_content))
                    continue

            # For streaming case: after collecting tokens, do a non-streaming call
            # to detect tool calls (most providers don't expose tool calls in streams)
            if has_stream:
                # Do a non-streaming call now to check for tool calls
                try:
                    response = await self._provider.chat(
                        messages=provider_msgs,
                        tools=tool_defs,
                    )
                except Exception as exc:
                    yield {"type": "error", "message": str(exc)}
                    return

                if not response.tool_calls:
                    # Pure text response — we already streamed it
                    yield {
                        "type": "done",
                        "session_id": session_id,
                        "pending_approval_id": None,
                        "tool_calls": all_tool_calls,
                    }
                    return

                # Has tool calls — emit them and continue
                msgs.append(Message(role="assistant", content=response.content or streamed_content))
                for tc in response.tool_calls:
                    all_tool_calls.append(tc)
                    yield {
                        "type": "tool_call",
                        "name": tc.get("name", ""),
                        "args": tc.get("arguments", {}),
                    }
                    try:
                        result = await self._tools.invoke(
                            auth,
                            session_id,
                            tc.get("name") or "",
                            tc.get("arguments") or {},
                            tool_call_id=tc.get("id") or None,
                        )
                        summary = str(result)[:200]
                        msgs.append(
                            Message(
                                role="tool",
                                content=str(result),
                                tool_call_id=tc.get("id"),
                            )
                        )
                        yield {
                            "type": "tool_result",
                            "name": tc.get("name", ""),
                            "summary": summary,
                        }
                    except ApprovalRequired as ar:
                        yield {
                            "type": "approval_required",
                            "approval_id": ar.approval_id,
                        }
                        yield {
                            "type": "done",
                            "session_id": session_id,
                            "pending_approval_id": ar.approval_id,
                            "tool_calls": all_tool_calls,
                        }
                        return
                # Continue the loop to get the next model response
                continue
            else:
                # Non-streaming path finished the loop iteration normally
                msgs.append(Message(role="assistant", content=streamed_content))

        yield {
            "type": "done",
            "session_id": session_id,
            "pending_approval_id": None,
            "tool_calls": all_tool_calls,
        }

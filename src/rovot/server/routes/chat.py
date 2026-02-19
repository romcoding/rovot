"""Chat endpoint -- accepts user messages and returns agent responses."""

from __future__ import annotations

from pydantic import BaseModel
from fastapi import APIRouter

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    session_id: str
    tool_calls: list[dict] = []


@router.post("/", response_model=ChatResponse)
async def send_message(req: ChatRequest) -> ChatResponse:
    """Send a message to the agent and receive a response.

    TODO: wire up AgentLoop + SessionStore.
    """
    return ChatResponse(
        reply="Agent loop not yet wired.",
        session_id=req.session_id or "new",
        tool_calls=[],
    )

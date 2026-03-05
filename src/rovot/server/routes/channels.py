from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from rovot.agent.context import Message
from rovot.agent.sessions import SessionStore
from rovot.channels import SignalCliAdapter, TwilioWhatsAppAdapter
from rovot.policy.engine import AuthContext
from rovot.server.deps import AppState, get_auth_ctx, get_state
from rovot.server.routes.chat import _build_agent

router = APIRouter(tags=["channels"])


@router.post("/channels/incoming")
async def channel_incoming(
    request: Request,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
    x_twilio_signature: str | None = Header(default=None),
    x_rovot_channel_secret: str | None = Header(default=None),
) -> dict:
    cfg = state.config_store.config.connectors.messaging
    if not cfg.enabled:
        raise HTTPException(status_code=403, detail="Messaging channel is disabled")

    payload = await request.json()
    headers = {
        "x-twilio-signature": x_twilio_signature or "",
        "x-rovot-channel-secret": x_rovot_channel_secret or "",
    }

    if cfg.provider == "whatsapp_twilio":
        auth_token = state.secrets.get(cfg.twilio_auth_token_secret) or ""
        adapter = TwilioWhatsAppAdapter(auth_token=auth_token, expected_url=str(request.url))
    elif cfg.provider == "signal_cli":
        adapter = SignalCliAdapter(verify_secret=cfg.webhook_verify_secret)
    else:
        raise HTTPException(status_code=400, detail="Unsupported messaging provider")

    try:
        incoming = adapter.parse_incoming(payload, headers)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    store = SessionStore(root=state.settings.data_dir / "sessions")
    session = store.create()
    session.append(Message(role="user", content=f"[{incoming.channel}] {incoming.user_id}: {incoming.text}"))

    agent = _build_agent(state)
    resp = await agent.run(auth=auth, session_id=session.id, history=session.read_all())
    session.append(Message(role="assistant", content=resp.reply))

    if state.audit:
        state.audit.log(
            "channel.incoming",
            {"channel": incoming.channel, "user_id": incoming.user_id, "session_id": session.id},
        )
    return {"ok": True, "session_id": session.id, "reply": resp.reply}

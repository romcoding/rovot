from __future__ import annotations

import logging

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from rovot import __version__
from rovot.audit import AuditLogger
from rovot.config import ConfigStore, Settings
from rovot.policy.approvals import ApprovalManager
from rovot.policy.engine import PolicyEngine
from rovot.secrets import SecretsStore
from rovot.server.deps import AppState, ensure_auth_token
from rovot.server.ws import WebSocketHub
from rovot.server.routes import approvals, audit, channels, chat, config, health, models, voice

logger = logging.getLogger("rovot.server")


def create_app() -> FastAPI:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.workspace_dir.mkdir(parents=True, exist_ok=True)

    if settings.host != "127.0.0.1":
        logger.warning(
            "Daemon is binding to %s -- this exposes the control plane to the network. "
            "Loopback-only (127.0.0.1) is strongly recommended. "
            "See OpenClaw security guidance for details.",
            settings.host,
        )

    secrets = SecretsStore(service="rovot", fallback_path=settings.data_dir / "secrets.json")
    auth_token = ensure_auth_token(settings, secrets)

    cfg_store = ConfigStore(path=settings.data_dir / "config.json")
    cfg_store.load()
    cfg_store.save()

    secrets.use_keychain = cfg_store.config.use_keychain

    approvals_store = ApprovalManager(path=settings.data_dir / "approvals.json")
    policy = PolicyEngine(approvals_store)
    ws = WebSocketHub()
    audit_logger = AuditLogger(path=settings.data_dir / "audit.log")

    app = FastAPI(title="Rovot Control Plane", version=__version__, docs_url="/docs")
    cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    if not cors_origins:
        cors_origins = ["http://localhost", "http://127.0.0.1"] if settings.cloud_mode else ["*"]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Twilio-Signature", "X-Rovot-Channel-Secret"],
    )
    app.state.rovot_state = AppState(
        settings=settings,
        config_store=cfg_store,
        secrets=secrets,
        auth_token=auth_token,
        approvals=approvals_store,
        policy=policy,
        ws=ws,
        audit=audit_logger,
    )

    app.include_router(health.router)
    app.include_router(chat.router)
    app.include_router(approvals.router)
    app.include_router(config.router)
    app.include_router(voice.router)
    app.include_router(audit.router)
    app.include_router(models.router)
    app.include_router(channels.router)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled server error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Internal Server Error",
                "error_type": exc.__class__.__name__,
            },
        )

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket, token: str = ""):
        ctx_token = auth_token
        if not token or token != ctx_token:
            await websocket.close(code=4401)
            return
        await ws.connect(
            websocket,
            scopes=["operator.read", "operator.write", "operator.approvals", "operator.admin"],
        )
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            await ws.disconnect(websocket)

    return app

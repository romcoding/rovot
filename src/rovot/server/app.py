from __future__ import annotations

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from rovot import __version__
from rovot.config import ConfigStore, Settings
from rovot.policy.approvals import ApprovalManager
from rovot.policy.engine import PolicyEngine
from rovot.secrets import SecretsStore
from rovot.server.deps import AppState, ensure_auth_token
from rovot.server.ws import WebSocketHub
from rovot.server.routes import approvals, chat, config, health, voice


def create_app() -> FastAPI:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.workspace_dir.mkdir(parents=True, exist_ok=True)

    secrets = SecretsStore(service="rovot", fallback_path=settings.data_dir / "secrets.json")
    ensure_auth_token(settings, secrets)

    cfg_store = ConfigStore(path=settings.data_dir / "config.json")
    cfg_store.load()
    cfg_store.save()

    approvals_store = ApprovalManager(path=settings.data_dir / "approvals.json")
    policy = PolicyEngine(approvals_store)
    ws = WebSocketHub()

    app = FastAPI(title="Rovot Control Plane", version=__version__, docs_url="/docs")
    app.state.rovot_state = AppState(
        settings=settings,
        config_store=cfg_store,
        secrets=secrets,
        approvals=approvals_store,
        policy=policy,
        ws=ws,
    )

    app.include_router(health.router)
    app.include_router(chat.router)
    app.include_router(approvals.router)
    app.include_router(config.router)
    app.include_router(voice.router)

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket, token: str = ""):
        ctx_token = secrets.get("auth.token") or ""
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

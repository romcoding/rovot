from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from rovot.config import ConfigStore, Settings
from rovot.policy.approvals import ApprovalManager
from rovot.policy.engine import AuthContext, PolicyEngine
from rovot.policy.scopes import DEFAULT_ADMIN_SCOPES
from rovot.secrets import SecretsStore
from rovot.server.ws import WebSocketHub

bearer = HTTPBearer(auto_error=False)


@dataclass
class AppState:
    settings: Settings
    config_store: ConfigStore
    secrets: SecretsStore
    approvals: ApprovalManager
    policy: PolicyEngine
    ws: WebSocketHub


def get_state(req: Request) -> AppState:
    return req.app.state.rovot_state  # type: ignore[attr-defined]


def _token_path(settings: Settings) -> Path:
    return settings.data_dir / "auth_token.txt"


def ensure_auth_token(settings: Settings, secrets_store: SecretsStore) -> str:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    p = _token_path(settings)
    tok = secrets_store.get("auth.token")
    if tok:
        return tok
    if p.exists():
        tok = p.read_text("utf-8").strip()
        if tok:
            secrets_store.set("auth.token", tok)
            return tok
    tok = secrets.token_urlsafe(32)
    p.write_text(tok, "utf-8")
    try:
        os.chmod(p, 0o600)
    except Exception:
        pass
    secrets_store.set("auth.token", tok)
    return tok


def get_auth_ctx(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    state: AppState = Depends(get_state),
) -> AuthContext:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token_expected = state.secrets.get("auth.token") or ""
    if not token_expected or creds.credentials != token_expected:
        raise HTTPException(status_code=403, detail="Invalid token")
    return AuthContext(token=creds.credentials, scopes=list(DEFAULT_ADMIN_SCOPES))

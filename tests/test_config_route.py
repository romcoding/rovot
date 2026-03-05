import asyncio

from rovot.config import ConfigStore, Settings
from rovot.policy.engine import AuthContext
from rovot.policy.scopes import OPERATOR_WRITE
from rovot.secrets import SecretsStore
from rovot.server.deps import AppState
from rovot.server.routes.config import UpdateConfigRequest, update_config


def test_update_config_applies_use_keychain_to_runtime(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_dir=tmp_path / "ws")
    cfg = ConfigStore(path=tmp_path / "data" / "config.json")
    cfg.load()
    secrets = SecretsStore(service="rovot", fallback_path=tmp_path / "data" / "secrets.json")
    state = AppState(
        settings=settings,
        config_store=cfg,
        secrets=secrets,
        auth_token="t",
        approvals=None,  # type: ignore[arg-type]
        policy=None,  # type: ignore[arg-type]
        ws=None,  # type: ignore[arg-type]
        audit=None,
    )
    ctx = AuthContext(token="t", scopes=[OPERATOR_WRITE])

    assert state.secrets.use_keychain is True
    r = asyncio.run(update_config(UpdateConfigRequest(path="use_keychain", value=False), ctx, state))
    assert r == {"ok": True}
    assert state.secrets.use_keychain is False

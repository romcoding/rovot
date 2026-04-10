import asyncio

from rovot.config import ConfigStore, ModelProviderMode, Settings
from rovot.policy.engine import AuthContext
from rovot.secrets import SecretsStore
from rovot.server.deps import AppState
from rovot.server.routes.chat import _build_agent
from rovot.server.routes.models import model_providers


def _make_state(tmp_path) -> AppState:
    settings = Settings(data_dir=tmp_path / "data", workspace_dir=tmp_path / "ws")
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.workspace_dir.mkdir(parents=True, exist_ok=True)
    cfg = ConfigStore(path=settings.data_dir / "config.json")
    cfg.load()
    secrets = SecretsStore(service="rovot", fallback_path=settings.data_dir / "secrets.json")
    return AppState(
        settings=settings,
        config_store=cfg,
        secrets=secrets,
        auth_token="t",
        startup_ts=0.0,
        pid=1,
        approvals=None,  # type: ignore[arg-type]
        policy=None,  # type: ignore[arg-type]
        ws=None,  # type: ignore[arg-type]
        audit=None,
    )


def test_build_agent_local_mode_skips_cloud_secret_lookup(tmp_path):
    state = _make_state(tmp_path)
    state.config_store.config.model.provider_mode = ModelProviderMode.LOCAL
    state.config_store.config.model.fallback_to_cloud = False
    calls: list[str] = []

    def fake_get(key: str, *, source: str = "unknown", allow_keychain: bool = True):
        calls.append(key)
        return ""

    state.secrets.get = fake_get  # type: ignore[method-assign]

    asyncio.run(_build_agent(state))

    assert state.config_store.config.model.api_key_secret in calls
    assert state.config_store.config.model.cloud_api_key_secret not in calls


def test_build_agent_auto_fallback_reads_cloud_secret(tmp_path):
    state = _make_state(tmp_path)
    state.config_store.config.model.provider_mode = ModelProviderMode.AUTO
    state.config_store.config.model.fallback_to_cloud = True
    calls: list[str] = []

    def fake_get(key: str, *, source: str = "unknown", allow_keychain: bool = True):
        calls.append(key)
        return ""

    state.secrets.get = fake_get  # type: ignore[method-assign]

    asyncio.run(_build_agent(state))

    assert state.config_store.config.model.cloud_api_key_secret in calls


def test_model_providers_local_mode_skips_cloud_secret_lookup(tmp_path):
    state = _make_state(tmp_path)
    state.config_store.config.model.provider_mode = ModelProviderMode.LOCAL
    state.config_store.config.model.fallback_to_cloud = False
    calls: list[str] = []

    def fake_get(key: str, *, source: str = "unknown", allow_keychain: bool = True):
        calls.append(key)
        return None

    state.secrets.get = fake_get  # type: ignore[method-assign]

    resp = asyncio.run(model_providers(AuthContext(token="t", scopes=[]), state))

    assert resp["cloud"]["api_key_configured"] is False
    assert state.config_store.config.model.cloud_api_key_secret not in calls


def test_model_providers_cloud_mode_reads_cloud_secret(tmp_path):
    state = _make_state(tmp_path)
    state.config_store.config.model.provider_mode = ModelProviderMode.CLOUD
    calls: list[tuple[str, bool]] = []

    def fake_get(key: str, *, source: str = "unknown", allow_keychain: bool = True):
        calls.append((key, allow_keychain))
        return "x"

    state.secrets.get = fake_get  # type: ignore[method-assign]

    resp = asyncio.run(model_providers(AuthContext(token="t", scopes=[]), state))

    assert resp["cloud"]["api_key_configured"] is True
    assert (state.config_store.config.model.cloud_api_key_secret, False) in calls

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from rovot.config import ConfigStore, Settings
from rovot.policy.approvals import ApprovalManager
from rovot.policy.engine import AuthContext, PolicyEngine
from rovot.policy.scopes import OPERATOR_WRITE
from rovot.secrets import SecretsStore
from rovot.server.deps import AppState
from rovot.server.routes import models_internal
from rovot.server.routes.models_internal import DownloadRequest, LoadRequest


def _make_state(tmp_path: Path) -> AppState:
    settings = Settings(data_dir=tmp_path / "data", workspace_dir=tmp_path / "ws")
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    cfg = ConfigStore(path=settings.data_dir / "config.json")
    cfg.load()
    secrets = SecretsStore(service="rovot", fallback_path=settings.data_dir / "secrets.json")
    approvals = ApprovalManager(settings.data_dir / "approvals.json")
    policy = PolicyEngine(approvals=approvals)
    ws = MagicMock()
    ws.broadcast = AsyncMock()
    return AppState(
        settings=settings,
        config_store=cfg,
        secrets=secrets,
        auth_token="test-token",
        startup_ts=0.0,
        pid=1,
        approvals=approvals,
        policy=policy,
        ws=ws,
        audit=None,
    )


def _auth() -> AuthContext:
    return AuthContext(token="test-token", scopes=[OPERATOR_WRITE])


def test_download_model_rejects_non_huggingface_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    state = _make_state(tmp_path)
    monkeypatch.setattr(models_internal, "MODELS_DIR", tmp_path / "models")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            models_internal.download_model(
                DownloadRequest(
                    filename="tiny.gguf",
                    hf_url="https://example.com/models/tiny.gguf",
                ),
                _auth(),
                state,
            )
        )

    assert exc.value.status_code == 422
    assert "huggingface.co" in str(exc.value.detail)


def test_download_model_rejects_non_gguf_filename(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    state = _make_state(tmp_path)
    monkeypatch.setattr(models_internal, "MODELS_DIR", tmp_path / "models")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            models_internal.download_model(
                DownloadRequest(
                    filename="model.safetensors",
                    hf_url="https://huggingface.co/org/repo/resolve/main/model.safetensors",
                ),
                _auth(),
                state,
            )
        )

    assert exc.value.status_code == 422
    assert ".gguf" in str(exc.value.detail)


def test_download_model_rejects_path_traversal_filename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _make_state(tmp_path)
    monkeypatch.setattr(models_internal, "MODELS_DIR", tmp_path / "models")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            models_internal.download_model(
                DownloadRequest(
                    filename="../escape.gguf",
                    hf_url="https://huggingface.co/org/repo/resolve/main/escape.gguf",
                ),
                _auth(),
                state,
            )
        )

    assert exc.value.status_code == 422
    assert "plain .gguf filename" in str(exc.value.detail)


def test_download_model_accepts_valid_hf_gguf_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _make_state(tmp_path)
    monkeypatch.setattr(models_internal, "MODELS_DIR", tmp_path / "models")

    created = []

    def _capture_task(coro):
        created.append(coro)
        coro.close()
        return object()

    monkeypatch.setattr(models_internal.asyncio, "create_task", _capture_task)

    result = asyncio.run(
        models_internal.download_model(
            DownloadRequest(
                filename="tiny.gguf",
                hf_url="https://huggingface.co/org/repo/resolve/main/tiny.gguf",
            ),
            _auth(),
            state,
        )
    )

    assert result == {"status": "downloading", "filename": "tiny.gguf"}
    assert len(created) == 1


def test_load_model_rejects_non_gguf_filename(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    state = _make_state(tmp_path)
    monkeypatch.setattr(models_internal, "MODELS_DIR", tmp_path / "models")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            models_internal.load_model(
                LoadRequest(model_filename="weights.safetensors"),
                _auth(),
                state,
            )
        )

    assert exc.value.status_code == 422
    assert ".gguf" in str(exc.value.detail)


def test_load_model_accepts_valid_existing_gguf(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    state = _make_state(tmp_path)
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "tiny.gguf").write_bytes(b"GGUF")
    monkeypatch.setattr(models_internal, "MODELS_DIR", models_dir)
    monkeypatch.setattr(models_internal, "_detect_llama_cpp_status", lambda: {"installed": True})

    created = []

    def _capture_task(coro):
        created.append(coro)
        coro.close()
        return object()

    class _FakeProvider:
        def begin_load(self):
            return True

        def end_load(self):
            return None

        def load_model(self, *args, **kwargs):
            return None

    monkeypatch.setattr(models_internal, "get_internal_provider", lambda: _FakeProvider())
    monkeypatch.setattr(models_internal.asyncio, "create_task", _capture_task)

    result = asyncio.run(
        models_internal.load_model(
            LoadRequest(model_filename="tiny.gguf"),
            _auth(),
            state,
        )
    )

    assert result == {"status": "loading", "filename": "tiny.gguf"}
    assert len(created) == 1

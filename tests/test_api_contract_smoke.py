"""HTTP contract smoke: endpoints the Electron renderer depends on."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_config_and_models_internal_contract(monkeypatch, tmp_path):
    monkeypatch.setenv("ROVOT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("ROVOT_WORKSPACE_DIR", str(tmp_path / "ws"))

    async def _noop_shutdown():
        return None

    monkeypatch.setattr("rovot.server.app.shutdown_browser", _noop_shutdown)

    from rovot.server.app import create_app

    app = create_app()
    token = app.state.rovot_state.auth_token
    headers = {"Authorization": f"Bearer {token}"}

    with TestClient(app) as client:
        hr = client.get("/health")
        assert hr.status_code == 200
        health = hr.json()
        assert health["status"] == "ok"
        assert "host" in health and "port" in health
        assert "workspace_dir" in health

        cr = client.get("/config", headers=headers)
        assert cr.status_code == 200
        cfg = cr.json()
        assert "model" in cfg
        assert "user_mode" in cfg
        assert cfg["model"].get("provider_mode") is not None

        pr = client.post(
            "/config",
            headers=headers,
            json={"path": "onboarded", "value": True},
        )
        assert pr.status_code == 200
        assert pr.json().get("ok") is True
        cfg2 = client.get("/config", headers=headers).json()
        assert cfg2["onboarded"] is True

        rr = client.get("/models/internal/recommend", headers=headers)
        assert rr.status_code == 200
        rec = rr.json()
        for key in ("recommended_filename", "recommended_name", "reason"):
            assert key in rec, f"missing {key} for renderer contract"
        assert str(rec["recommended_filename"]).endswith(".gguf")

        cat = client.get("/models/internal/catalog", headers=headers)
        assert cat.status_code == 200
        assert isinstance(cat.json(), list)
        assert any("filename" in e for e in cat.json())

        st = client.get("/models/internal/status", headers=headers)
        assert st.status_code == 200
        assert "installed" in st.json()

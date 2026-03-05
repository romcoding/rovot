from rovot.secrets import SecretsStore


def test_get_caches_keyring_values(monkeypatch, tmp_path):
    calls = {"count": 0}

    def fake_get_password(service, key):
        calls["count"] += 1
        assert service == "rovot"
        assert key == "auth.token"
        return "token-123"

    monkeypatch.setattr("keyring.get_password", fake_get_password)

    store = SecretsStore(service="rovot", fallback_path=tmp_path / "secrets.json", use_keychain=True)

    assert store.get("auth.token") == "token-123"
    assert store.get("auth.token") == "token-123"
    assert calls["count"] == 1


def test_set_and_delete_update_cache(monkeypatch, tmp_path):
    state = {"value": "initial", "set_calls": 0, "delete_calls": 0}

    def fake_get_password(service, key):
        return state["value"]

    def fake_set_password(service, key, value):
        state["set_calls"] += 1
        state["value"] = value

    def fake_delete_password(service, key):
        state["delete_calls"] += 1
        state["value"] = None

    monkeypatch.setattr("keyring.get_password", fake_get_password)
    monkeypatch.setattr("keyring.set_password", fake_set_password)
    monkeypatch.setattr("keyring.delete_password", fake_delete_password)

    store = SecretsStore(service="rovot", fallback_path=tmp_path / "secrets.json", use_keychain=True)

    assert store.get("model.api_key") == "initial"
    store.set("model.api_key", "updated")
    assert store.get("model.api_key") == "updated"
    store.delete("model.api_key")
    assert store.get("model.api_key") is None

    assert state["set_calls"] == 1
    assert state["delete_calls"] == 1


def test_keychain_available_is_cached(monkeypatch, tmp_path):
    calls = {"count": 0}

    def fake_get_password(service, key):
        calls["count"] += 1
        assert key == "__probe__"
        return None

    monkeypatch.setattr("keyring.get_password", fake_get_password)

    store = SecretsStore(service="rovot", fallback_path=tmp_path / "secrets.json", use_keychain=True)

    assert store.keychain_available is True
    assert store.keychain_available is True
    assert calls["count"] == 1

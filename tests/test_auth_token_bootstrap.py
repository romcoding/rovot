from rovot.config import Settings
from rovot.server.deps import ensure_auth_token


class _FakeSecretsStore:
    def __init__(self, value: str | None = None):
        self.value = value
        self.get_calls = 0
        self.set_calls = 0

    def get(self, key: str, *, source: str = "unknown") -> str | None:
        self.get_calls += 1
        return self.value

    def set(self, key: str, value: str) -> None:
        self.set_calls += 1
        self.value = value


def test_ensure_auth_token_uses_existing_token_file_without_keychain_write(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_dir=tmp_path / "ws")
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    token_path = settings.data_dir / "auth_token.txt"
    token_path.write_text("file-token", "utf-8")

    secrets = _FakeSecretsStore()

    token = ensure_auth_token(settings, secrets)  # type: ignore[arg-type]

    assert token == "file-token"
    assert secrets.get_calls == 0
    assert secrets.set_calls == 0


def test_ensure_auth_token_reads_secret_store_when_file_missing(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_dir=tmp_path / "ws")
    secrets = _FakeSecretsStore(value="stored-token")

    token = ensure_auth_token(settings, secrets)  # type: ignore[arg-type]

    assert token == "stored-token"
    assert secrets.get_calls == 1
    assert secrets.set_calls == 0
    assert (settings.data_dir / "auth_token.txt").read_text("utf-8") == "stored-token"

from __future__ import annotations

import json
from typing import Any

import httpx
import typer

from rovot import __version__
from rovot.config import ConfigStore, Settings
from rovot.secrets import SecretsStore
from rovot.server.deps import ensure_auth_token

app = typer.Typer(name="rovot", help="Local-first personal AI agent.", no_args_is_help=True)
config_app = typer.Typer(name="config", help="Config operations.")
secret_app = typer.Typer(name="secret", help="Secret operations.")
app.add_typer(config_app)
app.add_typer(secret_app)


def _settings_and_stores() -> tuple[Settings, ConfigStore, SecretsStore]:
    s = Settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    s.workspace_dir.mkdir(parents=True, exist_ok=True)
    secrets = SecretsStore(service="rovot", fallback_path=s.data_dir / "secrets.json")
    ensure_auth_token(s, secrets)
    cfg = ConfigStore(path=s.data_dir / "config.json")
    cfg.load()
    cfg.save()
    return s, cfg, secrets


def _auth_token_file(s: Settings) -> str:
    return (s.data_dir / "auth_token.txt").read_text("utf-8").strip()


@app.command()
def onboard() -> None:
    """Run first-time setup: create dirs, generate auth token, write default config."""
    s, cfg, _ = _settings_and_stores()
    typer.echo(f"Workspace: {s.workspace_dir}")
    typer.echo(f"Config: {cfg.path}")
    typer.echo(f"Token file: {s.data_dir / 'auth_token.txt'}")


@app.command()
def start(
    host: str = typer.Option("127.0.0.1"),
    port: int = typer.Option(18789),
) -> None:
    """Launch the loopback control-plane daemon."""
    import uvicorn

    from rovot.server.app import create_app

    uvicorn.run(create_app(), host=host, port=port)


@app.command()
def doctor() -> None:
    """Check config, interface binding, secrets, and permissions."""
    s, _, secrets = _settings_and_stores()
    issues: list[str] = []
    warnings: list[str] = []

    if s.host != "127.0.0.1":
        issues.append(
            f"Control plane binds to {s.host} -- this exposes the daemon to the network. "
            "Use 127.0.0.1 unless you understand the risks (see OpenClaw security guidance)."
        )

    if not s.workspace_dir.is_dir():
        issues.append(f"Workspace directory missing: {s.workspace_dir}")

    token_file = s.data_dir / "auth_token.txt"
    if token_file.exists():
        import stat

        mode = token_file.stat().st_mode
        if mode & (stat.S_IRGRP | stat.S_IROTH):
            warnings.append(
                f"Auth token file {token_file} is readable by group/others. "
                "Run: chmod 600 " + str(token_file)
            )
    else:
        issues.append(f"Auth token file missing: {token_file}")

    fallback = secrets.fallback_path
    if fallback.exists():
        import stat

        mode = fallback.stat().st_mode
        if mode & (stat.S_IRGRP | stat.S_IROTH):
            warnings.append(
                f"Secrets fallback file {fallback} is readable by group/others. "
                "Run: chmod 600 " + str(fallback)
            )

    try:
        import keyring as _kr

        _kr.get_password("rovot", "__doctor_probe__")
        typer.echo("[ok] OS keyring backend available")
    except Exception:
        warnings.append("OS keyring backend unavailable -- secrets will use fallback file storage")

    for w in warnings:
        typer.echo(f"[warn] {w}")
    for i in issues:
        typer.echo(f"[FAIL] {i}")
    if issues:
        raise typer.Exit(code=1)
    if not warnings and not issues:
        typer.echo("All checks passed.")


@app.command()
def chat(message: str = typer.Option(..., "-m")) -> None:
    """Send a message to the running daemon and print the reply."""
    s, _, _ = _settings_and_stores()
    tok = _auth_token_file(s)
    r = httpx.post(
        f"http://127.0.0.1:{s.port}/chat",
        json={"message": message},
        headers={"Authorization": f"Bearer {tok}"},
        timeout=120.0,
    )
    r.raise_for_status()
    typer.echo(r.json()["reply"])


@config_app.command("get")
def config_get() -> None:
    """Print the current config as JSON."""
    _, cfg, _ = _settings_and_stores()
    typer.echo(cfg.config.model_dump_json(indent=2))


@config_app.command("set")
def config_set(path: str, value: str) -> None:
    """Set a config value by dotted path (e.g. model.base_url)."""
    _, cfg, _ = _settings_and_stores()
    try:
        v: Any = json.loads(value)
    except Exception:
        v = value
    cfg.update_path(path, v)
    typer.echo("ok")


@secret_app.command("set")
def secret_set(key: str, value: str) -> None:
    """Store a secret in OS keychain (or fallback file)."""
    s = Settings()
    secrets = SecretsStore(service="rovot", fallback_path=s.data_dir / "secrets.json")
    secrets.set(key, value)
    typer.echo("ok")


@secret_app.command("delete")
def secret_delete(key: str) -> None:
    """Remove a secret from OS keychain (or fallback file)."""
    s = Settings()
    secrets = SecretsStore(service="rovot", fallback_path=s.data_dir / "secrets.json")
    secrets.delete(key)
    typer.echo("ok")


@app.command()
def version() -> None:
    """Print the current version."""
    typer.echo(f"rovot {__version__}")


if __name__ == "__main__":
    app()

"""Typer CLI entry point.

Subcommands:
  start   -- launch the loopback control-plane daemon
  doctor  -- check config, interface binding, and permissions
  chat    -- interactive CLI chat (sends to the local control plane)
"""

from __future__ import annotations

import typer

from rovot import __version__

app = typer.Typer(name="rovot", help="Local-first personal AI agent.", no_args_is_help=True)


@app.command()
def start(
    host: str = typer.Option("127.0.0.1", help="Bind address (loopback recommended)."),
    port: int = typer.Option(18789, help="Port for the local control plane."),
) -> None:
    """Launch the loopback control-plane daemon."""
    import uvicorn

    from rovot.server.app import create_app

    application = create_app()
    uvicorn.run(application, host=host, port=port)


@app.command()
def doctor() -> None:
    """Check config, interface binding, and connector permissions."""
    from rovot.config import load_settings

    settings = load_settings()
    issues: list[str] = []

    if settings.host != "127.0.0.1":
        issues.append(
            f"Control plane binds to {settings.host} -- loopback (127.0.0.1) is recommended."
        )

    if not settings.workspace_dir.is_dir():
        issues.append(f"Workspace directory does not exist: {settings.workspace_dir}")

    if issues:
        for issue in issues:
            typer.echo(f"[!] {issue}")
        raise typer.Exit(code=1)

    typer.echo("All checks passed.")


@app.command()
def chat() -> None:
    """Interactive CLI chat (sends messages to the local control plane)."""
    typer.echo("rovot chat -- not yet implemented")
    raise typer.Exit(code=0)


@app.command()
def version() -> None:
    """Print the current version."""
    typer.echo(f"rovot {__version__}")

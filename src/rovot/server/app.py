"""FastAPI application factory for the loopback control plane."""

from __future__ import annotations

from fastapi import FastAPI

from rovot import __version__
from rovot.server.routes import chat, health, tools


def create_app() -> FastAPI:
    """Build and return the FastAPI application with all routes mounted."""
    app = FastAPI(
        title="Rovot Control Plane",
        version=__version__,
        docs_url="/docs",
    )

    app.include_router(health.router)
    app.include_router(chat.router, prefix="/chat", tags=["chat"])
    app.include_router(tools.router, prefix="/tools", tags=["tools"])

    return app

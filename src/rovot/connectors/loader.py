from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from rovot.config import AppConfig
from rovot.connectors.browser import BrowserConnector
from rovot.connectors.email_imap_smtp import EmailConnector
from rovot.connectors.filesystem import FileSystemConnector
from rovot.secrets import SecretsStore

logger = logging.getLogger(__name__)

_browser_singleton: BrowserConnector | None = None
_mcp_clients: list = []


@dataclass
class LoadedConnectors:
    fs: FileSystemConnector
    email: EmailConnector | None
    browser: BrowserConnector | None


def get_browser_connector(enabled: bool) -> BrowserConnector | None:
    global _browser_singleton
    if not enabled:
        return None
    if _browser_singleton is None:
        _browser_singleton = BrowserConnector(headless=True)
    return _browser_singleton


async def shutdown_browser() -> None:
    """Call at daemon shutdown to cleanly close the browser."""
    global _browser_singleton
    if _browser_singleton is not None:
        await _browser_singleton.close()
        _browser_singleton = None


async def get_mcp_clients(cfg: AppConfig) -> list:
    """Start and return active MCP clients. Clients are cached globally."""
    global _mcp_clients
    if _mcp_clients:
        return _mcp_clients
    from rovot.connectors.mcp_client import McpClient, McpServerConfig

    clients = []
    for server in cfg.connectors.mcp_servers:
        if not server.enabled:
            continue
        client = McpClient(
            McpServerConfig(name=server.name, command=server.command, env=server.env)
        )
        try:
            await client.start()
            clients.append(client)
        except Exception as exc:
            logger.warning("Failed to start MCP server '%s': %s", server.name, exc)
    _mcp_clients = clients
    return clients


async def shutdown_mcp_clients() -> None:
    """Call at daemon shutdown to stop all MCP server subprocesses."""
    global _mcp_clients
    for client in _mcp_clients:
        await client.stop()
    _mcp_clients = []


def load_connectors(cfg: AppConfig, workspace: Path, secrets: SecretsStore) -> LoadedConnectors:
    fs = FileSystemConnector(workspace=workspace)

    email_conn: EmailConnector | None = None
    if cfg.connectors.email.enabled:
        pw = secrets.get(cfg.connectors.email.password_secret) or ""
        email_conn = EmailConnector(
            consent_granted=cfg.connectors.email.consent_granted,
            username=cfg.connectors.email.username,
            password=pw,
            imap_host=cfg.connectors.email.imap_host,
            imap_port=cfg.connectors.email.imap_port,
            smtp_host=cfg.connectors.email.smtp_host,
            smtp_port=cfg.connectors.email.smtp_port,
            smtp_from=cfg.connectors.email.smtp_from,
            allow_from=cfg.connectors.email.allow_from,
        )

    browser_conn = get_browser_connector(cfg.connectors.browser_enabled)

    return LoadedConnectors(fs=fs, email=email_conn, browser=browser_conn)

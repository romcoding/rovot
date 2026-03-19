from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from rovot.config import AppConfig
from rovot.connectors.browser import BrowserConnector
from rovot.connectors.email_imap_smtp import EmailConnector
from rovot.connectors.filesystem import FileSystemConnector
from rovot.secrets import SecretsStore

_browser_singleton: BrowserConnector | None = None


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

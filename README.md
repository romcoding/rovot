# Rovot

Rovot is a local-first personal AI agent with a loopback-only control-plane daemon and a minimal tool-driven agent loop.

This repo contains:

- **Python backend daemon** (FastAPI + WebSocket events)
- **Electron desktop UI** (simple chat + approvals + tool trace + voice input stub)
- **OpenAI-compatible model adapter** (LM Studio / Ollama / vLLM / remote OpenAI-compatible)
- **Connectors**: filesystem + IMAP/SMTP email (plus stubs for calendar/messaging)

## Quick start (backend only)

Prereqs: Python 3.11+

```bash
pip install -e ".[dev]"
rovot onboard
rovot start
```

Then open:
- Health: http://127.0.0.1:18789/health
- API docs: http://127.0.0.1:18789/docs

## Quick start (desktop)

Prereqs: Node 18+ and Python 3.11+

Terminal A:
```bash
pip install -e ".[dev]"
rovot onboard
rovot start
```

Terminal B:
```bash
cd desktop
npm install
npm run dev
```

## Configure a model

Rovot calls an OpenAI-compatible endpoint:
- Default: `http://localhost:1234/v1` (LM Studio typical port).
- Ollama: `http://localhost:11434/v1`
- vLLM: `http://localhost:8000/v1`

Update config:
```bash
rovot config set model.base_url http://localhost:11434/v1
rovot config set model.model gpt-oss:20b
```

## Email connector (IMAP/SMTP)

Enable the connector and set `consent_granted` explicitly:

```bash
rovot config set connectors.email.enabled true
rovot config set connectors.email.consent_granted true
rovot config set connectors.email.imap_host imap.gmail.com
rovot config set connectors.email.imap_port 993
rovot config set connectors.email.smtp_host smtp.gmail.com
rovot config set connectors.email.smtp_port 587
rovot config set connectors.email.username my-bot@gmail.com
rovot secret set email.password "APP_PASSWORD_HERE"
```

Sending email requires approval in the UI (or via approvals endpoint).

## Security defaults

- Loopback-only daemon binding.
- Mandatory bearer token (stored locally, permission-restricted).
- Workspace-only file access by default.
- Explicit approvals required for shell execution and email sending.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              Electron Desktop App                     │
│    Renderer UI: chat, approvals, tool trace, settings │
│    Main: spawns daemon + reads token file             │
└───────────────────────┬──────────────────────────────┘
                        │ HTTP + WebSocket
┌───────────────────────▼──────────────────────────────┐
│          Local Control Plane Daemon                   │
│              FastAPI + WebSocket                      │
│                                                       │
│  Auth + Scopes (Bearer token)                         │
│  HTTP API: /chat /approvals /config /voice            │
│  WebSocket Events: session updates, approvals         │
│                                                       │
│  Agent service (session orchestration)                │
│    └─ AgentLoop (LLM ↔ tools)                        │
│       └─ ToolRegistry (fs/web/exec/email)            │
│       └─ Policy engine (scopes + approvals)          │
│                                                       │
│  Connectors: filesystem + IMAP/SMTP + stubs           │
│  Local stores: sessions.jsonl, approvals.json, audit  │
│  Secrets store: keyring + fallback                    │
└───────────────────────────────────────────────────────┘
```

## CLI commands

| Command | Description |
|---|---|
| `rovot onboard` | First-time setup: create dirs, generate auth token, write default config |
| `rovot start` | Launch the control-plane daemon |
| `rovot doctor` | Check config, interface binding, permissions |
| `rovot chat -m "message"` | Send a message to the running daemon |
| `rovot config get` | Print current config as JSON |
| `rovot config set <path> <value>` | Update a config value by dotted path |
| `rovot secret set <key> <value>` | Store a secret in OS keychain |
| `rovot version` | Print version |

## Packaging

- macOS: `cd desktop && npm run dist:mac`
- Windows: `cd desktop && npm run dist:win`

To bundle the backend into a single executable, use the PyInstaller scripts in `desktop/scripts/` and adjust `desktop/main.js` to spawn `backend-bin/rovot-daemon` instead of `rovot start`.

## License

MIT

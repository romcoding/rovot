# Rovot

Rovot is a local-first personal AI agent with a loopback-only control-plane daemon and a minimal tool-driven agent loop.

This repo contains:

- **Python backend daemon** (FastAPI + WebSocket events)
- **Electron desktop UI** (sidebar navigation, onboarding wizard, approvals, model management, connectors, security dashboard, audit logs)
- **OpenAI-compatible model adapter** (LM Studio / Ollama / vLLM / remote OpenAI-compatible)
- **Connectors**: filesystem + IMAP/SMTP email (plus stubs for calendar/messaging)

## Quick start (backend only)

Prereqs: Python 3.11+

```bash
python -m venv .venv && source .venv/bin/activate
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

On first launch the UI shows an onboarding wizard that auto-detects local model servers, lets you pick a workspace, and configure connectors.

## Configure a model

Rovot calls an OpenAI-compatible endpoint:
- Default: `http://localhost:1234/v1` (LM Studio typical port).
- Ollama: `http://localhost:11434/v1`
- vLLM: `http://localhost:8000/v1`

Update config via CLI:
```bash
rovot config set model.base_url http://localhost:11434/v1
rovot config set model.model gpt-oss:20b
```

Or use the **Models** view in the desktop UI to change the base URL, pick a model, and rescan servers.

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

Sending email requires approval in the UI (or via the approvals API endpoint).

## Security defaults

- Loopback-only daemon binding (warns on startup and via `doctor` if overridden).
- Mandatory bearer token (stored locally, permission-restricted file + OS keychain).
- Workspace-only file access by default.
- Explicit approvals required for shell execution and email sending (deterministic replay).
- Audit log with automatic secrets redaction.
- `rovot doctor` checks token permissions, keyring availability, workspace state, and binding.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  Electron Desktop App                     │
│    Onboarding wizard | Sidebar: Chat, Models,             │
│    Connectors, Security, Logs | Approvals UX              │
│    Main process: spawns bundled daemon + reads token       │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP + WebSocket (loopback)
┌───────────────────────▼──────────────────────────────────┐
│            Local Control Plane Daemon                     │
│                FastAPI + WebSocket                        │
│                                                           │
│  Auth + Scopes (Bearer token)                             │
│  HTTP API: /chat /approvals /config /voice                │
│            /models/available /audit/recent                 │
│  WebSocket Events: session updates, approvals             │
│                                                           │
│  Agent service (session orchestration)                    │
│    └─ AgentLoop (LLM ↔ tools)                            │
│       └─ ToolRegistry (fs/web/exec/email)                │
│       └─ Policy engine (scopes + approvals)              │
│                                                           │
│  Connectors: filesystem + IMAP/SMTP + stubs               │
│  Local stores: sessions.jsonl, approvals.json, audit.log  │
│  Secrets store: OS keyring + permission-restricted fallback│
└───────────────────────────────────────────────────────────┘
```

## CLI commands

| Command | Description |
|---|---|
| `rovot onboard` | First-time setup: create dirs, generate auth token, write default config |
| `rovot start` | Launch the control-plane daemon |
| `rovot doctor` | Check config, binding, token permissions, keyring, workspace |
| `rovot chat -m "message"` | Send a message to the running daemon |
| `rovot config get` | Print current config as JSON |
| `rovot config set <path> <value>` | Update a config value by dotted path |
| `rovot secret set <key> <value>` | Store a secret in OS keychain |
| `rovot secret delete <key>` | Remove a secret from OS keychain |
| `rovot version` | Print version |

## Packaging

### Build the backend binary

```bash
cd desktop
npm run build:backend           # native arch
npm run build:backend:arm64     # macOS Apple Silicon
npm run build:backend:x64       # macOS Intel
npm run build:backend:universal2 # macOS universal
```

This uses PyInstaller to produce `desktop/backend-bin/rovot-daemon`. The packaged Electron app automatically spawns this binary instead of requiring Python on the user's machine.

### Build the DMG (macOS)

```bash
cd desktop
npm run dist:mac
```

The DMG includes a custom background, app icon, and Applications symlink. Output goes to `desktop/dist/`.

### Build the EXE installer (Windows)

```bash
cd desktop
npm run dist:win
```

Uses NSIS with assisted install mode and user-selectable install directory.

### Code signing and notarisation (macOS)

For distribution outside the Mac App Store, set these environment variables before building:

```bash
export APPLE_ID="your@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

The build automatically signs with hardened runtime and notarises via `@electron/notarize`. Without these env vars, signing is skipped (fine for local development).

### App icons

Place your icons in `desktop/build/`:
- `icon.icns` -- macOS app icon
- `icon.ico` -- Windows app icon
- `dmg-background.png` -- DMG installer background (540x380 recommended)

## Desktop UI structure

The Electron app uses a sidebar navigation layout:

- **Chat** -- Conversation with the agent, inline approval cards, voice input
- **Models** -- Active model config, auto-detect local servers (LM Studio, Ollama, vLLM)
- **Connectors** -- Toggle filesystem, email, calendar, messaging; view consent states
- **Security** -- Daemon binding, sandbox mode, workspace path, token status, permissions
- **Logs** -- Audit trail with timestamps, events, and redacted payloads

Top bar shows: active model indicator, privacy mode (Local/Cloud), connection status.

## License

MIT

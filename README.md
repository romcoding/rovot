# Rovot

A local-first personal AI agent packaged as a consumer desktop app for macOS and Windows. Rovot combines the control-plane rigor of projects like OpenClaw with the minimal-kernel philosophy of Nanobot, wrapped in an experience layer that normal users can install, understand, and trust.

The differentiator is not "another agent loop." It is packaging, permissions, safety boundaries, and a connector UX that non-experts cannot misconfigure.

## Design Principles

- **Local-first, cloud-optional.** Choose fully local inference, connect to a cloud provider via API key/OAuth, or run hybrid (local for routine tasks, cloud for heavy reasoning).
- **Security by default.** The local server binds to loopback only. High-risk actions require explicit approval. Sandboxing is available out of the box.
- **Minimal kernel, pluggable connectors.** The core agent loop and tool surface are small and auditable. Everything else -- email, calendar, messaging -- is an optional connector/plugin.
- **Human-auditable state.** Sessions, memory, and skills are stored as inspectable local files you can version-control, review, or delete.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Desktop UI                      │
│         (chat, tool trace, approvals, logs)      │
└──────────────────────┬──────────────────────────┘
                       │
              loopback only
                       │
┌──────────────────────▼──────────────────────────┐
│              Local Control Plane                 │
│  ┌──────────┐ ┌───────────┐ ┌───────────────┐   │
│  │  Chat    │ │ Connector │ │  Tool Exec    │   │
│  │ Endpoint │ │  Events   │ │  Requests     │   │
│  └────┬─────┘ └─────┬─────┘ └──────┬────────┘   │
│       └─────────┬───┘──────────────┘             │
│                 ▼                                 │
│  ┌──────────────────────────────────────────┐    │
│  │           Policy & Permission Engine     │    │
│  │   (role/scope gating, exec approvals)    │    │
│  └──────────────────┬───────────────────────┘    │
│                     ▼                            │
│  ┌──────────────────────────────────────────┐    │
│  │             Agent Runtime                │    │
│  │  messages → context → LLM → tool calls  │    │
│  │            → response                    │    │
│  └──────────────────┬───────────────────────┘    │
│                     ▼                            │
│  ┌──────────────────────────────────────────┐    │
│  │           Isolation Layer                │    │
│  │  workspace-only │ container │ elevated   │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │         State & Memory (local files)     │    │
│  │  sessions · memory · skills · audit log  │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### Local Control Plane

A loopback-only daemon that exposes chat endpoints (UI to agent), connector event ingestion (email triggers, file watchers), tool execution requests, and an audit log. Inspired by OpenClaw's Gateway design: even on a single machine, the control plane encodes privilege boundaries and enforces auth when exposure is ever expanded beyond localhost.

### Agent Runtime

A Nanobot-style loop: ingest messages, build context, call the LLM, execute tool calls, return a response. The tool registry is explicit and small -- filesystem read/write/edit/list, shell exec, web fetch, message send, subagent spawn, and cron scheduling. Everything beyond this set is a connector or plugin.

### Policy & Permission Engine

Operations are gated by role and scope (admin / read / write / approvals). High-risk tools (shell execution, outbound email, file deletion) go through an explicit two-phase approval flow with timeouts and an auditable trail.

### Isolation Layer

Three tiered security modes:

| Mode | Default? | Behaviour |
|---|---|---|
| **Workspace-only** | Yes | File tools limited to a user-chosen directory; shell runs inside the workspace. |
| **Container sandbox** | Opt-in | Tool execution runs inside a container with configurable workspace mount (none / read-only / read-write) and no network by default. |
| **Elevated host** | Explicit | Full host access granted per-action with approval prompts and "record mode" auditing. |

### State & Memory

All state lives in inspectable local files: sessions, consolidated memory (markdown), skills, and audit logs. Session pruning, TTL caching, and file rotation prevent unbounded growth.

## Model Support

Rovot treats **OpenAI-compatible HTTP endpoints** as the universal adapter for local inference:

- **LM Studio** -- point to `http://localhost:<port>/v1`. Includes a built-in model downloader and supports offline operation.
- **Ollama** -- OpenAI compatibility layer with `/v1/chat/completions`.
- **vLLM** -- OpenAI-compatible server exposing `/v1/models` and `/v1/chat/completions`.

For cloud models, connect via API key or OAuth. The provider abstraction exposes `listModels()`, `chat()`, `supportsTools()`, `supportsVision()`, and `supportsStreaming()`. Credentials are stored per-profile, never pasted into plaintext config.

### Model Download UX

On first run, the user chooses one of:

1. **Use LM Studio** (recommended) -- auto-detect a running local server, health-check it, and go.
2. **Use Ollama** -- list available models, prompt to pull if needed.
3. **Bring your own endpoint** -- any OpenAI-compatible URL.
4. **Cloud provider** -- enter an API key or authenticate via OAuth.

## Connectors & Capabilities

Connectors are plugins. The core defines a small **capability taxonomy**; connectors implement one or more capabilities.

| Capability | Examples |
|---|---|
| **Messaging** | Send/receive messages, threads, attachments |
| **Email** | Read, search, draft, send, label/archive |
| **Calendar** | Read events, create/update, check availability |
| **Files** | Read/write/list/search within approved roots |
| **Browser** | Web fetch (safe), web control (high-risk) |
| **Tasks / Automation** | Cron jobs, webhook triggers, recurring workflows |

Each connector declares:

- Data domains it touches (mail, calendar, files, ...)
- Requested OAuth scopes / permissions
- Whether it can read vs. act (write/send)
- Which actions require per-call approval
- Retention rules for cached data

### v1 Connector Targets

- **Email + Calendar:** Google (Gmail / Google Calendar), Microsoft (Outlook / Exchange Online), and a universal IMAP/SMTP fallback.
- **Files:** Local workspace (default) plus user-approved additional folders. Cloud storage (Drive, OneDrive, Dropbox) deferred until OAuth and least-privilege controls are solid.
- **Messaging:** Telegram, Discord, and Slack bots. WhatsApp deferred due to brittle device-linking flows.

## Voice Input

A modular voice subsystem inspired by [Handy](https://handy.computer/) -- an open-source, local speech-to-text tool where "your voice stays on your computer."

- Voice input feeds text into the same agent entrypoint as typed input.
- Local transcription by default; cloud STT only when explicitly enabled and visibly indicated.
- Push-to-talk, selectable microphone, language choice, and real-time partial transcriptions.

## Security Design

These are non-negotiable requirements derived from real-world incidents in the OpenClaw ecosystem (malicious skills, misconfiguration-driven RCE, organisations banning deployments over security concerns).

- **Loopback-only by default.** Clear warnings and mandatory auth if network exposure is enabled.
- **Strict content separation.** Untrusted content (web pages, inbound emails, "canvas" HTML) is isolated from privileged surfaces (control UI, local file APIs).
- **Supply-chain controls for plugins/connectors.** Signed plugin manifests, install-time scanning, no install scripts, permissions declared and enforced at runtime.
- **First-class exec approvals.** Shell execution, outbound sends, and file deletion require explicit approval with an auditable trail.
- **Sandboxed tool execution.** Optional container isolation with "no network" default and constrained workspace mounts.
- **OS-grade secret storage.** API keys and OAuth tokens stored in macOS Keychain / Windows Credential Locker. No plaintext config files for secrets.

## Roadmap

### Milestone 1 -- Minimal Shippable Kernel

The goal is to ship early with a working agent loop.

- Agent kernel: message ingestion, context builder, tool registry, provider abstraction (OpenAI-compatible HTTP + one cloud provider).
- Desktop UI: chat interface, tool-use trace, approval prompts, logs.
- Workspace picker: file read/write restricted to a user-chosen directory by default.
- Approval & policy engine (v1): two-phase request/resolve flow with timeouts and audit.

### Milestone 2 -- Plugin System + Connectors + Credential Storage

- Plugin system with manifest + JSON schema for config. Validate without executing code. Allow/deny lists; bundled plugins disabled by default except a small safe set.
- Connector framework: each connector declares data domains, scopes, approval-required actions, and retention rules.
- Credential storage: macOS Keychain and Windows Credential Locker integration.

### Milestone 3 -- Automation

- Cron service with persisted jobs and clear deliver-vs-run semantics.
- Inbound webhooks treated as untrusted: strict payload mapping, redacted logs, limited attack surface.

### Milestone 4 -- Voice + Distribution

- Voice input module: push-to-talk, language selection, local transcription by default.
- macOS: signed app bundle + `.dmg` with sandbox-friendly file access (user-selected folders).
- Windows: installer registering a per-user service, secrets via Credential Locker.

### Ongoing

- Keep core vs. optional boundaries strict. Connectors and skill packs are optional layers.
- Built-in `rovot doctor` command that checks config permissions, whether the daemon is bound to a safe interface, and whether any connector has write access without approvals enabled.

## Inspirations

| Project | What Rovot borrows |
|---|---|
| [OpenClaw](https://openclaw.ai/) | Gateway architecture, WebSocket control plane, role/scope enforcement, exec approvals, plugin discovery and manifests, sandboxing model, session store patterns. |
| [Nanobot](https://github.com/HKUDS/nanobot) | Minimal agent loop, explicit tool registry, workspace restriction, file-based memory/state, cron service, message bus decoupling. |
| [NanoClaw](https://news.ycombinator.com/item?id=46850205) | Ultra-small TypeScript core, OS-level container isolation per chat, "lean means smaller audit surface." |
| [Handy](https://handy.computer/) | Local-first speech-to-text, privacy-first voice UX, "your voice stays on your computer." |

## License

TBD

# k5-work — open-source Cowork clone

Web app, TypeScript full-stack, model-agnostic via **ACP (Agent Client Protocol)** bindings to open-source coding harnesses (e.g. `opencode acp`).

Thin-slice MVP covering all four pillars:

- **Computer Use** — sandboxed desktop (Docker + noVNC) with screenshot / click / type / shell tools, permission-gated
- **Browser Use** — Playwright-backed navigate / snapshot / click / type tools
- **Office docs** — `.xlsx` (exceljs), `.pptx` (pptxgenjs), `.docx` (docx) generation tools
- **Company integrations** — Slack, Notion, Linear, Jira connectorsbehind a common `Connector` interface

## Quickstart

```bash
cp .env.example .env
npm install
npm run dev
# web: http://localhost:5173
# server health: http://127.0.0.1:8787/health
```

The Node server owns sessions, projects, permissions, and shutdown. Vite is a
dev proxy only: it serves the app and forwards `/api` and `/ws` to
`K5_SERVER_ORIGIN`, so the project API is reachable on both the web dev origin
and the server origin.

The server refuses any `Host` header outside its allowlist with `421`. A rebound
DNS name makes a request same-origin, so this check is what stops a hostile page
from reading your project list or opening arbitrary directories through
`/api/projects/open`. Loopback names are always allowed; add `K5_ALLOWED_HOSTS`
only for a tunnel, and never set `ALLOW_REMOTE=true` on a reachable interface.

The server binds to loopback by default. A non-loopback `HOST` requires
`ALLOW_REMOTE=true`; do not expose the project API publicly.

The server exposes health, project discovery, and the `/ws` gateway. A harness
process is started lazily: nothing ACP-related runs until you send a first
prompt, and the seat is reaped when the tab closes or a new task starts.

`ACP_COMMAND` is tokenised shell-style and spawned without a shell. It is
required only when a session is opened; a missing value is reported as a typed
`harness-unconfigured` failure rather than a crash on boot.

**Models are discovered, not hardcoded.** The composer menu is populated from the
`configOptions` the harness advertises at `session/new`, so it only ever offers
models the current machine can actually reach. With no vendor credentials
configured that means the free models your harness offers, not a static list of
paid ones. Switching a model is applied to the seat via ACP
`session/set_config_option`; a value the harness never offered is refused.

## Tests

```bash
npm test                    # shared + server (node:test)
npm run test -w apps/web    # browser layer (vitest + jsdom)
```

The real-harness tests skip with a printed reason when the binary or its
credentials are unavailable. They never mock a pass.

To verify the ACP seat against a real harness (starts one short-lived child,
prints the negotiated protocol facts, then reaps it):

```bash
npm run build -w server
ACP_COMMAND="opencode acp" npm run probe -w server
```

It exits non-zero on a real failure and reports an explicit `SKIP` when the
harness binary or its provider authentication is unavailable.

Sandbox for Computer Use (optional):

```bash
docker compose up sandbox
# VNC: http://localhost:6901
```

## Layout

- `apps/web` — React chat + approvals + workspace UI (Cowork feel)
- `server` — Node HTTP health/API server, ACP service foundations, and tools
- `shared` — Tool / event / connector types shared by both

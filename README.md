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
# server health: http://localhost:8787/health
# project API is available on both the web dev origin and the server origin
```

The server binds to loopback by default. A non-loopback `HOST` requires
`ALLOW_REMOTE=true`; do not expose the project API publicly.

The current server runtime exposes health and project-discovery endpoints. ACP
service/plug contracts are implemented separately; no external ACP process is
started by the default dev command.

Sandbox for Computer Use (optional):

```bash
docker compose up sandbox
# VNC: http://localhost:6901
```

## Layout

- `apps/web` — React chat + approvals + workspace UI (Cowork feel)
- `server` — Node HTTP health/API server, ACP service foundations, and tools
- `shared` — Tool / event / connector types shared by both

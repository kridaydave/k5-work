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
# web: http://localhost:5173  server: http://localhost:8787
```

ACP mode (default `mock` works with no keys):

```bash
ACP_COMMAND="opencode acp"  # any ACP server on stdio
# or OpenAI-compatible fallback:
# MODEL_BASE_URL=https://api.anthropic.com/v1 OPENAI_API_KEY=...
```

Sandbox for Computer Use (optional):

```bash
docker compose up sandbox
# VNC: http://localhost:6901
```

## Layout

- `apps/web` — React chat + approvals + workspace UI (Cowork feel)
- `server` — Express + WS agent loop, ACP client, tools, integrations
- `shared` — Tool / event / connector types shared by both

# k5-work

k5-work is an open-source web equivalent of Claude Cowork. A TypeScript full-stack app connects to open coding harnesses through the Agent Client Protocol (ACP) and delivers agentic work across browser use, office document generation, computer use, and future company integrations.

You can think of k5-work as an open-source, harness-agnostic desktop agent workspace that runs on everyday hardware without vendor lock-in.

## Product pillars

We build for real users who want agency on normal machines without vendor lock-in. These pillars guide all architecture and code decisions.

### 1. Harness-agnostic (ACP preferred)
k5-work never locks to a single model provider or runtime. Agents connect preferably through standard ACP stdio bindings to open harnesses like OpenCode, Kilo Code, and Cline, with direct harness SDKs supported where practical. The core server keeps one stable service interface, and per-harness plugs remain thin adapters that only spawn processes and translate wire protocol.

### 2. Potato-friendly and local-first
Heavy setups like Docker-per-session are rejected for local runs. v1 runs locally with a direct file workspace and browser tool. The full computer-use desktop slot stays visually disabled in potato mode until lightweight background drivers land.

### 3. Structured office deliverables
Office files must open cleanly without repair dialogs. Document generation follows a strict JSON-in, engine-out architecture via `k5-ooxml-core`. Sequential raw XML generation is forbidden because presentation and spreadsheet formats require global relationship consistency.

### 4. Pragmatic tooling: buy over build
We do not build custom agent loops or browser drivers from scratch. We drive the browser through official MCP tools (Playwright MCP for navigation, Chrome DevTools MCP for debugging). Where proven open tooling exists, we wrap it instead of reinventing it.

## A note from Kriday

I like ambitious ideas, simple systems, and software that feels obvious. I build simple solutions to real problems that people or I actually face. Do not preserve complexity just because it already exists, and do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and YAGNI. If something bold and meaningfully better is on the table, propose it first. Think of these instructions as solid defaults and guardrails, not rigid dogmas. My direct instructions always override anything written here.

## A small glossary

We keep terminology consistent across prompts and code:

- **you** means the agent reading this file and modifying k5-work.
- **we, us, and maintainers** mean Kriday and the people building k5-work.
- **user** means the person directing work in the k5-work browser UI.
- **agent** means the coding agent executing inside the chosen harness.
- **harness or seat** means the agent runtime running inside k5-work (such as OpenCode, Kilo Code, Cline, Claude), unless explicitly mentioned otherwise.
- **plug** means the thin protocol adapter translating between our service interface and a harness (via ACP or direct SDK).
- **service** means the core k5-work backend orchestration layer.
- **connector** means an external service integration (Slack, Notion, Linear) exposed over MCP.

## The five ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or kill a PID by matching names or worktree paths. Your own agent process has this path in its argv, and dev servers may share the host. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` matches your worktree.
2. **Demanding processes without approval.** Never run unapproved repo-wide checks (`npm test` across all workspaces, full monorepo typechecks, or docker builds). k5-work is designed to run on everyday and lower-spec machines; unthrottled runs will freeze developer systems. Run the smallest, most targeted check for the exact code touched. For example, if you touch OpenCode's ACP plug, test only that plug's unit test and verify the composer integration, never the whole suite.
3. **AGPL contamination.** SuperDoc is licensed under AGPLv3. It is fine as an external reference and optional docx driver behind the common interface, but never copy, vendor, or import AGPL code into `k5-ooxml-core` or internal packages. Our core packages must remain clean MIT code.
4. **Baking in localhost origins.** Never hardcode `localhost` or static port strings in frontend code or Vite configs. Dev is single-origin with Vite proxying `/api` and `/ws`. Hardcoded URLs immediately break remote access and network tunneling.
5. **Faking passes or benchmarks.** Never write tautological assertions, never mock execution just to claim a pass, and never let failing tests exit with code 0. If a dependency or tool is missing, explicitly skip or fail loudly.

## Hit every surface

A change that works on the single path you tested and breaks another surface is an incomplete fix. Before calling work done, audit this checklist:

- **Follow the UI to a T.** The interface in `apps/web/` is locked and intentionally tuned. Preserve the exact layout, window chrome, and spacing. Never redesign, restyle, or alter UI components unless Kriday (core maintainer) explicitly requests it.
- **Visual and icon discipline.** True dark theme only (`#000` background, clean white text). Green and red are reserved strictly for diff counts. No purple or blue ambient glows. Use standard icon packs like Lucide or Shadcn UI glyphs. Never use emojis.
- **Harness plugs.** If you modify tool dispatch, session lifecycle, or prompt serialization, check that you did not break sibling plugs (OpenCode, Kilo Code, Cline, Claude).
- **UI states.** Every view must support the empty hero state (the centered "What should we build in {project}?" card) as cleanly as active states. Busy panels and changed file lists appear only after real work lands.
- **Sidebar & window chrome.** The left sidebar defaults to an icon rail, shows a `<` glyph on hover, and animates expand and collapse.
- **Contracts.** Any payload crossing the wire between server and web is typed and validated in `shared`. Update the contract schema first, then web and server follow.
- **Reverse states.** If you add a way to open or enable something, add the way to close or disable it. A one-way door is a bug.

## Dev servers and workflow

- Install dependencies from the repository root with `npm install`.
- Start both server and client with `npm run dev`. Web runs on port 5173, server on port 8787.
- Always track spawned process IDs. Stop background tasks only by their captured PID.
- ACP and MCP subprocesses run over local stdio. Stdio pipes must be cleanly reaped on shutdown. Never leave orphaned child harnesses running.

## Verifying and test integrity

- Provide the smallest proof that your change works. Run targeted tests with `npm test -w <workspace>` (for example, `npm test -w server`) or target a single test file.
- Do not run repository-wide test suites or full monorepo typechecks unless explicitly asked.
- Zero tolerance for faked passes: tests must fail loudly with non-zero exit codes. If an external harness or binary is missing in the environment, mark the test as skipped, never fake a pass.
- Write tests that verify real, observable behavior. Do not render static component trees just to assert callback wiring or prop names.
- Async flows must wait on explicit events or receipts, never on arbitrary `sleep` calls or polling loops.
- **Office deliverables:** Every generated docx, xlsx, or pptx fixture must pass schema validation and open without repair dialogs.
- **Browser verification:** When testing browser tools, demand evidence-based asserts (exact URL changes or DOM text checks). Do not trust unverified completion status.

## Architecture and boundary rules

To prevent architectural bloat, enforce these strict component boundaries:

- **Plugs are thin adapters.** A plug in `server/src/acp/` owns only two jobs: spawning the harness process and translating wire protocol (JSON-RPC over stdio). Zero business logic belongs in plugs.
- **Service owns orchestration.** The core server owns session state, tool registration, timeout policies, audit logging, and permission gates.
- **JSON-in, engine-out for office.** AI prompts must only generate clean JSON structures. `k5-ooxml-core` owns element ordering, rId allocation, content-type mapping, and Deflate packaging. Never ask an agent or harness to assemble raw OOXML strings.
- **Zod at the boundaries.** Every external payload (integrations, MCP tools, web socket messages) must be validated with Zod schemas in `shared`. Handle schema drift gracefully with explicit error logs instead of silent null writes.

## Where code lives

- `apps/web`: React, Vite, and Tailwind frontend, including window chrome, sidebar, composer, and status pills.
- `server`: Express, WebSocket server, ACP harness managers, and tool dispatchers.
- `server/src/acp`: Wire protocol adapters and per-harness plugs.
- `server/src/tools`: Tool implementations (Playwright MCP browser wrappers, office generator dispatchers).
- `server/src/integrations`: Connector adapters (Slack, Notion, Linear, Jira).
- `shared`: Cross-boundary Zod schemas, TypeScript types, and wire contracts.
- `docs`: Architecture research, specifications, and locked decision logs.

## Documentation and git hygiene

- **Code is the primary record.** Most code changes do not need internal documentation updates. Types and tests explain implementation details.
- `docs/` is reserved for durable architectural decisions, cross-component constraints, and subtle gotchas that are invisible from code.
- Never narrate control flow, list methods, or maintain manual file catalogs in markdown.
- Never commit implementation plans, scratch files, or test artifacts. Keep temporary working notes outside git tracking.
- Never open a pull request unless Kriday explicitly requests one. Use conventional commit titles in plain language: `feat(acp): add opencode stdio handshake`. One concern per PR.

## Taste and engineering standards

- **Types first.** Inferred types over manual type annotations where clear. `any` is strictly forbidden. Do not create functions that merely wrap type casts.
- **Quiet, fast UI.** Avoid continuous CSS animations that trigger GPU repainting on high-refresh displays.
- **Direct, intentional comments.** Comments explain why an approach was chosen or describe non-obvious edge cases. Do not narrate obvious lines of code. Keep comments synchronized when code moves.
- **The escape hatch.** If a rule in this file conflicts with a direct instruction or blocks the task in front of you, state the conflict clearly and get Kriday's sign-off before breaking it.

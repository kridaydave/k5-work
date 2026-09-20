# k5-work — technical talk summary

## Vision
k5-work, an open-source Claude Cowork equivalent. Four pillars: computer use, browser use, office doc generation (xlsx, pptx, docx), and company integrations (Slack, Notion, Linear, Jira).

## Platform and model locks
- Web app first, TypeScript full-stack.
- Models via ACP (Agent Client Protocol) to open harnesses, not baked to one vendor. Seats: OpenCode, Kilo Code, Cline.
- One stable service interface owns prompts, tools, permissions, sessions, and audit. Each harness gets a thin plug that only spawns the process and translates wire protocol. No business logic in plugs. ACP is stdio JSON-RPC today, so plugs stay local until remote transport matures.

## Office docs: custom core
- Decision: build your own OOXML libs. The only sane shape is JSON-in, engine-out, because pptx and xlsx need global consistency (content types, rel IDs, element order, embedded workbooks) that sequential generation can't hold. Even Microsoft's own SDK shipped repair-dialog bugs, so a validator plus Windows PowerPoint test gate is part of the plan.
- Structure: one `k5-ooxml-core` (zip, rels, content types, ID allocation, validation) with thin docx, xlsx, pptx drivers on top, create-only first. SuperDoc stays as reference and optional docx driver behind the same interface, never hardcoded, so AGPL never leaks into your core.

## Browser use: buy, don't build
- No custom agent loop. Built-in browser driven through MCP: Playwright MCP for driving flows, Chrome DevTools MCP for debugging them. Isolated profiles, domain allowlist, step budget, evidence-based asserts instead of trusting "done". CLI over MCP for repeatable flows since it costs roughly a quarter of the tokens.

## Computer use: deferred, no Docker
- No custom vision grounder. OSWorld numbers say grounding is the hard part and open drivers already exist (Cua MIT drivers and sandbox SDK, open Codex-style Mac layers over MCP).
- Docker-per-session rejected outright. Too heavy for weak laptops and users. v1 ships file workspace plus browser only, with the computer slot visibly disabled ("potato mode"). Background drivers or opt-in remote sandbox come later.

## Integrations
- Slack, Notion, Linear first, Jira second. One unified interface exposed over MCP so adding a tool never rewrites the agent. Known traps recorded: Notion's explicit share gating plus 3 req/s global limit plus webhooks that miss body edits, Slack's single-channel webhooks and invite requirement, Linear's HMAC plus 5-second webhook deadline. Zod validation and idempotency keys throughout.

## UI journey
- Started with three directions (neo-brutalist, Linear x Raycast, tactile studio) under the warm-glass, anti-slop brief. Rejected; user pointed at the T3 Code nightly screenshot instead.
- Rebuilt that layout close: top window bar, projects sidebar, center overview, bottom ask bar. Then stripped the warm amber theme to neutral black and white, keeping green and red only for diff counts as in the reference.
- Then emptied the center to the empty-state screenshot: "What should we build in explore?" plus one big input card with model, build, and access pills. Busy states only appear after work lands.
- Sidebar behavior locked: icon rail, trigger morphs to "<" on hover, click expands and collapses with animation.
- Icon rule locked: geometric and text glyphs only, never emoji.

## Where everything lives
- `/home/k5/code/k5-work`: `SPEC.md` (locks), `design-demos/` (spec, approved `k5-t3clone.html` mockup, direction record, screenshots), `docs/` (both research passes), `apps/` + `server/` + `shared/` (untouched early stubs).
- No app code written; discussion-only rule held except for design mockups explicitly requested.

## Open items
- Confirm the office call reads right (clean-room core, SuperDoc as backup).
- Approve the empty-state mockup or list what is off.
- Next artifact is a build plan; code starts only on sign-off.

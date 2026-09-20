# k5-work — project spec (locked)

Open-source Cowork-style web app. Thin-slice MVP, harness-agnostic, potato-friendly.

## Locked decisions
1. **Platform:** web app first. TypeScript full-stack.
2. **Models:** via ACP bindings to open-source harnesses. Seats: OpenCode, Kilo Code, Cline. One stable service interface, thin per-harness plugs (spawn + protocol translate only, no business logic in plugs).
3. **Office docs:** custom `k5-ooxml-core` (ZIP + rels + content-types + ID allocator + validator) with thin docx/xlsx/pptx on top, JSON-in/engine-out, create-only first. SuperDoc as reference and optional docx driver behind the same interface, never hardcoded. Repair-dialog CI gate on every fixture.
4. **Browser use:** no custom loop. Built-in browser driven via MCP (Playwright MCP for flows + Chrome DevTools MCP for debug), isolated profiles, domain allowlist, evidence-based asserts, step budget.
5. **Computer use:** no custom grounder. v1 ships WITHOUT full desktop (file workspace + browser only); slot shown disabled ("potato mode"). Later via open background drivers (Cua) behind one MCP service. No Docker-per-session, ever, for local.
6. **Integrations:** Slack, Notion, Linear (+Jira second pass) behind one unified interface / MCP layer. Zod-validated LLM glue, idempotency keys, schema-drift alerts.
7. **Capability order:** connectors first, browser second, screen last.

## UI (locked reference: T3 Code nightly screenshot 2)
- Layout mirrors reference: top window bar, left projects sidebar, center overview/empty hero, bottom ask bar with model/access pills.
- Default state is EMPTY: centered "What should we build in {project}?" + big input card. Busy states (summaries, changed files) appear only after work lands.
- Sidebar: icon rail by default; trigger morphs to "<" on hover; click expands to full panel / collapses back with width animation.
- Theme: neutral black and white (no warm tint, no blue-purple glow). Green/red reserved for diff counts only, as in reference.
- Icons: geometric/text glyphs only. Never emoji. Locked rule.
- No copied proprietary assets. CSS-only marks.

## Files
- `apps/web/` — current UI (copied verbatim from `~/Downloads/k5work.zip`)
- `docs/` — implementation research v1 + v2 (ACP, sandbox, browser, office, integrations, plug framework)

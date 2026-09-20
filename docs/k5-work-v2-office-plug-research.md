# Implementation Research v2: custom office libs + harness-agnostic plug framework + MCP browser + open computer-use

## The Task
User wants: (a) build own office-file libs from scratch ("fuck it" dance), (b) NOT build browser/computer use from scratch — browser ok if built-in browser driven via MCP tools, computer use has no expertise, Codex computer-use is closed, (c) harness-agnostic with plug-and-play framework: one service interface, minimal per-harness plugs. Web app, TypeScript.

## 1. Custom office libs — what it really costs
- OOXML is a ZIP of 15-40 XML parts with global consistency: `[Content_Types].xml` must declare every part, `_rels/*.rels` must map every rId, element order must match XSD, IDs unique per scope, charts embed a full .xlsx whose cell ranges must match chart XML. Source: dev.to/jakexkim why-AI-pptx-repairs 2026-07-16; ooxml.dev creating-documents + common-gotchas (SuperDoc team).
- Even Microsoft's own OpenXML SDK shipped repair-dialog bugs (issues #1226 element-order swap v2.11-2.18, #1955 blank file repairs, #1571 tables wipe content, #1948 video corrupts). If the Office team gets ordering/rels wrong, hand-rolled XML will too.
- Spec is 5000+ pages (ISO/IEC 29500-1/-2) with no rendering guidance; Word diverges from spec (e.g. `w:tblGrid` marked optional but Word crashes without it; `w:sectPr` must be last child of `w:body`). Source: ooxml.dev gotchas, ISO PDFs.
- The sane custom path is NOT raw XML strings: JSON-in → engine-out. AI/harness produces JSON (slides, rows, chart data); a single renderer owns rId assignment, content-types, namespaces, ZIP assembly (Deflate + central directory). Then "structurally valid JSON = opens without repair" becomes testable. Source: jakexkim repair article + PaperJSX pattern.
- Don't start from zero: SuperDoc (`superdoc/docx-editor`, AGPLv3, TS) already did the hard part for docx — OOXML-backed model, no HTML round-trip, same engine browser + headless + MCP server + Document API for agents. ooxml.dev (18k spec chunks + MCP at api.ooxml.dev/mcp) is built by same team. For xlsx/pptx there is no SuperDoc equivalent;-sheetjs/pptxgenjs own that niche. Recommendation: build `k5-ooxml-core` (ZIP + rels + content-types + ID allocator + validator) once, then thin `k5-docx/k5-xlsx/k5-pptx` on top, and steal SuperDoc's operation-contract idea (agents call ops, never raw XML).
- Effort truth: docx paragraphs/tables = weeks; styles/numbering/headers/footers/comments/tracked-changes = months; pptx masters/layouts/themes/embeddings = months; xlsx styles/formulas/pivots = months. Start with create-only subset (the Cowork deliverables: formatted doc, spreadsheet with working formulas, deck with tables/charts/images) and add a repair-dialog CI gate (open every fixture in LibreOffice + OOXML Validator + Windows PowerPoint if you can).

## 2. Browser via MCP — yes, don't build your own
- Two official MCP servers cover it: `microsoft/playwright-mcp` (cross-browser, agent-shaped AI snapshot with refs + iframe stitching + diffs) and `ChromeDevTools/chrome-devtools-mcp` (Chrome-only, DevTools-native: console, network, traces, Lighthouse, heap). Both speak stdio MCP, both work with any MCP client. Sources: playwright.dev getting-started-mcp, ChromeDevTools repo, devflares 2026-06-01, vibebrowser 2026-03-16 comparison.
- Pattern that works (proven with Codex CLI): Playwright MCP drives flows, Chrome DevTools MCP debugs failures. Config is two lines: `codex mcp add playwright -- npx @playwright/mcp@latest --headless --isolated`. Project-level `.codex/config.toml` or equivalent. Source: codex.danielvaughan.com 2026-04-23.
- Token note: `@playwright/cli` + skills uses ~27k vs ~114k tokens for same task as MCP workflow (4x). So: MCP for interactive reasoning, CLI for repeatable flows. k5-work built-in browser = Playwright MCP in `--isolated` + storage-state persistence, with `--headless` in sandbox and headed + extension bridge locally for logged-in sessions.
- Gotchas: Playwright MCP default profile is NOT your Chrome profile (logins need explicit storage-state or extension bridge, and that bridge is flaky); Chrome DevTools MCP needs real Chrome stable (not Chromium/Edge); `browser_run_code_unsafe` is RCE — gate it to trusted harnesses only.

## 3. Computer use without expertise — buy, don't build
- Codex computer-use (closed) and Claude Cowork VM are background-lane systems: separate cursor/focus, AX tree + screenshots, post-action state. Open equivalents exist and speak MCP already:
  - `trycua/cua` (MIT, 22k stars): drivers for macOS/Windows/Linux over MCP/CLI + Sandbox SDK (`Sandbox.ephemeral(Image.linux())`, screenshot/mouse/keyboard/shell) + Lume VMs + bench. This is the closest to "just add computer-use".
  - `open-codex-computer-use` / `OpenCodexLabs/open-codex-computer-use` (Swift, macOS AX, virtual cursor, 9-tool MCP surface, Codex plugin scaffold) — explicitly built as open Codex-style layer.
  - Benchmark reality: OSWorld (369 tasks, best model 12% vs human 72%) and OSWorld 2.0 (108 long-horizon tasks, Claude Cowork/Codex/OpenClaw as reference agents). Grounding + ops knowledge is the hard part; don't hand-roll.
- Recommendation: k5-work exposes ONE `computer` MCP service backed by Cua driver/sandbox. No custom grounder in MVP. Human-approval gate for destructive/egress actions stays in k5-work, not in driver.

## 4. Plug-and-play harness framework
- Shape: `k5-service` = stable interface (chat/prompt streaming, tool-call routing, permission prompts, session new/load/resume/close, file/workspace ops, browser/computer/office/integration tools). Each harness gets a thin `k5-plug-<name>` (opencode, goose, gemini-cli, codex-cli, cline) that translates service↔harness wire (ACP JSON-RPC over stdio for ACP harnesses, MCP stdio for MCP harnesses). Services never import harness SDKs directly.
- Why this works now: ACP SDKs exist in TS/Rust/Python/Java/Kotlin (protocol v1), MCP TS/Python SDKs are stable, and harnesses already expose one or both (`opencode acp`, `goose acp`, `gemini cli` ACP ref impl, Codex CLI MCP config). Zed proved the pattern: one client, many agents, registry + custom `{command, args:["acp"], env}`.
- Rules to keep plugs minimal: service owns permission policy (AllowOnce/Thread/Always/Deny), tool schemas (Zod), audit log, and timeouts/retries; plug owns only spawn + protocol translate + capability advertise (`supports: {streaming, toolCalls, permissions, sessions}`). No business logic in plugs. Contract-test each plug against a fake service (record/replay JSON-RPC).
- Transport caveat: ACP today is stdio-only; remote needs stable transport (open problem). Keep plugs local-stdio in MVP; add WS/SSE later without changing service interface.

## Recommendation
Say yes to custom office core but scope it: `k5-ooxml-core` + create-only docx/xlsx/pptx via JSON→engine, with repair-gate CI, and lean on SuperDoc for docx editing interop rather than rewriting tables/numbering from zero. Say no to custom browser/computer loops: ship built-in browser as Playwright MCP (+ DevTools MCP for debug) and computer as Cua driver/sandbox behind one MCP service. Build the plug framework first (service interface + opencode plug + fake-harness tests), because it makes every later harness ~50 lines of translate code.

## Sources
- https://ooxml.dev/docs/creating-documents/ ; https://ooxml.dev/docs/common-gotchas/ ; https://ooxml.dev/spec/ ; ISO/IEC 29500-1/-2 PDFs ; https://dev.to/jakexkim/why-ai-generated-pptx-triggers-the-repair-dialog-5glh
- https://www.superdoc.dev/ ; https://github.com/superdoc/docx-editor/ ; https://docs.superdoc.dev/
- https://playwright.dev/docs/getting-started-mcp ; https://github.com/microsoft/playwright-mcp ; https://github.com/ChromeDevTools/chrome-devtools-mcp ; https://www.devflares.com/blogs/playwright-mcp-vs-chrome-devtools-mcp ; https://www.vibebrowser.app/blog/mcp-browser-automation-comparison ; https://codex.danielvaughan.com/2026/04/24/browser-in-the-loop-testing-playwright-chrome-devtools-mcp-codex-cli/
- https://github.com/trycua/cua ; https://cua.ai/docs ; https://github.com/RichardZhong/open-codex-computer-use ; https://github.com/OpenCodexLabs/open-codex-computer-use ; https://github.com/xlang-ai/OSWorld ; https://github.com/xlang-ai/OSWorld-V2 ; https://arxiv.org/html/2606.29537
- ACP: https://github.com/zed-industries/agent-client-protocol/ ; https://zed.dev/blog/bring-your-own-agent-to-zed ; https://www.danilchenko.dev/posts/agent-client-protocol/

## Adversarial Verification
- Sources verified: ooxml.dev pages fetched live; SDK issue numbers (#1226/#1955/#1571/#1948) appear in jakexkim article with version ranges; SuperDoc AGPLv3 + MCP claims cross-checked docs.superdoc.dev vs github README; Playwright vs DevTools MCP split cross-checked across 3 comparisons (devflares, vibebrowser code review, danielvaughan); Cua MIT + stars + Sandbox API cross-checked github vs cua.ai docs vs pypi; OSWorld numbers (369 tasks, 72% vs 12%) from osworld-v1 page.
- Numbers checked: 15-40 parts per pptx, 5000+ spec pages, 18k spec chunks, 27k vs 114k tokens, 22k Cua stars — each in cited source.
- Logic: JSON→engine follows from forward-reference problem; buy-don't-build computer follows from OSWorld grounding gap + existing MCP drivers; plug framework follows from ACP/MCP stdio reality.
- Omissions: xlsx formula calc-chain + pptx animation coverage not deep-dived; Windows-HCS sandbox path noted only; Jira still thin.
- Status: GREEN (with xlsx/pptx edit-existing scope explicitly deferred)

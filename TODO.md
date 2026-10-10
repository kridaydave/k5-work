# k5-work TODO — core basics

- [x] A: `shared/` types (smallest, defines everything else)
  - `shared/src/` session, prompt, tool-call, permission, event, connector types (Zod at boundaries)
  - `shared/src/contracts.ts` — the `/ws` command/event union, the single browser wire contract
  - `shared/src/access.ts` — access profiles, capability vocabulary, `SERVABLE_PROFILES`
  - `shared/src/reducer.ts` — pure browser view state and delta coalescing
- [x] B: service interface TS signature
  - stable `k5-service`: chat/prompt streaming, session new/load/resume/close, tool routing, permissions, audit, timeouts
- [x] C: plug contract test against real ACP wire shapes
  - plug emits real `session/prompt` content blocks; `FakeHarness` record/replay
    (which spoke a guessed protocol and could not fail on drift) replaced by
    `RecordingAcpTransport`; research (cdres): `CD_res/implementation/acp-web-ui/acp-web-ui-research.md`
- [x] D: ooxml-core minimal ZIP + validator
  - ZIP + `[Content_Types].xml` + `_rels` + rId allocator + validator, JSON-in/engine-out, create-only first
  - Research (cdres, GREEN): `CD_res/implementation/ooxml-core/ooxml-core-research.md` (consolidated) + `CD_res/implementation/ooxml-core/ooxml-zip-engine-research.md` (ZIP/XML engine deep-dive)
  - Location decided: `server/src/ooxml-core`. License: MIT core, permissive deps only (no GPL/AGPL in core).
  - [x] D-1 + D-2 (single PR): foundation + XmlBuilder + shared schemas (`fflate` dep, `xml.ts`/`errors.ts`, `OoxmlPart/PackageSpec` Zod in `shared`, `xml.test.ts`) + ContentTypes table + RelIds allocator (per-scope rIds, Default/Override ownership, target resolution)
  - [x] D-3: ZipWriter + PackageBuilder create-only (methods {0,8}, bit3=0, bit11=1, pinned mtime, deterministic order)
  - [x] D-4: Validator write-time + post-hoc (coded spec/heuristic checks, corrupt-fixture tests)
  - [x] D-5: minimal docx proof fixture + LibreOffice repair gate + mark D done

## ACP integration (phases 0-3 delivered)

Research: `CD_res/implementation/acp-web-ui/acp-web-ui-research.md`.
Locked decisions: `docs/posture-and-trust-decisions.md`.

- [x] Phase 0 — real ACP probe
  - argv-based `ACP_COMMAND` loader, Node→WHATWG bridge, captured-child teardown
  - `initialize` → `authenticate` → `session/new` against OpenCode 1.18.31
  - Proof: `npm run probe -w server`; deterministic cases use `fake-agent.ts`;
    real-harness tests skip loudly, never mock a pass
- [x] Phase 1 — runtime and dev routing
  - Node server owns `/api` and `/ws`; Vite is a dev proxy only
  - `Host` allowlist (421) defeats DNS rebinding; loopback names always allowed
  - ordered shutdown: gateway → seats → listener, with a non-zero exit on a stall
- [x] Phase 2 — contracts and gateway
  - `shared/src/contracts.ts` wire union; `ws` gateway with origin validation,
    payload/queue/rate/socket bounds, overflow closes with a typed reason
  - seat pool with provisional reservation, cap, idle TTL, provisional sweep
  - fails-closed posture verification; plugin-bearing projects refused by name
  - all 16 pinned `SessionUpdate` variants explicitly classified
- [x] Phase 3 — replace the simulation
  - `useK5Socket` + shared reducer; real streamed turns from a live seat
  - one-turn queue so a submission is never silently dropped
  - paperclip and drag-and-drop honestly disabled (no out-of-band transport yet)
  - sidebar pill reports the real connection state

## Added after Phase 3

- [x] Model and session-mode discovery: the composer menu is populated from the
      harness's advertised `configOptions`, applied via `session/set_config_option`,
      and refuses any value the harness never offered. No hardcoded vendor list.
- [x] Browser test runner (`vitest` + `jsdom`) with a suite for the socket hook
      and the sidebar.
- [x] `session/request_permission` refused rather than ignored: the seat answers
      the ACP `cancelled` outcome immediately. There is no permission screen —
      OpenCode 1.18.31 resolves `*: allow` and never asks, so a prompt would be
      unreachable UI. The handler still has to exist, because an unanswered
      request leaves the harness blocked for the rest of the turn. A test asserts
      both halves: the turn still ends, and the refusal is never reported to the
      harness as consent.
- [x] Seat idle TTL scheduled: the countdown is armed when a turn ends, cleared
      on any further activity, and reaps the harness child on expiry.
- [x] Sidebar no longer fabricates sessions; it takes real sessions and says
      "No tasks yet." instead of showing the original build's placeholders.
- [x] Configure failures are scoped to the command that caused them, so a
      refused model change can no longer kill a working turn.

- [x] Phase 4 — durable transcripts
  - The session store (`<root>/k5.db`, SQLite). k5 owns the transcript: every event
    it forwards is written to an append-only `events` table and read back from
    there, so a reload shows the conversation that actually happened. A pre-SQLite
    store is imported once at first open and then left alone.
  - Sidebar lists stored tasks from the store over HTTP, with a remove action, and
    rehydrates a transcript after a reconnect and on continuation.
  - `storeId` is the only addressable identity for history. The harness's own
    session id is opaque and harness-controlled, so it never appears on the wire.
  - `session.resume` continues a stored task behind a capability gate and a
    stored-cwd check; the harness's `session/load` replay is deliberately not
    drained, because ACP has no replay terminator.
  - Out-of-band attachments: bytes and the manifest that describes them are one
    row, so they cannot disagree.
  - Component-level coverage for the composer, tool cards, attachments and the
    stored-session read path.

- [x] Transcript search, so a stored task is findable by what it said
  - `GET /api/sessions?q=...` on the existing route, same response shape, with
    `snippets` present only on a row that came back from a search
  - The store narrows candidates with a LIKE over `events.payload` before
    reading any transcript, and escapes `%` and `_`
  - Snippets come from prompts and replies only, matched per record so each one
    names the sequence it came from, capped at three per session
  - Tool calls are deliberately not searched: "which task read this file" is a
    different question from "which task was about this"
  - The sidebar renders the matched line with the side that said it, debounced
    on its way out of the component

## Not done

- [ ] Phase 5 — discovery and policy
  - A permission screen, if a harness ever asks. It needs the wire contract, the
    reducer state and the browser decision path back; today the refusal is
    unconditional.

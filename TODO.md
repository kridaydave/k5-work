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
- [x] Browser test runner (`vitest` + `jsdom`) with a suite for the socket hook.

## Not done

- [ ] Phase 4 — policy and persistence
  - Permission UI and the `session/request_permission` handler. The plumbing and
    contracts exist and are tested, but OpenCode 1.18.31 resolves `*: allow` and
    never asks, so the UI would be unreachable with the current harness.
  - `session/load`, `session/list`, `session/resume` behind their capability
    gates with stored-cwd validation.
  - Out-of-band attachments, then durable transcripts and bounded replay.
  - Sidebar session list still shows the original build's placeholders; it needs
    real session history, and until then selecting one deliberately does nothing.
  - Only the socket hook has a browser test. Component-level coverage for the
    transcript, tool cards, and permission card is still to come.
  - Seat idle TTL is wired in the pool but nothing schedules the reaper yet.

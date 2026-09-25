# Implementation Research: Wiring ACP into the k5-work Web UI

**Date:** 2026-09-25
**Scope:** research only; no product code changed
**Decision:** implementation fixes are deliberately deferred to the implementation phase; this artifact records findings, constraints, and open decisions rather than applying them now.
**Verified environment:** Node `v26.7.0`, npm `12.0.2`, Vite `7.3.2`, OpenCode `1.18.31`; CI targets Node 22.
**Protocol target:** ACP v1. The plan is written against `@agentclientprotocol/sdk` `1.5.0` and must be rechecked when that pin changes.

## Executive decision

Do not connect React directly to the existing `K5Plug`. It is a guessed translation layer, and the running server never starts it.

Use a k5-owned browser protocol in front of a real ACP client:

```text
Browser (native WebSocket)
        │  same-origin /ws, k5 Zod commands and events
        ▼
Node gateway + K5Service
        │  sessions, policy, permissions, audit, event fan-out
        ▼
ACP plug / seat: captured child process
        │  JSON-RPC 2.0, newline-delimited stdin/stdout
        ▼
opencode acp
```

The build order matters:

1. **Prove ACP headlessly before designing the browser contract.** A real `initialize` → `session/new` → shutdown probe should fail before any WebSocket code exists.
2. **Move dev routing to the Node server before adding WebSockets.** The current Vite plugin handles `/api` in-process; `server.proxy` alone would never see those requests.
3. **Key the first seat by `(harness, canonical project, access profile)`.** OpenCode loads each session directory's configuration, plugins, agents, skills, and MCP configuration. Do not multiplex sessions or reuse a seat across projects until isolation is tested.
4. **Treat OpenCode configuration as the permission boundary, with verification.** ACP permission requests are the UI surface; OpenCode's merged configuration, agent rules, and project plugins decide what actually asks, allows, or denies. A k5 dropdown is not enforcement by itself.
5. **Preserve the locked UI.** Replace the simulation around `App.handleSend`; do not redesign Composer, sidebar, or window chrome without explicit approval.

## 1. Repository seams

- `PromptSubmission` is defined at `apps/web/src/components/Composer.tsx:55-60` and emitted at `Composer.tsx:126-140`.
- `App.handleSend` is the main simulated reply path at `apps/web/src/App.tsx:132-168`; `handleSelectSession` also fabricates a transcript at `App.tsx:170-182`.
- `App` has no socket, K5 session ID, turn ID, or connection state. `sessionKey` at `App.tsx:46` is only a composer remount counter used at `App.tsx:291`.
- The server imports the project API at `server/src/index.ts:5`, handles HTTP at `index.ts:31-44`, and has no WebSocket upgrade handler. It does not import the service or plug.
- The current plug emits a guessed `{text, model, access}` prompt at `server/src/acp/plug.ts:42-53` and reads a non-ACP `params.text`/`params.seq` shape at `plug.ts:55-69`.
- `Event` is the plug/service stream contract at `shared/src/index.ts:74-80`; `Audit` is separate at `shared/src/index.ts:58-68`. `Event.payload: unknown` cannot describe a live turn.
- `useProjects` merges browser `localStorage` projects with discovery at `apps/web/src/hooks/useProjects.ts:47-54`, so the browser can present an ID the server never issued.
- The Vite plugin mounts the project API directly in dev and preview at `apps/web/vite.config.ts:13-37`.
- `.env.example:1-2` already declares `ACP_COMMAND`, but no source consumes it and the repository does not load `.env` automatically.
- `server/package.json:11` runs an explicit list of compiled test files. New tests do not run until that list changes; `shared/package.json:10` uses a depth-one glob that omits nested tests.

## 2. Verified ACP behavior

ACP v1 is JSON-RPC 2.0 over UTF-8, newline-delimited stdio. Messages cannot contain embedded newlines, stdout is reserved for protocol traffic, and stderr is for logs.
Source: [ACP v1 transports](https://agentclientprotocol.com/protocol/v1/transports).

The turn is:

1. `initialize` with `protocolVersion: 1`, honest client capabilities, and client info.
2. `authenticate` only if the selected auth flow requires it.
3. `session/new` with an absolute `cwd` and `mcpServers` (which may be `[]`); the agent returns the ACP `sessionId`.
4. `session/prompt` with `{sessionId, prompt: ContentBlock[]}`; the request remains open for the turn.
5. `session/update` notifications for messages, tools, plans, usage, and session state.
6. Agent-to-client requests such as permission, filesystem, terminal, elicitation, and MCP-related calls.
7. `session/cancel`, a notification with no response.
8. The original `session/prompt` response with `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, or `cancelled`.

Sources: [overview](https://agentclientprotocol.com/protocol/v1/overview), [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls), [cancellation](https://agentclientprotocol.com/protocol/v1/cancellation).

Capability rules are field-specific:

- `session/load` is gated by top-level `agentCapabilities.loadSession`, not `sessionCapabilities`.
- `session/list`, `resume`, `close`, `delete`, and `additionalDirectories` are read from `agentCapabilities.sessionCapabilities.{list,resume,close,delete,additionalDirectories}` in the pinned schema; do not infer them from presence alone.
- `session/set_config_option` is not behind a session capability. It is callable when the pinned SDK exposes the method, but a `select` value must be one of the values in that option's advertised `options` array; boolean values additionally require advertising `clientCapabilities.session.configOptions.boolean`. The local OpenCode response returned `configOptions` with no legacy `modes` field, so use config options rather than building against `session/set_mode`.
- `session/fork` is marked unstable in the pinned SDK and is not a k5 dependency.
- Optional content and client capabilities must not be advertised unless k5 implements them. Some `SessionUpdate` variants, including notice and compaction updates, are themselves client-capability-gated in the pinned schema; k5 must not advertise them until it can render them.

Sources: [session list](https://agentclientprotocol.com/protocol/v1/session-list), [session config options](https://agentclientprotocol.com/protocol/v1/session-config-options), [session modes](https://agentclientprotocol.com/protocol/v1/session-modes).

### Local OpenCode 1.18.31 probe

A bounded local probe sent `initialize`, awaited the response, then sent `session/new` for a temporary directory and awaited that response before closing stdin. It exited cleanly.

`initialize` returned protocol version 1 and advertised `loadSession`, image/embedded-context prompts, HTTP/SSE MCP (the pinned schema also has an `acp` MCP capability field), and session `close`, `fork`, `list`, and `resume`. It did not advertise `delete`; k5 must probe the actual response and not call `session/delete` based on vendor prose. It also returned an `opencode-login` auth method. The response advertises SSE even though OpenCode's ACP documentation says MCP over SSE and MCP over ACP are not supported by this command, so capability values must still be probed rather than blindly trusted.

The returned `opencode-login` auth method has no `type` field, so ACP treats it as the default **agent** auth method: the agent handles authentication through `authenticate`. k5 must branch on the `type` discriminator rather than hardcoding this one vendor shape; a future `type: "terminal"` method must not be passed to `authenticate` and requires a separate approved terminal-auth design. A live probe of `authenticate {methodId: "opencode-login"}` returned an empty success result; it does not collect credentials. Leave `clientCapabilities.auth.terminal` unadvertised, and map an authentication error (`-32000`, Authentication required) to `command.result { reason: "auth-required" }`. Because this OpenCode build may report provider-auth failure later at `session/prompt` rather than at `authenticate`, preserve that error as a typed turn failure too.

`session/new` returned a distinct ACP session ID plus two observed `configOptions`:

- `model`: a select list of `provider/model` values.
- `mode`: `build` versus `plan`; this selects an OpenCode agent. The current documentation describes Plan as `ask` for edits/bash, but the installed 1.18.31 resolver reports `edit: deny` for most paths (with narrow plan-file exceptions) and no bash rule, so bash falls through to the permissive wildcard. Treat the resolver output for the pinned binary as authoritative; do not use Plan as a safe no-ask profile.

OpenCode's ACP documentation also says an `Effort` option appears when the selected model provides variants. The probed model did not expose one, so the absence of a thinking/effort option is model-conditional, not a permanent protocol fact. Re-probe after changing the model.

Source: [OpenCode ACP](https://opencode.ai/v2/docs/cli/acp), [OpenCode agents](https://opencode.ai/docs/agents/).

### SDK API

Use the stable SDK entry point only. ACP v2 remains under `experimental/v2` and must stay out of the critical path.

The documented path is:

```text
child stdin/stdout
  → acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  → acp.client({name}).onRequest(...).connectWith(...)
  → ctx.buildSession(cwd).withSession(...)
  → session.prompt(...) and session.nextUpdate()
  → nextUpdate() {kind: "stop", response} carries stopReason
```

The stream accepts WHATWG byte streams, not Node `Duplex` objects. Use the SDK's request/response correlation rather than hand-rolling a second JSON-RPC ID map. The SDK applies generated Zod validation to ACP messages; k5 still owns validation of its own browser contract and must explicitly log unsupported/unknown ACP variants rather than silently dropping them. The SDK has a Zod peer dependency (`^3.25.0 || ^4.0.0`), so the server's `zod` range must satisfy it and the root lockfile must be regenerated. The k5 layer needs its own event broker for browser fan-out, cancellation, and subscribers.

Sources: [SDK README](https://github.com/agentclientprotocol/typescript-sdk), [example client](https://raw.githubusercontent.com/agentclientprotocol/typescript-sdk/main/src/examples/client.ts) (verify against the installed `1.5.0` package when the pin changes), [npm package](https://www.npmjs.com/package/@agentclientprotocol/sdk).

## 3. Client method and update surfaces

Do not maintain a hand-written partial method list. Generate or verify the handler table from SDK `1.5.0`. The SDK already returns protocol errors for unsupported requests and validates known shapes; k5 must add an audit/log record for every rejected or unsupported inbound method.

`$/cancel_request` is special. The SDK exposes the inbound request's abort signal to the handler; k5 must stop the work through that signal and let the SDK's cancellation path produce the protocol result rather than hand-rolling a second abort mechanism. Use this method-keyed table; do not apply one blanket response to every cancelled request:

| Trigger | Pending request | Wire response | k5 event |
|---|---|---|---|
| k5 `session/cancel` | `session/request_permission` | `{ outcome: { outcome: "cancelled" } }` | `permission.resolved { reason: "cancelled" }` |
| k5 permission timeout, no-UI fallback, tab close, outbound overflow, child failure, seat reap, or turn timeout | `session/request_permission` | first send `session/cancel` when the seat is still alive, then `{ outcome: { outcome: "cancelled" } }` | `permission.resolved` with the specific reason |
| agent cascade `$/cancel_request` for a pending request, including a permission request | the agent→client request ID named by the agent's notification | JSON-RPC error `-32800` | `permission.resolved { reason: "protocol-cancelled" }` for a permission request, otherwise scoped `error`/audit |
| other internal cancellation of an agent→client request | that request's ID | JSON-RPC error `-32800` | scoped `error`/audit as appropriate |

Row 3 is an inbound agent notification; k5 does not send `$/cancel_request` for a permission it received. k5's own prompt cancellation is the `session/cancel` row. Notifications such as `elicitation/complete` never receive a response. A late `permission.decide` for a terminal request is rejected locally and never sent to the agent. The permission record is single-use. For a dead/closed child there is no live request left to answer; the pending permission becomes a local/audit terminal state. For a live seat, timeout/no-UI/overflow must send `session/cancel` before the cancelled permission outcome, because answering a permission alone does not cancel the turn. If the browser socket is already closed (overflow/socket close), the `permission.resolved` record is audit/local state; the close code/reason is the browser's authoritative signal, not a second event.

Notable agent-to-client surfaces include permission, filesystem, terminal, elicitation, MCP connect/message/disconnect, and protocol cancellation. `elicitation/create` has a scope union: a request-scoped elicitation carries `requestId`, while a session-scoped one carries `sessionId` and optional `toolCallId`. It is therefore not always attributable to a session, which is a reason not to enable it while sharing a seat. If k5 does not advertise an elicitation mode, k5's registered handler (or an explicit protocol error path) must return `-32602`; the SDK is not assumed to synthesize that policy.

Unstable surfaces (`session/fork`, the `plan` client capability, and the unstable plan-update variants) are quarantined: an OpenCode advertisement alone does not pull k5 into them. They require an explicit feature decision and separate tests. The pinned `SessionUpdate` schema has more variants than the short documentation table. Enumerate the generated schema, not the prose table, and classify every variant as rendered, safely ignored, or rejected. The set includes message/thought chunks, tool calls/updates, plan creation/update/removal, available commands, current mode, config options, session info, usage, notice, and compaction updates/summary chunks. Notice and compaction variants must not be advertised until k5 implements the required client capabilities; plan update/removal notifications are also capability-gated in the pinned schema. If the agent sends a gated variant anyway, k5 must suppress and log it rather than relying on the SDK to filter it. `available_commands_update` can contain a large command/skill inventory and must be bounded rather than forwarded verbatim; text-bearing compaction updates cannot be silently dropped if their capability is advertised.

## 4. Dev and runtime topology

### One Node owner, Vite proxy only

The Vite change must be atomic:

- Remove `projectDiscoveryPlugin` and its now-unused imports.
- Add `server.proxy` and `preview.proxy` rules for `/api` and `/ws`.
- Set `ws: true` for `/ws` and leave `rewriteWsOrigin` unset so the Node gateway sees the browser's original `Origin`.
- Use exactly `K5_SERVER_ORIGIN` for the proxy target, `K5_ALLOWED_ORIGINS` for the gateway's browser-origin allowlist, and `K5_PREVIEW_ORIGIN` for the single preview origin. The documented dev allowlist must include both `http://127.0.0.1:5173` and `http://localhost:5173`, plus `K5_PREVIEW_ORIGIN`; the CI positive test must use one of those exact values. Keep the existing `PORT`, `HOST`, and `ALLOW_REMOTE` names unchanged; the new variables only describe proxy/origin policy. Vite must not contain a fallback `localhost:8787` literal.
- Make fail-fast validation apply only to `vite serve`/`vite preview`, not `vite build`, or the current CI build step will fail before a server is needed.
- Because the repository does not load `.env` automatically, use a guarded env-file mechanism in the root dev command and explicit `loadEnv`/`process.env` access in the Vite config. Prefer inherited `process.env` after the root guard; if using Vite `loadEnv`, set an explicit repository-root `envDir` because the default is `apps/web`. If the mechanism is `node --env-file-if-exists`, declare Node `>=22.9.0` in `engines` and pin CI accordingly. The guarded load must run before `concurrently` spawns both process trees, or the server and Vite can silently read different environments. A bare `cp .env.example .env` must continue to produce a working documented dev command. CI should set the same variables inline or use a guarded env-file flag; it must not abort merely because `.env` is absent.
- Update the root dev command, `.env.example`, README quickstart, and CI dev-smoke environment together. The existing `5173/api/projects` CI assertion now depends on the Node server. Add a config test that every required variable (`ACP_COMMAND`, `K5_SERVER_ORIGIN`, `K5_ALLOWED_ORIGINS`, `K5_PREVIEW_ORIGIN`, `PORT`, `HOST`, `ALLOW_REMOTE`) appears in the documented env contract and that the origin's host/port agree with the server bind variables; `K5_DISABLE_LIVE_SEATS` is an optional emergency kill switch that makes the server refuse seat creation without removing the rest of the gateway. This is a documentation/config-presence test, not a runtime requirement for lazy seat creation. Set the new variables in the remote-bind CI step too, and order validation so the existing `HOST`/`ALLOW_REMOTE` error is produced before any optional allowlist error. Remove or explicitly deprecate all currently dead `.env.example` keys (`WORKSPACE_DIR`, `MODEL_*`, and connector credentials) so the contract does not advertise behavior that does not exist.
- CI's positive WebSocket test must use the `ws` client with an explicit allowed `Origin` header. `curl` and Node's global WebSocket client are not adequate for this assertion.

This intentionally makes project discovery depend on the Node server in dev. The trade is worth it: one process owns sessions, projects, permissions, and shutdown.

Vite 7 documents `server.proxy`, WebSocket proxying, and the origin-check warning. Source: [Vite 7 server options](https://v7.vite.dev/config/server-options).

### WebSocket gateway

Use one WebSocket per browser tab as the first model, with a server-side session-ownership map. In the first slice, allow one active K5 session and one active turn per seat; a second concurrent session gets `command.result { reason: "seat-busy" }` and a retry path. Session multiplexing is a later isolation test, not an assumption.

Required bounds and reverse states:

- `maxPayload` sized for the text-only first slice; a reasonable starting value is 64 KiB. Reject binary frames explicitly. Attachments never travel in these frames.
- `perMessageDeflate: false` initially.
- Per-connection command rate limit and a small concurrent-socket cap.
- Provisional reservations count against the same seat cap as active seats; a spawn in `initialize` is not a free slot. The plug owns one table with provisional/active states.
- Bounded outbound queue; suggested starting bound is 1 MiB or 256 frames. On overflow, do not drop a delta or permission request. Close with a typed reason, cancel the active turn, and cancel pending permissions.
- Bound harness→gateway NDJSON line length as well. A framing/JSON/decode failure gets a counted log and a typed seat failure; do not skip an invalid stdout line forever.
- `connection.closed`, `session.closed`, `seat.reaped`, `permission.resolved`, and scoped `error` events so every open path has a visible reverse state. Seat-cap, TTL, slow-consumer, and shutdown paths must emit one of these rather than leaving a dead session looking live.
- If a tab closes mid-turn, cancel the turn, answer pending permissions, call ACP `session/close` when `sessionCapabilities.close` is advertised, and release the seat. If close is unavailable or fails, mark the seat poisoned, terminate its captured child, remove the key only after the child is reaped, and emit `seat.reaped`.
- Turn timeout and cancel watchdog must mark the turn closed before emitting a synthetic terminal event; a late prompt response is then dropped by turn ID, so the exactly-once terminal guarantee survives a watchdog race.

Origin validation belongs in the Node upgrade handler from the first runtime milestone. Use an explicit environment-driven allowlist for dev and preview origins; reject `Origin: null`, missing browser `Origin`, and unlisted origins. Do not rely on `Host`. A missing `K5_ALLOWED_ORIGINS` value is a fail-fast configuration error in serve/preview, never a silent deny-all. The server factory should accept the allowlist as an injected option so deterministic tests do not mutate global environment state. The Vite proxy origin allowlist is separate from the gateway's list and must not be confused with it.

The v1 threat model trusts a single local user who may open any canonical local directory. `workspaceRoot` is a discovery seed, not a containment boundary, and `ProjectOpenRequestSchema` accepts any nonblank path string (`shared/src/index.ts:133-135`); the open endpoint canonicalizes it but does not enforce `workspaceRoot`. Project `opencode.json`, `.opencode/agents`, and `.opencode/plugins` are inside that trust boundary and can widen or execute behavior beyond an injected profile. Either require an explicit trusted-project confirmation for plugin-bearing projects or refuse them until a plugin policy exists. Keep remote binding disabled. `ALLOW_REMOTE=true` must not become a deployment mode: without authentication, project discovery plus ACP `cwd` would be a remote code-execution surface.

### Process and shutdown ownership

The plug owns child-process spawn, stdio framing, ACP protocol translation, and child-level teardown. The service owns K5 sessions, turns, permissions, audit, and timeouts. The pool key belongs in the plug; the session registry belongs in the service.

Child requirements:

- Parse `ACP_COMMAND` as argv, not a shell string. Missing `ACP_COMMAND` must be a typed error on first session creation, not an import-time crash. Use an isolated project/config fixture for permission profiles; do not rely on `OPENCODE_CONFIG_CONTENT`, and never mutate global `process.env` for a seat.
- Drain stderr continuously into a bounded ring buffer. An unread stderr pipe can block the harness mid-turn.
- Keep the captured child handle/PID. On non-Windows, use a dedicated process group when needed so harness grandchildren can be reaped without name/pattern matching. The same teardown must run on the `node --watch` restart path, not only on SIGINT/SIGTERM. The invariant is graceful reaping on signals; if the parent is hard-killed, the child's stdin closes and OpenCode's documented EOF behavior is the recovery path, but Node cannot prove cleanup of every grandchild. Document that limitation and never fall back to pattern-based killing.
- Graceful path: close stdin, await exit, then `SIGTERM` the captured group if needed, then `SIGKILL` after a bounded deadline. If the hard deadline fires, exit non-zero and report unreaped child PIDs. Under `node --watch`, that non-zero exit intentionally stops the dev supervisor; the log must name the orphan risk rather than silently continuing with a half-dead seat.
- Add a seat cap, per-project concurrency cap, and idle TTL. Suggested starting values for the local-first slice: at most 4 seats, one active session per seat, and a 10-minute idle TTL; every value must be a named constant with a seat-reaped test.

HTTP shutdown must not rely on `server.closeAllConnections()` for upgraded sockets; it does not close them. Terminate each `ws` client, close the `WebSocketServer`, close ACP stdin, wait for captured children, then call `server.close()`. Add a hard exit deadline. Register a deterministic signal policy with `process.on`, not only the current `process.once`: the first signal starts graceful teardown, a second signal escalates only against captured process groups, and the deadline exits non-zero with unreaped PIDs if graceful teardown stalls. The current `server.close(() => process.exit(0))` at `server/src/index.ts:53-57` can hang forever once a WebSocket exists.

## 5. Project and session identity

The deterministic project ID is `slug + sha256(canonicalPath)[0:8]` (`server/src/projects.ts:53-57`) and cannot be inverted. Build a server-side `Map<projectId, Project>` from discovery and explicit open-folder results. Reject duplicate IDs loudly, resolve and reserve the canonical project key before spawning, re-canonicalize again immediately before `session/new` (releasing/rekeying and retrying if the path changed), and reject unknown or stale localStorage IDs with `command.result { reason: "unknown-project" }`. Never accept a raw ACP `cwd` from the browser.

The plug-owned pool owns re-keying and retries when canonicalization changes; the service never mutates a seat key directly. A path change releases the provisional/active key, re-resolves the project, and retries at most once before returning `seat-cap`/`unknown-project`.

Keep the K5 session ID separate from the ACP session ID. A K5 record owns:

```text
k5SessionId → harness, projectId, accessProfile, acpSessionId, activeTurn, socket owner
```

Use ACP `session/list` when advertised to populate real titles/cwds; `session_info_update` is a possible live-title signal but was not observed in the pinned OpenCode build, so treat it as optional. For load/resume, the stored session directory is authoritative; reject a returned/stored cwd that does not match the registry path. Do not send `additionalDirectories` unless the capability and policy explicitly allow it. Otherwise use the K5 registry; never fabricate history as `App.tsx:170-182` does today.

## 6. Browser contract and access policy

Use strict, versioned Zod command/event schemas in `shared`. `session.configure` is a k5 command that maps to ACP `session/set_config_option` only for an option/value present in the gateway's `session.newSessionResponse.configOptions` snapshot, which k5 publishes as `session.opened`. It may change model/effort/mode, never the access profile while a seat is live; a between-turn attempt is rejected exactly like a mid-turn attempt. A `permissions` change returns `command.result { reason: "profile-change-not-allowed" }`; the Composer menu must be disabled or its change must start a new session after approval.

Suggested first commands:

- `session.open`
- `session.prompt`
- `session.configure` (validated model/mode/effort value applied after `session.opened`)
- `permission.decide` (includes a server-issued `permissionRequestId`)
- `session.cancel` (k5 command; the ACP `session/cancel` call it triggers is a notification with no JSON-RPC response)
- `session.close`

`connection.ready` is the first server event after the upgrade; there is no separate hello command in the first slice. Every command carries a k5 `commandId`. The server returns a `command.result` envelope for every delivered command that is accepted or rejected, including post-session rejections such as forged/replayed `permission.decide`; the client never waits forever on an optimistic bubble. The client treats every rejected `command.result` as a local failed command, with typed handling for `unknown-project` (re-select/prune stale project), `seat-busy`/`seat-cap` (retry or new project), `socket-cap`, `live-seats-disabled`, and the other reasons. For `session.cancel`, `command.result` acknowledges receipt/cancellation dispatch, while `turn.completed` remains the single terminal turn event. Transport-level failures (oversize, binary, or otherwise undeliverable frames) are represented by the WebSocket close code/reason, not by an impossible `command.result`; the client maps close codes 1003, 1008, 1009, 1011, 1013, 1006 (abnormal closure), and 1001 (going away) plus its own socket-open timeout to a local failed-prompt terminal state.

Suggested first events:

- `connection.ready` and `connection.closed`
- `command.result` (accepted/rejected, with a typed code, command ID, optional session/turn scope, and a reason such as `live-seats-disabled`, `profile-unavailable`, `profile-change-not-allowed`, `unknown-project`, `initialize-failed`, `protocol-mismatch`, `auth-required`, `session-new-failed`, `seat-cap`, `seat-busy`, `socket-cap`, `queue-full`, `forged-permission`, `replayed-permission`, or `unknown-option`)
- `session.opened` (includes the initial config-option snapshot), `session.closed`, and `seat.reaped` (with a reason from `closed|capacity|timeout|watchdog|child-failure|shutdown|provision-failed|path-changed` and optional affected session/turn scope; it has no session scope for a provisional pre-open failure)
- `turn.started` and `turn.completed` (both include `turnId`; completion includes ACP `stopReason` plus a k5 terminal cause such as `harness-stop`, `cancelled`, `watchdog`, `turn-timeout`, or `child-failure`)
- `message.delta`
- `thought.delta`
- `tool.updated` (ACP `status` is only `pending|in_progress|completed|failed`; k5 adds a separate `lifecycle: cancelled` field for client-side cancellation)
- `permission.requested` (includes `permissionRequestId` and advertised options) and `permission.resolved` (includes `reason: selected|cancelled|protocol-cancelled|timeout|no-ui|rejected|socket-closed|overflow|seat-reaped|child-failure|turn-timeout`)
- scoped `error`

A k5 `seq` may order events, but do not advertise replay until a bounded per-session buffer exists. Terminal events must be exactly once per turn; late **turn-scoped** updates after `turn.completed` are dropped by turn/message ID. Session-scoped updates such as `available_commands_update`, `config_option_update`, `current_mode_update`, `session_info_update`, and usage are not filtered by turn ID and may arrive outside a turn. The optimistic user bubble and ACP `user_message_chunk` need a dedupe rule. Use a k5 `clientMessageId` or ignore the echo for k5-originated prompts.

### Access profile

Do not silently redefine `Prompt.access` in this wiring change. It is intentionally opaque per harness and is locked by `shared/src/index.test.ts:20-38` and the plug/service tests. The browser sends the raw `submission.settings`; the server uses the shared adapter to derive the access profile and seat key, so the browser cannot choose a stronger posture by sending an arbitrary profile string. Always send the UI's `submission.settings.permissions` so the shared `"full"` default cannot silently elevate a user who selected `review`.

Keep these concepts separate:

```text
access profile:  an opaque k5 policy label used to choose/configure a seat
ACP decision:    { outcome: { outcome: "selected", optionId } }
              or { outcome: { outcome: "cancelled" } }
```

OpenCode's permission configuration is the enforcement source, but it is **merged**, not a complete replacement: later config wins only for conflicting keys, agent-specific rules override global rules, and project agents/plugins can widen or execute behavior. The child also inherits the user's global OpenCode configuration and plugins; a disposable project does not isolate those. ACP has no method that reports the merged permission map to the client, so k5 must verify it out of band with OpenCode's documented `opencode debug config`/`opencode debug agent` resolvers in the actual child environment (or an equivalent test-only probe). `--pure` disables external plugins but is not by itself a permission proof. Do not rely on `OPENCODE_CONFIG_CONTENT` as a permission channel: in the pinned 1.18.31 build, injecting a permission map through it caused provider-level failures, while a project `opencode.json` fixture produced real permission requests. Use an isolated project/config fixture and verify the resolved posture. If the resolved posture is weaker than the k5 profile, refuse to start the seat rather than claim enforcement. There is no verified `OPENCODE_PERMISSION` variable.

Because a single process-level posture cannot safely provide different policies to concurrent sessions, key the first seat by access profile and **do not expose `allow_always` in the first slice**. OpenCode documents an “always” grant as lasting for the current OpenCode session; its lifetime and revocation still need a test before it can be enabled. The first slice offers once/reject only.

Until the permission UI has explicit approval, the first live profile must be a verified no-ask profile in a disposable project. An unexpected permission request must not hang a turn: the gateway answers it with the ACP `cancelled` outcome, emits `permission.resolved {reason: "no-ui"}`, and treats the turn as cancelled. Do not ship the composer's `review` profile in this state. Once the UI exists, this branch is replaced by the server-side validation below.

Until Phase 4, the server must filter `allow_always` options out of the k5 `permission.requested` set rather than merely declining them after the browser sees them. A permission decision must never be able to select a hidden always-grant option.

Validate `permission.decide` server-side:

- the ACP permission request belongs to a session owned by this socket;
- `optionId` is one of the options advertised for that exact request;
- the request is single-use;
- a cancelled/expired request is already terminal and cannot be decided late;
- forged session IDs, forged option IDs, and replay are rejected.

A user-selected reject option is still an ACP `selected` outcome on the wire; `permission.resolved { reason: "rejected" }` is the k5 presentation reason, not a different ACP outcome.

Model selection is a post-`session.new` step: the gateway creates the ACP session, reads `session.newSessionResponse.configOptions`, publishes that snapshot in `session.opened`, validates the mapped Composer value against the advertised option values, and only then calls `session/set_config_option`. A value absent from the option's advertised values yields `command.result { reason: "profile-unavailable" }` and closes the session. The client must not clear its `session.open` deadline at `session.opened`; it waits for the corresponding `session.configure` command result (or a typed rejection) before declaring the session usable. The current Composer labels (`opus`, `sonnet`, `haiku`) do not match OpenCode's `provider/model` values, so an approved adapter must translate them; the server must not guess. The observed `mode` selects build versus plan agents, not a general permission axis. Effort/thinking may appear only for models that expose it; re-probe after model selection. Hiding, disabling, or relabeling those locked controls requires Kriday's explicit approval. Until that mapping/approval exists, a live `session.open` must reject an unmappable `permissions`, `model`, or `thinking` setting with `profile-unavailable` rather than running under a posture or model different from the one displayed. This specifically covers the current default `review` and `read` values.

## 7. Client lifecycle

The current locked UI has no stop control: the working dots are a non-interactive indicator at `App.tsx:267-277`, and `cancelReplies()` is only reachable through new-task/session transitions. A user-facing cancel button is therefore an explicit approval gate, not an assumed prop. Until that approval exists, new task, session switch, and socket close use the server-side cancel path; the manual proof must not claim a user stop button.

1. Mount: load projects, show the empty hero, and open the same-origin socket (connection only; do not create an ACP session yet). Give the socket effect a stable connection key/idempotency token so React StrictMode's development double mount opens one logical connection, not two.
2. First prompt: send `session.open` with the active project ID over the already-open socket, and let the server resolve the canonical path. Give `session.open` a bounded client deadline (suggested 60 seconds, longer than the ACP probe's cold-start allowance) and map `initialize-failed`, `protocol-mismatch`, `auth-required`, `session-new-failed`, socket-open failure, close codes, and the deadline to a local failed-prompt terminal state. If `ACP_COMMAND` is unavailable before `session.opened`, do the same; never wait for an event that cannot arrive.
3. Accept the submission without silently dropping it. Because the locked Composer clears its textarea immediately and `onSend` returns `void`, use a bounded one-turn queue. A queued prompt has its own command/turn identity and is cancelled or rejected on new task, close, socket loss, or queue overflow; it always reaches `command.result` or `turn.completed`. If the queue is full, return `command.result { reason: "queue-full" }`/scoped error that the existing transcript can display; do not invent an invisible guard in `handleSend`.
4. Reduce typed events: filter by session, group by message ID, dedupe the user echo, and clear the existing working dots on terminal event/error.
5. Permission: render only if the permission/tool UI has explicit approval. Always validate and resolve the request server-side even if the first browser proof uses a profile that does not ask.
6. Cancel: enter a `cancelling` state immediately, send the `session/cancel` notification, answer pending `session/request_permission` requests with the ACP `cancelled` outcome, answer other cancelled agent→client requests with `-32800` when the SDK/ACP cancellation path requires it, accept late updates until the prompt response, and enforce a watchdog. If the watchdog or turn timeout fires, mark the turn closed, emit one synthetic terminal event, drop a later prompt response by turn ID, mark the seat poisoned, terminate/reap its captured child, and emit `seat.reaped`. Suggested initial watchdog: 10 seconds; suggested overall turn timeout: 30 minutes, both as named constants with tests.
7. New task/project/session selection: cancel the active turn, call ACP `session/close` when supported, mark the old K5 session closed, release its seat, emit `session.closed`/`seat.reaped` as applicable, reset the transcript, and open lazily. A second tab or task must never inherit a live session implicitly.
8. Reload/reconnect: begin memory-only with a visible detached state. A socket drop during `session.open` is a local failed prompt with a retry affordance; do not leave the optimistic bubble waiting. Add cursor replay only with a bounded buffer.
9. Teardown: StrictMode-safe socket cleanup in the browser. During `node --watch` restarts, treat the dropped socket as `connection.closed` and cancel the seat-side turn rather than leaving the UI busy.

Do not coalesce deltas in the gateway using animation frames; the gateway has no animation frame. Coalesce in the browser reducer with `requestAnimationFrame`. Do not retrigger the existing smooth scroll for every token; follow only when the user is already near the bottom. `Markdown` re-lexes and reconciles a growing token tree per content change, so measure it before rendering thought chunks at high frequency.

## 8. Implementation sequence

### Phase 0 — Real ACP probe

- Pin SDK `1.5.0`; add it and `ws` to `server`, plus `@types/ws` and a single workspace Zod `3.25.x` version satisfying the SDK peer range; do not let a Zod 4 copy appear alongside Zod 3. Regenerate the root `package-lock.json` so `npm ci` remains valid. Delete the stale nested `apps/web/package-lock.json` with `git rm` and add it to `.gitignore`; do not create a second install tree. Declare the root Node floor required by the chosen env-file mechanism (`>=22.9.0` if using `--env-file-if-exists`) and pin CI to a compatible 22.x release.
- Change `.env.example` away from the nonexistent `ACP_COMMAND=mock` default; use a real command for manual dev and inject a deterministic fake only in tests.
- Add an argv-based `ACP_COMMAND` loader and the Node-to-WHATWG stream bridge. Use an isolated project/config fixture for the first posture test; do not pass permission maps through `OPENCODE_CONFIG_CONTENT`.
- Implement the SDK `client().connectWith` path.
- Await `initialize`, then await `session/new` with a ≥30-second per-request timeout, then close stdin and await exit. Do not write both requests and immediately close stdin; a cold `session/new` can take tens of seconds.
- If `initialize` advertises an agent auth method, call `authenticate` before `session/new`; an empty result is success, while `-32000` becomes an explicit auth-required skip/result. Verify the SDK's default handling for a missing `type` during the Phase 0 parse test. Skip explicitly with a reason when the binary is missing or required provider authentication is unavailable. Never turn an unavailable environment into a fake pass. Designate the machine that runs real-harness proofs; CI may report an explicit skip.
- Rewrite the shared contract before rewriting the plug: introduce a typed ACP/K5 event union for plug→service→browser, mark the old generic `EventSchema` as an internal/deprecated boundary if retained, and define the adapter/mapping explicitly. Do not leave `K5Service.prompt(): AsyncIterable<Event>` and the new wire union as two unrelated sources of truth.
- Add the ACP probe test to the server's explicit test/security lists in this same phase, before claiming a skip or pass. Change the test command to include the new file (prefer an explicit list or a zero-match-failing wrapper); Phase 1 only verifies the wiring.
- Rewrite `plug.test.ts` and the affected `service.test.ts` assertions around real ACP shapes in the same change; explicitly remove or replace the current `FakeHarness` contract. Do not claim the old suite is green until these named tests are updated. Update the affected `TODO.md` claims (`resume`, timeouts, and the fake-harness item) in the same phase so checked work does not describe behavior being replaced.

**Proof:** real `initialize` and `session/new` succeed, IDs are distinct, and the captured child exits. Deterministic NDJSON framing tests use a separate fake agent. The updated server/shared suites are green, and the real-harness proof runs on a designated maintainer machine while CI reports an explicit skip when OpenCode or credentials are unavailable.

### Phase 1 — Runtime and dev routing

- Extract a server factory while preserving CI's module-scope remote-bind exit code 1 and exact `/health` body. Inject `workspaceRoot` explicitly so moving factory files cannot silently change `currentProjectPath` or project auto-selection.
- Add `ws` with origin validation, explicit inbound/outbound bounds, and ordered teardown. Put the positive/negative upgrade probe in a named test file (for example `server/src/ws-gateway.test.ts`) and add it to the explicit server test/security lists; give it a bounded wait and explicit cleanup rather than relying on `curl` or an unbounded `wait`. Tighten the existing CI `cleanup_dev` wait so a teardown hang fails by name instead of consuming the 15-minute job timeout.
- Remove the Vite project plugin and unused imports; add `server.proxy` and `preview.proxy` with a target loaded from the documented env contract. Fail fast only for serve/preview, not `vite build`. Add a preview-proxy smoke check, not only a dev-server check.
- Update root `dev`, `.env.example`, README quickstart, and CI together. The README's claim that the project API is available on both dev origins becomes false when the Vite plugin is removed, so update that sentence in this phase. Set `K5_SERVER_ORIGIN` and `K5_ALLOWED_ORIGINS` explicitly in the dev-smoke step and in any direct server invocation that constructs the gateway. Keep the existing `PORT`/`HOST`/`ALLOW_REMOTE` inline variables in the direct server steps, and tighten the remote-bind assertion to check the expected error text as well as exit code 1 so an unrelated config failure cannot produce a vacuous pass.
- Change the server and shared test commands carefully. Prefer explicit file lists, or use a wrapper that fails when a glob matches zero tests; a bare zero-match `node --test` glob exits 0. If using recursive globs, quote them and verify the executed file list on the CI Node version. Make the `shared` change unconditional because the reducer is expected to live in a nested domain directory. Move `test:security` and `test:office` to the same guarded form or add every new test explicitly.
- If the project registry requires a new `handleProjectApiRequest` dependency, update its signature and `project-api.test.ts` in the same change.

**Proof:** existing health/remote-bind/dev-proxy smoke tests pass; a disallowed origin is rejected through Vite; SIGTERM with a live WebSocket exits within the deadline; every new test file actually runs. The child-process watch-restart proof belongs to Phase 2, after the plug owns a real ACP child.

### Phase 2 — Contracts and gateway

**Entry gate:** the gateway may be exercised headlessly, but no browser prompt path ships until the approved client error/command-result surface can display pre-session failures. Until then, unmappable settings are rejected server-side and the UI is not enabled for live prompts.

- Add strict Zod command/event schemas, a browser-safe shared settings adapter/mapping table, project registry, plug-owned seat pool, service-owned K5 session/turn registry, and the event broker. The browser sends raw settings; the server derives the access profile and seat key from the shared table, so the browser cannot choose a permission posture.
- Before any seat starts for a real project, verify the resolved OpenCode posture in the actual child environment with `opencode debug config`/`opencode debug agent` (or the equivalent test-only resolver); refuse the seat if the merged configuration is weaker than the k5 profile. Use an isolated child config and a disposable empty project for the first proof; a disposable project alone does not remove global plugins/configuration. The resolver probe is a separate, bounded child process and must have its own timeout/teardown.
- Reserve a provisional seat key before spawning so concurrent opens cannot exceed the cap; promote it to an active seat only after `initialize`/`session.new`. Release the provisional key and terminate the captured child on every pre-`session.opened` failure, emitting `seat.reaped` with no session scope. `K5_DISABLE_LIVE_SEATS=true` returns `command.result { reason: "live-seats-disabled" }` before reserving a key. A failed first prompt must not lock a project for the idle TTL.
- Implement `session.open`, `session.configure` after the `configOptions` snapshot, text `session.prompt`, cancel, close, and an explicit policy for every pinned `SessionUpdate` variant. Map `session.close` to ACP `session/close` only when its capability is advertised; otherwise detach and terminate the seat's captured child.
- Enforce a server-side `session.open` deadline and a client-side command deadline; both emit a terminal failure/command result rather than leaving an optimistic prompt busy.
- Use the SDK session/update stream as the source of `stopReason`; synthesize a terminal k5 error if the prompt promise rejects because the harness or an unimplemented client request failed.
- Bound `available_commands_update` and other non-message payloads; do not forward large inventories verbatim. Do not advertise notice/compaction capabilities until their renderers exist.
- Enforce one active turn and one active session per seat in the first slice, one-turn queueing, single-use permission decisions, per-seat caps/TTL, and the correct cancellation response for each request type: `cancelled` outcome for `session/request_permission`, `-32800` for `$/cancel_request`/internal cancellation of other agent→client requests, and the same `cancelled` outcome for k5 permission expiry.
- On cancel/timeout/child failure, emit `tool.updated` with the ACP status unchanged or `failed` as appropriate, plus k5-local `lifecycle: "cancelled"`; ACP 1.5.0 has no `cancelled` tool status. Do not leave tool cards in an in-progress state.
- Give every rejected/unsupported client method a terminal path: the pending prompt must still resolve or receive one synthetic k5 terminal event. Return typed `command.result` reasons for initialize failure, protocol mismatch, auth-required, session-new failure, seat-cap/socket-cap, and post-session permission validation failures.

**Proof:** fixture and real streams produce exactly one terminal event per turn, including split chunks, cancel races, child death, slow consumers, unsupported client methods, watchdog races, forged permission decisions, failed pre-open seat release, and a `node --watch` restart that touches a loaded fixture module and observes teardown of a live ACP child.

### Phase 3 — Replace the simulation

**Entry gate:** obtain explicit approval for the connection/error surface, sidebar session prop changes, attachment behavior, model/thinking/permission mapping, and any cancel control. Until that approval exists, this phase is limited to the text/transcript path and server-side cancel on new task/session transitions; it must not claim a user-facing stop button, a rewritten sidebar pill, or a live turn whose displayed settings differ from the harness posture.

- Consume the Phase 2 shared settings adapter in the web layer for pre-send validation and labels only; the server remains the sole authority that derives the access profile. The adapter is created and tested in Phase 2; Phase 3 only connects the existing Composer boundary to it. The server must never guess a model or permission posture from an unmapped label.
- Put the pure event reducer/state transitions and the Composer-settings mapping table in a browser-safe, top-level `shared` export (no Node imports, no service state). Re-export them from `shared/src/index.ts` and add an explicit `exports` subpath if a nested module is introduced; never make `apps/web` deep-import `dist/`. Test both through the existing `shared` Node test command. Inject the scheduler used by the rAF batching layer so deterministic tests can drive it without mocking a browser.
- Replace the timer in `App.handleSend`; preserve `sessionKey` only as the composer remount mechanism.
- Reuse the existing working dots. Do not add a new Composer busy prop unless approved.
- Reconnect the static sidebar pill to real connection state; the current `Local workspace / ready` text at `Sidebar.tsx:339-345` becomes false once sockets can drop.
- Task selection uses real IDs; delete the fabricated transcript and replace the static `GROUPS`/sidebar session type only with approval for the prop-surface change. Replace both title-based React keys (`Sidebar.tsx:297` and `Sidebar.tsx:325`) with the stable session ID.
- Do not ship a live attachment chip without a real out-of-band transport. Either disable the paperclip before the first live slice (Composer change, explicit approval) or implement upload/local-file delivery; there is no acceptable interim state in which the chip renders but bytes are discarded, and the agent must never be implied to have received them.
- Model/thinking menus remain untrusted until exact `configOptions` mapping and approval exist. Permission/tool/thought components are also an explicit approval gate.

**Proof:** manual browser verification with observable evidence: prompt text, streamed assistant growth, new-task empty hero, and server-side cancel on a new task/session transition. A user-facing stop control, connection error surface, permission/tool cards, and attachment behavior are proven only after their explicit approval gates.

### Phase 4 — Policy and persistence

- Extend the Phase 2 posture check to the full project/profile matrix; refuse any seat whose resolved posture is weaker than the k5 profile.
- Implement permission UI and validation, including the ACP `cancelled` outcome, `-32800` for protocol cancellation, timeout, revocation, and forged/replay cases.
- Add load/list/resume only with the correct capability gates and stored-cwd validation; do not populate `additionalDirectories`.
- Add out-of-band attachments, then durable transcripts and replay.
- Reconcile `README.md`, `TODO.md`, and `SPEC.md` in this phase: remove the `ACP_COMMAND=mock` default, mark `resume`/timeouts/plug claims as delivered only when they are, and document the real dev/proxy/preview topology.

## 9. Verification rules

- Deterministic tests cover Zod contracts, NDJSON framing, every pinned update variant, direction-safe correlation, gateway bounds, project IDs, permissions, cancellation responses, and shutdown.
- Real harness tests skip loudly when the binary/provider is unavailable. Use Node's explicit `t.skip('reason', ...)`/equivalent in a named test file, and print the reason; they must not be mocked into a pass. State which machine runs them and let CI report explicit skips.
- CI must prove the Vite proxy path, not only a direct gateway test, and must use a WebSocket client that can set `Origin`.
- There is no browser test runner in the repository today. The first browser proof is a manual MCP/browser session with evidence-based DOM/URL assertions.
- Per-phase proofs include the pre-existing targeted suite; no green result may come from a test command that silently omits files.
- Update `README.md` when the first live seat is enabled. Until then, the current statement that the default dev command starts no ACP process remains true because the seat is lazy; the sentence should still be reworded when the first live path lands.
- Reconcile `TODO.md` and `SPEC.md` claims about `resume`, the plug, and the running ACP process with the phase that actually delivers them; do not leave checked items describing deferred behavior.

## 10. Decisions still required

1. Local-only trust model: accept that a local user may open any canonical directory, but decide whether plugin-bearing projects require confirmation or are refused.
2. Seat scope: start with `(harness, project, accessProfile)` and one active session per seat; test multi-project isolation before multiplexing.
3. Permission profile: choose and verify a concrete merged OpenCode configuration; do not map it to build/plan mode or claim that inline config defeats agent/plugin overrides.
4. UI approvals, sequenced:
   - before Phase 3: connection/error surface, cancel control, sidebar session props, attachment behavior, and the Composer-to-k5 settings adapter;
   - before permission/tool proof: permission/tool cards;
   - before model/thinking wiring: model/thinking menu changes.
   Phase 2 can proceed headlessly with the no-UI auto-cancel branch and a verified isolated profile; it must not ship the composer’s `review`/`read` profile or any live browser prompt without the approved error/settings surface. If approval is denied, the correct outcome is no live web path yet, not a lying UI.
5. Persistence: memory-only first; replay only with a bounded buffer.
6. Production topology: how the built single-file web artifact reaches the Node gateway. `vite preview` needs its own proxy; a relative `/ws` URL is not a server behind a `file://` artifact.
7. Cancellation policy is fixed for the first slice: timeout/watchdog poisons and terminates the seat; permission timeout auto-cancels the pending permission.

## Sources

### ACP and SDK

- https://agentclientprotocol.com/protocol/v1/overview
- https://agentclientprotocol.com/protocol/v1/initialization
- https://agentclientprotocol.com/protocol/v1/authentication
- https://agentclientprotocol.com/protocol/v1/session-setup
- https://agentclientprotocol.com/protocol/v1/session-list
- https://agentclientprotocol.com/protocol/v1/session-config-options
- https://agentclientprotocol.com/protocol/v1/session-modes
- https://agentclientprotocol.com/protocol/v1/prompt-turn
- https://agentclientprotocol.com/protocol/v1/tool-calls
- https://agentclientprotocol.com/protocol/v1/cancellation
- https://agentclientprotocol.com/protocol/v1/transports
- https://github.com/agentclientprotocol/typescript-sdk
- https://raw.githubusercontent.com/agentclientprotocol/typescript-sdk/main/src/examples/client.ts
- https://www.npmjs.com/package/@agentclientprotocol/sdk

### OpenCode and transport

- https://opencode.ai/v2/docs/cli/acp
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/config/
- https://v7.vite.dev/config/server-options
- https://github.com/websockets/ws

### Repository

- `apps/web/src/App.tsx`
- `apps/web/src/components/Composer.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/Markdown.tsx`
- `apps/web/src/hooks/useProjects.ts`
- `apps/web/vite.config.ts`
- `apps/web/tsconfig.json`
- `apps/web/package.json`
- `server/src/index.ts`
- `server/src/service.ts`
- `server/src/acp/plug.ts`
- `server/src/acp/plug.test.ts`
- `server/src/projects.ts`
- `server/src/project-api.ts`
- `server/src/project-api.test.ts`
- `server/package.json`
- `shared/src/index.ts`
- `shared/src/index.test.ts`
- `shared/package.json`
- `.env.example`
- `.github/workflows/ci.yml`
- `README.md`
- `SPEC.md`
- `TODO.md`
- `AGENTS.md`

## Adversarial Verification

Three independent adversarial passes checked the draft for source accuracy, protocol shape, repository fit, CI breakage, security, and shutdown behavior. Their confirmed findings were incorporated, including:

- corrected JSON-RPC, capability-gate, SDK-stream, and OpenCode agent-permission claims;
- verified the local `session/new` response and the model-conditional Effort option;
- generated-handler-table and pinned-update-schema rules, including `-32800` cancellation responses;
- merged-config/agent/plugin trust boundaries and non-overpromising posture enforcement;
- Vite plugin removal, env loading, build-vs-serve behavior, proxy/preview wiring, lockfile/types, and quoted test globs;
- child stderr draining, process-group ownership, `ws` termination, and hard exit deadlines;
- server-side ownership/option/replay/expiry validation for permissions;
- explicit UI approval gates, attachment honesty, and reverse states.

Final adversarial pass: pending. Implementation remains blocked until the remaining findings are resolved.

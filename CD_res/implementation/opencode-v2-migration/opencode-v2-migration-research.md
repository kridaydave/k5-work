# Implementation Research: OpenCode v2 migration

**Date:** 2026-10-10
**Scope:** research and planning only; no product code changed
**Pin before:** OpenCode 1.18.31 (per `CD_res/implementation/acp-web-ui/acp-web-ui-research.md`)
**Pin after:** OpenCode 2.0.24 (installed; verified by direct probe, see Adversarial Verification)

## The Task

k5-work's ACP seat and posture resolver were built against OpenCode 1.18.31. The
environment now runs OpenCode 2.0.24. The migration makes k5-work's harness
adapter and its real-binary tests honest against v2 again. Four failures in
`npm run test -w server` trace to the version jump; the other 417 passes and all
205 shared+web tests are unaffected.

## What actually changed (measured, not assumed)

All facts below were produced by running the installed binary, not by reading a
changelog. The ACP docs page (https://opencode.ai/docs/acp/) confirms `opencode
acp` is still the seat command; the v1 changelog page lists no v2 entries, so
the binary is the authority.

### 1. The posture resolver command changed (breaking)

| | 1.18.31 | 2.0.24 |
|---|---|---|
| Command | `opencode debug agent <name>` | `opencode debug agents` (no argument) |
| Output | one object: `{"permission": [{"permission","action","pattern"}]}` | array of agents: `[{"id","permissions":[{"action","resource","effect"}]}]` |
| Field map | `permission`, `pattern`, `action` | `action`, `resource`, `effect` |

`opencode debug agent build` now exits 1 with `Unknown subcommand "agent"`.
`opencode debug agents` exits 0 and lists nine agents: `build`, `plan`,
`comment-sicko`, `compaction`, `explore`, `general`, `poteto-agent`, `summary`,
`title`.

The k5 parser in `server/src/acp/posture.ts:127-183` reads `parsed.permission`
and the old triple, so every v2 output fails as "no permission array" →
`PostureUnverifiableError`. That is the root cause of three of the four test
failures (`posture-opencode.test.ts` x3, which also cascades into
`session-service`-adjacent posture tests).

Wildcard semantics survive the rename: the `build` agent's first rule is
`{"action":"*","resource":"*","effect":"allow"}`, which maps to
k5's `{permission:"*", pattern:"*", action:"allow"}` → `wildcardAllow: true`.
So `verifyPosture` for the `full` profile still passes, and `read`/`review` are
still refused, which is the behavior the tests assert. The mapping is a rename,
not a semantic change.

One semantic nuance worth recording: the `plan` agent denies edit broadly with a
narrow allow (`{"action":"edit","resource":"/home/kriday/.opencode/plan/*","effect":"allow"}`).
Under k5's existing grant semantics that allow lands in `allowedTools` as
`edit` with a scoped pattern, which is exactly what the current
`PostureTooWeakError` scope-reporting path was built to show. No new logic
needed.

### 2. The initialize response advertises more (test-breaking, code-safe)

v2 `initialize` (protocolVersion still 1, `opencode acp` unchanged):

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": false },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": {
      "additionalDirectories": {}, "close": {}, "delete": {},
      "fork": {}, "list": {}, "resume": {}
    },
    "_meta": { "opencode/child-session-updates": true }
  },
  "agentInfo": { "name": "OpenCode", "version": "2.0.24" }
}
```

New vs 1.18.31: `mcpCapabilities`, `_meta`, `agentInfo.version`, and the
session capabilities `additionalDirectories` and `delete`. Load-bearing good
news: `promptCapabilities` is unchanged (`embeddedContext: true`, `image:
true`), so the whole attachment path in `prompt-blocks.ts` still fires.

`capabilities.ts` reads only `sessionCapabilities.resume` and `.close`
(`server/src/acp/capabilities.ts:95-96`), never enumerates, and never rejects
unknown keys. So the new keys pass unread and no mismatch is pushed. The probe
needs no change. The only breakage is the exact-key-set assertion in
`attachments-opencode.test.ts:325-331`, which is the fourth test failure.

### 3. The test machine's default model is deprecated (environment-only)

`opencode models` still advertises `opencode/exo-free`, but a real turn with it
hard-fails: `Error: Model exo-free has been deprecated.` (exit 1). The
real-turn tests (`slow-turn-opencode.test.ts`, the adoption test in
`attachments-opencode.test.ts`) run the harness default, so their turns report
`null` and the suite skips them loudly with that reason. No repo file declares
a model and no repo file mentions `exo-free`, so the default comes from
machine-level opencode state, not from k5. This is an environment fix, not a
code fix: pin a live model in the test fixture.

## 1. Common gotchas

- **Renaming fields, not semantics.** The v2 rule triple is the same fact with
  three new key names (`action`→permission name, `resource`→pattern,
  `effect`→allow/deny/ask). A translation layer that renames is correct; a
  rewrite of the accept/refuse logic is not. The entire trust model
  (`isPostureAcceptable`, profiles, fail-closed verification) stays as is.
  Source: direct probe of both command shapes.
- **The resolver no longer takes an agent argument.** v2 lists all agents and
  the caller selects by `id`. Code that passes an agent name as an argv element
  would be silently ignored, then fail on "agent not found" if the selection is
  done by the wrong key. Select on `id`, and keep an unknown id as
  `PostureUnverifiableError` (current behavior, asserted by
  `posture-opencode.test.ts` "reports an unknown agent as unverifiable").
- **Hidden agents now exist in the list.** `title`, `summary`, `compaction`
  are system agents. k5 resolves any listed agent's permissions; visibility is
  harness business. `DEFAULT_AGENT` stays `build` (`seat-runner.ts:93`).
- **The model catalog lies.** `opencode models` lists deprecated models. A test
  that trusts the catalog picks a dead model; only a real turn proves liveness.

## 2. Best practices

- **Translate at the adapter boundary.** The resolver in `posture.ts` is
  already the opencode-specific glue (it hardcodes the `debug` subcommand).
  Normalizing v2's shape into the existing `ResolvedPosture` contract there
  keeps one translation point and zero downstream changes. Verified consumer
  inventory: `ResolvedPosture` is referenced by exactly three files,
  `posture.ts`, `seat-runner.ts` (4 sites), `session-service.ts` (3 sites), and
  none of them inspect rule shape — they carry the parsed record.
- **No dual-format parsing.** Supporting both old and new shapes means the
  old-shape fixtures never die and the next jump is harder. k5 runs one real
  harness; the resolver is already harness-specific. Migrate outright, delete
  the old fixtures in the same wave (principle-migrate-callers-then-delete-legacy-apis).
- **Pin the model in the test, not on the machine.** The real-turn tests should
  carry their own model choice so a machine's default model changing does not
  turn a codebase into a red suite again.

## 3. Pitfalls and quirks

- `session-service.test.ts`'s `harnessWithResolver` stand-in (line 199) builds a
  shell script that answers any argv starting with `debug` by catting a fixture.
  The fixture is the old shape (`session-service.test.ts:1538-1541`, `:1580`).
  Both the fixture shape and the comments at lines 77, 195, 1597 move.
- `posture.test.ts`'s `fakeResolver` (line 49) same story: the fake script is
  argv-agnostic, so only its fixtures (lines 18-42) and the comment at line 81
  move.
- Comment accuracy: 16 occurrences of `1.18.31`/`1.18.32` across
  `access.ts`, `plugin-guard.ts`, `fake-agent.ts`, three test files, and two
  docs. They describe 1.x behavior. Historical records (`TODO.md`, the dated
  `CD_res/` research) stay as-is; live code comments and the decisions doc get
  updated or appended.
- The v2 `plan` agent's narrow allow path is absolute
  (`/home/kriday/.opencode/plan/*`), not repo-relative. The scope-reporting
  path surfaces it verbatim; do not "fix" it into a relative path.

## 4. Differentiation

Industry standard for a protocol client pinned to an agent CLI: pin the CLI
version, or probe for shape. k5 already chose "probe the real binary in tests
and record its advertising verbatim" (the exact-key-set assertion exists for
this). The migration follows that standard: re-measure, re-record, translate
where the wire renamed. Nothing novel is introduced; that is the right outcome.

## Recommendation

Migrate the resolver to v2 with a rename-only translation inside `posture.ts`,
update the two test double fixtures and the capability key-set assertion to the
measured v2 truth, pin a live model in the real-turn test fixtures, and update
the stale version comments plus append a v2 re-verification note to
`docs/posture-and-trust-decisions.md`. Do not adopt `delete` or
`additionalDirectories` capabilities (record them in the assertion only; YAGNI).

Sequenced, verifiable units (each ends green before the next starts):

1. **Resolver (red first).** Convert `posture.test.ts` fixtures to the v2 shape
   and watch them fail; translate in `posture.ts` (`debug agents`, select by
   `id`, rename the triple); watch fake tests and `posture-opencode.test.ts`
   go green. ResolvedPosture contract untouched.
2. **Capability truth.** Update the key-set assertion in
   `attachments-opencode.test.ts` to the six measured keys and assert the probe
   still reads them with zero mismatches. Initialize-only: no model needed, so
   this unit is fast and deterministic.
3. **Real-turn fixtures.** `harnessWithResolver` in `session-service.test.ts`
   emits the v2 shape; pin a live model (`opencode/step-5-preview-free`, the
   session's own model, or another free model) in the real-turn test fixtures'
   project config so turns no longer depend on the machine default. Then run
   `slow-turn-opencode.test.ts` and the adoption test against the real binary.
4. **Comments and decisions doc.** Update the stale version references in live
   code comments; append the v2 evidence to
   `docs/posture-and-trust-decisions.md` (resolver command, wildcard, plan
   agent edit-deny); leave dated research artifacts alone.

Delivery order per unit is commit-shaped: fixture/test change first where it
can fail for the right reason, fix second, comment cleanup last.

## Sources

- Installed binary: `opencode v2.0.24` at `/home/kriday/.opencode/bin/opencode`
- `opencode debug agents` (full JSON, build and plan agents inspected)
- Live ACP initialize probe against `opencode acp` (raw JSON quoted above)
- `opencode models`; `opencode run --model opencode/exo-free "say hi"` →
  `Error: Model exo-free has been deprecated.`, exit 1
- https://opencode.ai/docs/acp/ — `opencode acp` unchanged, permissions system
  still ACP-supported
- https://opencode.ai/changelog/ — v1.18.31 (the pin) through v1.18.35
- Repo: `server/src/acp/posture.ts`, `capabilities.ts`, `seat-runner.ts`,
  `session-service.ts`; tests named above; `shared/src/access.ts`,
  `shared/src/contracts.ts`

## Adversarial Verification

- Binary facts re-verified by an independent agent that re-ran every probe
  itself: all six claims CONFIRMED (version, command rename and output shape,
  build wildcard, plan edit-deny, initialize response field-for-field, model
  deprecation, absence of any repo-side model config).
- Consumer inventory verified by grep across `*.ts` in all three workspaces:
  `ResolvedPosture` has exactly three consumers, none inspecting rule shape;
  the only production file parsing the resolver output is `posture.ts`.
- Capability probe read path verified by reading `capabilities.ts:90-104`: only
  `resume` and `close` are read; unknown keys cannot produce a mismatch.
- Model deprecation is environmental: reproduced with a real turn, not inferred
  from the catalog.
- Status: GREEN.

# Locked decisions: ACP seat posture and trust boundary

**Date:** 2026-09-26
**Status:** locked by maintainer
**Evidence:** `opencode debug agent` against OpenCode 1.18.31, run in a clean
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` sandbox.

## 1. Only the `full` access profile is servable

`opencode debug agent build` resolves 83 permission rules whose first entry is a
blanket `{permission: "*", action: "allow", pattern: "*"}`. The named `allow`
rules are `read`, `question`, `plan_enter`, and `external_directory`.

Two configuration routes were tested for narrowing that posture, in an isolated
config tree:

- a top-level `permission: {edit,bash,write,patch: "deny"}` block
- an `agent.build.permission` block with the same entries

**Both were silently dropped.** The resolved rule list was identical in both
cases and identical to the default. OpenCode 1.18.31 does not merge those blocks
into the agent's permission list.

Consequences that decided this:

- A blanket `*: allow` means the harness never asks. An ACP
  `session/request_permission` gate therefore never fires, so a gate cannot
  supply the missing enforcement.
- Advertising `read` or `review` would be a promise k5 cannot keep, not a
  degraded-but-working mode.
- `plan` is not an alternative: it appends `edit: deny` scoped to
  `.opencode/plans/*.md` while keeping the `*: allow` wildcard, so shell and
  every other capability still fall through.

**Decision.** `full` is the only servable profile. `read` and `review` remain
defined in `shared/src/access.ts` so a stale client receives a precise
refusal reason rather than `invalid-payload`, and `SERVABLE_PROFILES` is the
single authority consulted before a seat key is reserved. The composer offers
`full` only.

**Enforcement point.** `SeatRunner.open` in `server/src/acp/seat-runner.ts` calls
`isServableProfile` before it parses the harness command, resolves a project, or
reserves a cap slot, so a non-servable label is refused without a child process
ever starting. `session.open` carries no access field at all
(`SessionOpenCommandSchema` has none), so the browser cannot ask for a posture;
the service passes `access: "full"` for the only profile it serves today.

**Revisit condition.** If a future OpenCode release merges those config blocks,
or k5 gains a tool-proxy that enforces capabilities outside the harness, the
narrower profiles become servable. `verifyPosture` in
`server/src/acp/posture.ts` is the gate that would then pass, and the
real-harness test in `posture-opencode.test.ts` is the thing that must change.

## 2. Posture verification fails closed, but currently has no teeth

`verifyPosture` refuses rather than downgrades. A posture that is broader than
the profile is refused with the offending grant *and its pattern*, because a
permission allowed only for `.opencode/plans/*.md` is a materially different
fact from one allowed everywhere, and the operator needs to see which was
resolved.

An unreadable posture is treated as untrustworthy. The single exception is
`full`, which promises nothing narrower than the harness default, so there is
no gap for an unreadable posture to hide behind.

**Stated honestly:** because `full` is the only servable profile, and
`verifyPosture` tolerates an unreadable posture for `full`, this gate has **no
enforcement power in any configuration that currently ships**. It is live code
with a real test suite, exercised on every seat open, but it cannot refuse
anything yet. Its value is that the refusal path is proven and wired for the
day a narrower profile becomes servable, and that a future regression in
`isPostureAcceptable` fails the `posture-opencode.test.ts` assertions rather
than passing silently.

The resolver also refuses on inputs it cannot read as a posture: an empty
permission array, a `*` grant scoped to a subtree, an unrecognised `action`
value, or a non-zero exit. Treating those as "narrow" rather than "unknown" was
a fail-open that the adversarial pass caught.

OpenCode's `permission` vocabulary mixes capabilities (`read`, `edit`, `bash`)
with control-flow gates (`question`, `plan_enter`, `plan_exit`, `doom_loop`).
Only capabilities participate in the comparison; treating a gate as a
capability would refuse every seat for no security benefit. An unrecognised
permission name is treated as a capability, so a harness that invents one
cannot slip past by being unlisted.

## 3. Plugin-bearing projects are refused, by name

A project's own `opencode.json`, `.opencode/agents`, and `.opencode/plugins` are
inside the trust boundary. Since config cannot be narrowed (decision 1), a
project plugin is not a smaller hole than a wider one — it is the remaining way
to widen behaviour after the configuration route is closed.

**Decision.** Seat creation is refused for a project containing
`.opencode/plugins` (or `.opencode/plugin`), agent definitions under
`.opencode/agents` (or `.opencode/agent`), an `opencode.json`/`.jsonc`
declaring `plugin`, or a config too large to read. The refusal names which
signal was found. A trusted-project allowlist may follow later; it must be
explicit, never implicit.

**Enforcement point.** `findPluginSignals` runs inside `SeatRunner.open`,
before the harness command is parsed, so a plugin-bearing project never reaches
a resolver or a spawned child. `server/src/acp/session-service.test.ts` proves
the refusal reaches the browser as `session.failed { reason:
"project-has-plugins" }` with the path in the message, and that a refused
project reserves no cap slot.

**Scoping limit, stated honestly.** The guard inspects the project root only.
OpenCode also merges configuration from ancestor directories and
`$XDG_CONFIG_HOME`, so a plugin one level above the project root is not
detected. Closing that requires walking ancestors to the filesystem root, and
deciding how far up is "the project" — deferred deliberately rather than guessed.

## 4. `workspaceRoot` is a discovery seed, not a containment boundary

`ProjectOpenRequestSchema` accepts any non-blank path and the open endpoint
canonicalizes without enforcing `workspaceRoot`. The v1 threat model trusts a
single local user who may open any canonical local directory, and keeps remote
binding off. `ALLOW_REMOTE=true` must never become a deployment mode: without
authentication, project discovery plus an ACP `cwd` is remote code execution.

The HTTP surface additionally refuses any `Host` header outside the allowlist
with `421`. A rebound DNS name makes a request same-origin, so that check — not
CORS — is what stops a hostile page from reading the project list or opening
arbitrary directories through `/api/projects/open`.

## 5. Re-measured against OpenCode 2.0.24 (2026-10-10)

Everything above was measured on 1.18.31. The harness moved to 2.0.24 and the
facts were re-measured rather than assumed. The resolver changed shape:
`opencode debug agent <name>` became `opencode debug agents`, which lists every
agent as `{ id, permissions }`, with each rule naming the permission in `action`,
its pattern in `resource`, and its verdict in `effect`. `server/src/acp/posture.ts`
normalises that triple into the existing `ResolvedPosture` contract and selects
the agent by `id`, so no consumer of that contract changed.

**Decision 1 still holds.** The `build` agent's first resolved rule is still the
blanket `{"action": "*", "resource": "*", "effect": "allow"}`. The wildcard means
the harness still never asks, so a `session/request_permission` gate still cannot
supply enforcement, and `read` and `review` remain promises k5 cannot keep. The
revisit condition in decision 1 has not fired.

**What changed is the configuration route.** In a clean config sandbox
(`XDG_CONFIG_HOME` and friends pointed at an empty tree, service port moved off
the machine's live server, project directory separate):

| project `opencode.json` | resolved `build` rules |
| --- | --- |
| none | 6 rules, first is `* *=allow` |
| `permission: {shell, edit: "deny"}` | the same 6 rules, unchanged |
| `agent: {build: {permission: {shell, edit: "deny"}}}` | 8 rules, wildcard still first, then `shell *=deny`, `edit *=deny` |

So a top-level `permission` block is still dropped, matching the 1.18.31
measurement, and the agent-scoped block is now merged. The merged rules are all
`deny`, and the wildcard stays first, so the direction of the change is
narrowing: a project can shrink its own seat and cannot widen one. `opencode
debug config` confirms the project document contributes
`agents.build.permissions` in the third row.

**What that does and does not mean for k5.** `resolvePosture` builds its grants
from `allow` rules only, so a `deny` never appears in the k5 record. A project
that narrows itself is read by k5 as the wildcard posture it already had, which
is the safe direction: k5 never promises less reach than the harness could still
grant. Decision 3 is unchanged in force. A project plugin is code the harness
executes, which no permission vocabulary describes, and a narrowing config block
is not a substitute for that. The plugin guard's comment was rewritten to say
this in v2 terms rather than citing the dropped-config fact it was built on.

**Plan agent.** Under `plan` the edit grant is still scoped rather than global
(`/home/kriday/.opencode/plan/*` on this machine), and `shell` is not named, so
everything still falls through the wildcard. Decision 1's note about `plan`
stands as written.

**Other v2 facts recorded.** `opencode acp` is unchanged, `protocolVersion` is
still 1, `promptCapabilities` is still exactly `embeddedContext: true` and
`image: true` (asserted against the real binary in
`attachments-opencode.test.ts`), and the advertised session capabilities grew to
`additionalDirectories`, `close`, `delete`, `fork`, `list`, `resume`. k5 reads
`resume` and `close` and records the rest in that assertion so drift is loud.

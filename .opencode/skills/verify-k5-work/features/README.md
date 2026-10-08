# k5-work verification map

The maintained source for verifying what a user of k5-work actually sees. Read this index before driving the app, then open the feature file and run its flow.

## What k5-work is

A local-first browser workspace that runs an open coding harness (an ACP agent) on your machine. The user picks a project folder, types a request, and watches a turn stream back. Everything k5 persists lives in one SQLite store so a reload does not lose the history.

There is no login and no remote mode. The whole surface is loopback, which is why an isolated instance is cheap to start.

## Baseline preconditions

- Run every command from the repo root with `export SKILL="$PWD/.opencode/skills/verify-k5-work"` set. The commands below use `$SKILL` so they stay copy-pasteable.
- Node 22.9 or newer, and `npm install` already run at the repo root.
- `npm run build -w shared && npm run build -w server`. The verification harness is `server/dist/acp/fake-agent.js`, so a missing `server/dist` means nothing can be driven.
- Start the instance with `$SKILL/scripts/launch.sh <run-id>`. It binds 8788 and 5174, never the documented dev defaults, and it points `XDG_DATA_HOME` at a directory inside the run folder so a verification run cannot read or overwrite `~/.local/share/k5-work`.
- Run `$SKILL/scripts/doctor.sh <run-id>` and require every check to pass. A failed doctor means a failed drive for reasons that have nothing to do with the change under test.
- Never drive an instance you did not start. `$SKILL/scripts/doctor.sh` proves each pid's cwd belongs to this checkout, which is the only safe basis for killing it later.
- Never reuse a run id whose previous drive was interrupted. A tab killed mid-turn leaves the seat holding its session, the next browser is refused with `seat-busy`, and its prompt silently never runs. Doctor fails the instance for exactly this. Relaunch with a fresh id.

## The harness question, answered once

A turn needs a harness. k5-work ships one: `server/dist/acp/fake-agent.js`, a deterministic ACP agent used by the server's own tests. It speaks the real protocol over real stdio, answers a prompt with a known thought chunk, a known tool call, three text chunks reading `first second third`, and advertises two model options.

Use it by default:

```bash
$SKILL/scripts/launch.sh <run-id>     # defaults to the fake agent, scenario "ok"
```

Use a real harness only when the thing under test is how k5 behaves against a harness k5 does not control, such as posture resolution or a slow turn. Then say so in the report, because a fake-harness pass and a real-harness pass are different claims:

```bash
K5_VERIFY_ACP_COMMAND="opencode acp" $SKILL/scripts/launch.sh <run-id>
```

Other fake-agent scenarios worth knowing: `echo-blocks` returns the exact ACP blocks the harness received, which is how you prove an attachment really reached the harness; `permission` holds a turn open; `slow` splits the answer across notifications so a cancel race reproduces; `auth-required` and `protocol-mismatch` produce typed seat failures.

## Driving conventions

- Drive through the browser with the `ui-verify` wrapper at `~/fleet/dev-workflow/ui-verify/scripts/ui-verify`. It gives screenshots, a console and network report, and per-assertion pass or fail.
- Address elements by accessible name, never by position or CSS class. Two real traps: the expanded sidebar labels its sections with headings and only adds `aria-label` once collapsed to the icon rail, so a `section[aria-label="Projects"]` selector silently matches nothing in the default state; and a select menu renders `role="menuitemradio"`, not `menuitem`.
- Treat every command as literal. Keep quoted paths and flags unchanged.
- Wait on a real event, never a fixed sleep. The seat opens lazily on the first prompt, so the gap between Send and the first streamed token is a cold `session/new` against a real harness and can take tens of seconds.
- Do not assert on a value the app deliberately refuses to invent. With the fake agent the composer says "not discovered yet" for the current model, because the harness advertised no `currentValue` and falling back to the first entry would be a guess. Assert that the menu is enabled and lists what was advertised, not that a name is shown.
- Restore seeded state after a mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- UI proof is a screenshot set plus `report.json`. Read the report every time. A run with zero issues prints a clean summary; anything else prints what it found.
- Two console entries are baseline on this repo and are named in the flow that expects them: the WebSocket-close warning from `page.reload()`, and a 404 for `/favicon.ico`. Anything else is a finding. Do not extend the baseline list to make a run green.
- A mutation proof includes a read-only second view. `send-a-prompt.mjs` finishes by reading `GET /api/sessions` from inside the page, so the stored claim does not rest on the sidebar alone.
- Record the feature ID, the entry point, and the run id with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. A skipped entry point is not a verified one.

## Where artifacts land

```
.verify-k5/<run-id>/server.log            server stdout, including the k5 audit lines
.verify-k5/<run-id>/web.log               vite log
.verify-k5/<run-id>/env.sh                ports and paths for this run, sourceable
.verify-k5/<run-id>/ui/<flow>/            screenshots, webm, gif, report.json
.verify-k5/<run-id>/data/k5-work/         the disposable store, removed by teardown
```

One directory per flow. Every run writes a file called `report.json`, so two flows sharing one directory means the second silently overwrites the first run's console and network report.

Teardown deletes only `data/`. The logs and the `ui/` artifacts survive on purpose.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line each.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets pairing each user action with an exact command and an observable result.
4. `Gotchas` lists traps that waste or invalidate a run.

Keep implementation details out of the map. Name user paths, stable handles, required state, commands, and observable proof.

## Features

- [Send a prompt and get a turn](./send-a-prompt.md) covers the empty hero, the lazy seat, streamed answer, tool card, harness-advertised models, and the store round trip.
- [Workspace navigation](./workspace-navigation.md) covers project discovery and switching, opening a folder by path including the refusal, sidebar collapse, and task search.
- [Composer controls](./composer-controls.md) covers the mode and permission pills, the resolved-posture disclosure, attachments by picker and drop including a refusal, and removing a stored task.

The office generator is deliberately absent. `server/src/ooxml-core` is complete and tested, but nothing in the app reaches it: no route in `server/src/app.ts` and no call from `apps/web`. A feature file for it would describe a screen that no user can reach, so it waits for the route that exposes it.

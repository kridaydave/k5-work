---
name: verify-k5-work
description: Drive the real k5-work app in a browser and prove a change works with screenshots, console and network reports, and store read-backs. Use when a change touches the composer, sidebar, transcript, ACP seat, session store, project discovery, or office generation in this repo, and before claiming any UI or seat behavior is fixed. Also use when a run needs proving against a real harness rather than the in-repo deterministic one.
---

# Verify k5-work

k5-work is a local-first browser workspace that runs an open coding harness over ACP. Verifying it means starting an isolated instance, driving the browser the way a user does, and keeping the evidence.

Start from `features/README.md`. It holds the feature index, the baseline preconditions, and the proof standards. Do not invent a recipe when the map already names one.

## Launch

Build once, then start one isolated instance per run. Every command below is written against `$SKILL`, so set it first and run everything from the repo root.

```bash
export SKILL="$PWD/.opencode/skills/verify-k5-work"

npm install                                                    # once per checkout
npm run build -w shared && npm run build -w server            # once per checkout

$SKILL/scripts/launch.sh <run-id>
source .verify-k5/<run-id>/env.sh
```

`launch.sh` binds 8788 and 5174, so a running `npm run dev` on 8787 and 5173 is never touched. It points `XDG_DATA_HOME` into `.verify-k5/<run-id>/data`, so the run cannot read or overwrite the operator's real history in `~/.local/share/k5-work`. It starts the harness child with `setsid`, so an interrupted agent shell does not leave a half-dead instance behind.

The default harness is `server/dist/acp/fake-agent.js ok`, the deterministic ACP agent the server's own tests use. It speaks the real protocol over real stdio and answers a prompt with a known thought chunk, a known tool call, and `first second third`. Use it unless the thing under test is how k5 behaves against a harness it does not control.

```bash
K5_VERIFY_ACP_COMMAND="opencode acp" $SKILL/scripts/launch.sh <run-id>
```

Readiness is two answers: `GET /health` returns `{"status":"ok"}` and the web origin serves the app shell. `launch.sh` blocks until both, and prints the failure with the tail of both logs if either never comes up.

## Doctor

Run this whenever anything looks off, before concluding the app is broken.

```bash
$SKILL/scripts/doctor.sh <run-id>
```

Eleven read-only checks. Both pids are running and their `/proc/<pid>/cwd` is this checkout. Both ports are owned by those pids, not by a neighbour. `/health` answers. The store is inside the run directory. The web origin serves the shell. `K5_ALLOWED_ORIGINS` was accepted. `/api/projects` answers through the vite proxy, which proves the same-origin path the browser actually uses. No seat is stuck holding a session.

That last one earns its place. A browser tab killed mid-turn leaves its seat holding the session, and the next browser is refused with `seat-busy`. Its prompt never runs, so the flow times out waiting for an answer and the failure reads as a regression in the app. Doctor catches it and tells you to relaunch with a fresh run id.

It exits non-zero on any failure. A failed doctor makes a drive meaningless, so fix the instance before reading anything into a failing assertion.

## Drive

Two flows ship with this skill. Both run under the `ui-verify` wrapper, which is the only sanctioned way to drive a UI in this fleet.

Each flow gets its own `--out` directory. They share a `report.json` filename, so pointing two runs at one directory silently loses the first run's console and network report.

```bash
source .verify-k5/<run-id>/env.sh

# a whole turn: hero, lazy seat, streamed answer, tool card, models, store round trip
~/fleet/dev-workflow/ui-verify/scripts/ui-verify shoot "$K5_VERIFY_WEB_URL" \
  --script "$SKILL/flows/send-a-prompt.mjs" \
  --out ".verify-k5/$K5_VERIFY_RUN_ID/ui/send-a-prompt" --name send-a-prompt --video

# the workspace before any agent runs
K5_VERIFY_REPO_ROOT="$PWD" ~/fleet/dev-workflow/ui-verify/scripts/ui-verify shoot "$K5_VERIFY_WEB_URL" \
  --script "$SKILL/flows/workspace-navigation.mjs" \
  --out ".verify-k5/$K5_VERIFY_RUN_ID/ui/workspace-navigation" --name nav --video
```

Both take real user actions: typing into the composer, clicking Send, clicking sidebar rows, pressing `Ctrl+B`. Neither calls an internal setter or a test-only endpoint.

Handle rules that cost real time to rediscover:

- Address by accessible name, never position or class.
- The expanded sidebar labels sections with an `h2` and only adds `aria-label` when collapsed. `section[aria-label="Projects"]` matches nothing in the default state.
- Select menus are `role="menuitemradio"`, not `menuitem`.
- Wait on a real event. The first Send triggers a cold `session/new`, which takes tens of seconds against a real harness.

## Evidence

Artifacts land in `.verify-k5/<run-id>/`:

```
server.log   web.log   env.sh
ui/send-a-prompt/       screenshots, webm, gif, report.json
ui/workspace-navigation/  the same, for the navigation flow
```

`report.json` is the gate, not the screenshots. It lists every console error, page exception, failed request, 4xx and 5xx the run produced. Read it every time, once per flow directory.

Three entries are baseline on this repo and are named in the flows that expect them:

- The WebSocket-close warning fires on `page.reload()`, when the browser tears the old socket down mid-handshake.
- `GET /favicon.ico` is 404. There is no favicon.
- `POST /api/projects/open` returns 404 in the folder-refusal assertion. That is the assertion.

Anything else is a finding. Do not extend the baseline list to make a run green.

Proof standards:

- Exercise the real user path. A screenshot of a state reached through an internal setter proves nothing about the user.
- Capture the action and the resulting state, not only the final screen. The turn flow screenshots the moment the prompt is sent as well as the answer landing.
- Verify side effects. The turn flow ends by reading `GET /api/sessions` from inside the page and asserting `turnCount`, so the stored claim does not rest on the sidebar.
- A fake-harness pass and a real-harness pass are different claims. Say which one ran.
- An unreachable path is reported with the attempted command and the unmet precondition. A skipped entry point is not a verified one.

After a drive that opened a seat:

```bash
$SKILL/scripts/check-seats.sh <run-id>
```

At most one harness child, and a store inside the run directory. An orphaned ACP process is invisible in the UI and shows up on the operator's machine an hour later.

## Cleanup

```bash
$SKILL/scripts/teardown.sh <run-id>
```

Kills only the pids recorded in the run directory, and only after confirming each one's `/proc/<pid>/cwd` is this checkout. Never kill by process name: this agent's own argv contains the worktree path, so a pattern kill takes out the operator's dev server and this session with it. It also confirms the web port was actually released, since killing the wrapper can leave vite holding it.

Teardown removes `data/` and nothing else. Logs, screenshots, recordings and `report.json` survive in `.verify-k5/<run-id>/`, because a cleanup that eats the proof fails the run. `$SKILL/scripts/teardown.sh <run-id>` after every failed iteration too, so a broken attempt does not strand ports and processes.

## Repairing this skill

When a flow fails, decide which of three things broke before editing anything.

The app broke. Leave the flow alone. It caught something.

The flow is wrong. Fix the locator or the expectation, and say why in a comment. The two bugs already found this way are recorded in `features/README.md` under driving conventions.

The baseline moved. Only then does `knownBaselineIssues` in the flow change, and the reason goes in the comment above it.

Keep `features/README.md` and its feature files honest as the app changes. `/maintain-verification-skill` runs that pass.

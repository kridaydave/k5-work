# Send a prompt and get a turn

A user picks a project, types what they want, and presses Send. k5-work opens a harness seat on that first prompt, streams the turn back into the transcript, settles each tool call as a row, and records the whole thing so a reload still shows it.

## Sub-features

- `hero-empty` The empty state names the project that is already selected and invites a request.
- `seat-lazy` No harness process exists until the first prompt. An empty composer costs nothing.
- `stream-answer` The harness answer arrives in chunks and is reassembled into one message.
- `tool-card` Each tool call settles into a single row with its own status word.
- `models-from-harness` The model menu is populated from what the harness advertised, never from a hardcoded vendor list.
- `store-roundtrip` The turn survives a reload, and reopening the task brings the transcript back.
- `composer-reset` The composer clears itself and disables Send when the turn ends.

## How to get to it (user POV)

- The web app at the dev origin. There is one route and no navigation; the composer is always at the bottom.
- Press Enter in the composer, or click the Send button.
- `Ctrl+Alt+N` starts a new task from anywhere.
- The sidebar task rows reopen a recorded turn.

## Driving it with ui-verify

Preconditions: `$SKILL/scripts/launch.sh <run-id>` has run, `$SKILL/scripts/doctor.sh <run-id>` passed, and the harness is the in-repo fake agent on scenario `ok`.

```bash
source .verify-k5/<run-id>/env.sh
~/fleet/dev-workflow/ui-verify/scripts/ui-verify shoot \
  "$K5_VERIFY_WEB_URL" \
  --script "$SKILL/flows/send-a-prompt.mjs" \
  --out ".verify-k5/$K5_VERIFY_RUN_ID/ui/send-a-prompt" \
  --name send-a-prompt --video
```

- **Empty hero** waits for `#composer-input` and asserts the heading `What should we build in {project}?`. A real project is selected with no click, so `your project` means discovery failed.
- **Send** fills the composer and clicks `button[aria-label="Send message"]`, then waits for the prompt text to appear as the user's own bubble. Screenshot taken at the action, not only at the result.
- **Answer** waits for `first second third`. With a real harness, set `K5_VERIFY_ANSWER` and expect the run to take materially longer: the gap is a cold `session/new`.
- **Tool card** waits for `li[aria-label="read file: Completed"]` inside `ul[aria-label="Tool calls in this turn"]`. `Completed` is the word, not a colour; the palette reserves green and red for diff counts.
- **Turn end** asserts the working dots detach and Send is disabled again.
- **Models** opens `[aria-label^="Model. Current:"]` and asserts a `role="menuitemradio"` named `OpenCode Zen/Space Bunny Free` is present.
- **Reload** re-reads the page and asserts the task row is in the sidebar, then clicks it and asserts the answer returns.
- **Second view** reads `GET /api/sessions` from inside the page and asserts the task exists with `turnCount === 1`.

Read `.verify-k5/<run-id>/ui/send-a-prompt/report.json`. Two entries are baseline and named in the flow: the WebSocket-close warning from `page.reload()` and the `/favicon.ico` 404. Anything else is a finding.

After the run, `$SKILL/scripts/check-seats.sh <run-id>` must report at most one harness child and a store inside the run directory. An orphaned ACP process is invisible in the UI.

## Gotchas

- The prompt string doubles as the stored task title, because k5 derives the title from the first prompt. A fixed string means a duplicate row and a confusing search result. The flow generates a timestamped one. A prompt longer than 120 graphemes is truncated with an ellipsis by `sanitizeTitle` (`session-store.ts:348`), so the flow's exact title match only holds for a short prompt.
- The trigger label says `Model. Current: not discovered yet` against the fake agent. That is correct: the harness advertised options with no `currentValue`, and the app refuses to name one rather than guessing the first entry. Asserting on that label asserts a lie.
- Menu items are `menuitemradio`, not `menuitem`. A select is a radio group.
- Reloading with the page mid-turn loses the live socket but not the store. Assert the store round trip after the turn has ended, or the row will exist with `turnCount` still unsettled.
- The fake agent returns its three text chunks instantly, so the streaming UI states (working dots, thought tail) can pass through between two polls. Drive those against the `slow` scenario, not this one.
- `XDG_DATA_HOME` controls where the store lands. Forgetting it points a verification run at the operator's real history in `~/.local/share/k5-work`.
- A drive interrupted mid-turn used to leave the seat holding its session, and the next browser on that instance was refused with `seat-busy` so its prompt never ran. That no longer happens: `session-service.ts:353` releases the seat when the socket closes and terminates the stored turn with `stopReason: "k5-cancelled"`, so a reload sees a finished turn rather than a spinning card. The one `seat-busy` that survives is per-connection (`session-service.ts:1037`, "this connection already holds a session"), which a reload cannot trigger. Keep reusing a run id only after `$SKILL/scripts/check-seats.sh` passes.

# Composer controls

Three things sit under the composer before any turn runs. The mode and permission pills say what the harness is about to be asked for, and the attachment tray carries files into the prompt. All three are visible from the empty state, so they are the cheapest thing to drive after project discovery and the first thing that proves a session is actually open.

## Sub-features

- `mode-pill` The session mode pill opens a radio group and names the mode the seat is running.
- `permissions-pill` The permissions pill opens a radio group whose options state what they allow.
- `posture-disclosure` With a session open, a `details` disclosure names what the resolved posture actually grants, or says every tool is allowed with no scope.
- `attach-pick` The `Attach files` button opens a file picker and each accepted file becomes a chip with its own remove control.
- `attach-drop` Dropping files on the composer adds them through the same path as the picker.
- `attach-refusal` A file the server refuses reports why in the composer and leaves the accepted chips alone.
- `remove-task` Each task row carries a `Remove {title}` button that deletes it from the store.

## How to get to it (user POV)

- The mode pill and the permissions pill sit below the composer, to the right of Send.
- Click `Attach files` beside the composer input to pick files, or drag files onto the composer.
- Click the `x` on a chip to drop one file before sending.
- Click `Remove {title}` on a task row in the sidebar to delete that task.

## Driving it with ui-verify

Preconditions: `$SKILL/scripts/launch.sh <run-id>` has run, `$SKILL/scripts/doctor.sh <run-id>` passed, and the harness is the in-repo fake agent on scenario `ok`. The mode, permissions and posture surfaces need a session open, so send one prompt first and let the turn end. Removing a task needs at least one stored task.

- **Mode** opens `[aria-label^="Session mode. Current:"]` and asserts a `role="menuitemradio"` is present. Against the fake agent no `currentMode` is advertised, so the trigger reads `Session mode. Current: not discovered yet`. Assert the menu opens and lists what the harness advertised, not a mode name.
- **Permissions** opens `[aria-label^="Permissions. Current:"]` and asserts a `menuitemradio` named `Full access` is present.
- **Posture** expands the `details` element whose summary mentions permissions and asserts it names the grant list or says every tool is allowed with no scope.
- **Attach by picker** clicks the button named `Attach files`, sets files on the hidden `Files to attach` input, and asserts one chip per file with a remove control named `Remove {file name}`. Clicking the visible button is what proves the user can reach the control.
- **Attach by drop** dispatches a `drop` on the composer with a file payload and asserts the same chip appears.
- **Refusal** attaches a file above the server's size budget and asserts the composer shows the refusal while the earlier chips stay.
- **Remove task** clicks `Remove {title}` on a stored row and asserts the row leaves the sidebar and `GET /api/sessions` no longer lists it.

Read `.verify-k5/<run-id>/ui/composer-controls/report.json`. The same two baseline entries apply as in the other flows: the WebSocket-close warning and the `/favicon.ico` 404. Anything else is a finding.

## Gotchas

- `Attach files` is a visible button that proxies a hidden `Files to attach` input. Driving the input directly proves the composer accepted bytes but not that the user can reach the control, so click the button and set the input from there.
- The mode trigger deliberately reads `not discovered yet` against the fake agent. Asserting a mode name asserts a guess the app is built not to make.
- Chips clear on a refusal only when the parent says the submission went out. A refused attach leaves the accepted chips in place, and a flow that assumes it cleared them will fail for the right reason.
- `Remove {title}` is only rendered when the caller passes a remove handler. Against a store with no tasks there is no button to drive, which is the same fresh-store trap as the two search empty states.
- The remove control is transparent until row hover on a fine pointer, and always visible on a coarse one. Playwright's click resolves it either way, but a screenshot taken without hovering will not show it.
- Attachments only reach the harness on a real send. To prove the harness received them, drive the `echo-blocks` scenario, not `ok`, and read the echoed blocks.

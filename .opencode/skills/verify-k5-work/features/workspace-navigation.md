# Workspace navigation

Before any agent runs, the user chooses which folder the work happens in and gets the workspace out of the way when they want to. This is the cheapest thing to drive and the first thing to drive when an instance looks wrong, because none of it starts a harness.

## Sub-features

- `discover` Project folders are discovered from disk and listed without a click.
- `auto-select` One project is selected on load, and the empty hero names it.
- `switch` Selecting another project renames the empty hero and the composer label.
- `open-path` An absolute or `~/`-relative path can be typed into the open-folder dialog.
- `open-refused` A path that is not a directory is refused in the dialog, in words.
- `collapse` The sidebar collapses to an icon rail and expands again, by button or `Ctrl+B`.
- `search` Typing in the search box filters the task list, and the empty state names which case it is: "No tasks yet." when the store is empty, "No matching tasks." when it holds something.

## How to get to it (user POV)

- Load the web app. Projects appear in the sidebar under the `Projects` heading.
- Click a project row to select it.
- Click the `+` beside the `Projects` heading, or `Open another folder…` in the composer's project menu, to type a path.
- Click `Collapse sidebar` (the `<` glyph) or press `Ctrl+B` to collapse, and `Expand sidebar` or `Ctrl+B` again to bring it back. The `K5` logo only expands: its handler is `if (!open) onToggle()`, so clicking it on an open sidebar does nothing. The flow drives the shortcut and waits for those two buttons.
- Type in the `Search tasks` box above the project list.

## Driving it with ui-verify

Preconditions: `$SKILL/scripts/launch.sh <run-id>` has run and `$SKILL/scripts/doctor.sh <run-id>` passed. No harness is needed for any of this, so the flow works even when `ACP_COMMAND` is unset.

```bash
source .verify-k5/<run-id>/env.sh
K5_VERIFY_REPO_ROOT="$PWD" ~/fleet/dev-workflow/ui-verify/scripts/ui-verify shoot \
  "$K5_VERIFY_WEB_URL" \
  --script "$SKILL/flows/workspace-navigation.mjs" \
  --out ".verify-k5/$K5_VERIFY_RUN_ID/ui/workspace-navigation" \
  --name nav --video
```

- **Discovery** waits for `section:has(h2:text-is("Projects")) ul button` and asserts at least one row.
- **Auto-select** reads the hero heading and asserts it names a real project, then asserts `[aria-label^="Project folder. Current:"]` agrees. Two surfaces, one fact.
- **Switch** clicks a different project row and asserts the hero heading renames. Skipped with a log line when only one project was discovered.
- **Open path** fills `/definitely/not/a/real/folder/xyz` and asserts `#path-dialog-error` reads "Folder not found or is not a directory". The server answers 404 here by design, so a `[httperror] 404 /api/projects/open` in the report is this assertion, not a defect.
- **Accepted path** fills `K5_VERIFY_REPO_ROOT` and asserts the dialog closes with a project selected. The repo root is always a valid project, so this needs no seeding.
- **Collapse** presses `Ctrl+B` twice and asserts the `aside` width drops from about 276px to 68px and comes back. Both ends of the door in one run.
- **Search** fills the box with a string no task contains and asserts the empty state matches the row count it started from: "No tasks yet." at zero rows, "No matching tasks." otherwise. It then clears the box and asserts the row count did not shrink.

## Gotchas

- The expanded sidebar labels its sections with an `h2` heading and only switches to `aria-label` once collapsed to the icon rail. A `section[aria-label="Projects"]` selector matches nothing in the default state and the flow times out with no useful message.
- Project rows in the expanded sidebar have no accessible name of their own; their name comes from the visible folder name and path. Filter with `hasNotText` rather than reaching for an aria-label that is not there.
- The `+` button beside the `Projects` heading and the `Open another folder…` menu item are the same dialog through two entry points. Driving one does not prove the other; both are listed above so a caller can pick.
- `Ctrl+B` collapses on both `Ctrl` and `Meta`, so the shortcut works on a Mac keyboard without a second binding.
- The sidebar width animates over 320ms while the collapse button renders immediately. Reading `boundingBox()` once reports a mid-transition number such as 74px for a sidebar heading to 276px. The flow polls until two consecutive reads agree.
- The two search empty states are different strings and both are correct. A flow that only ever sees one of them will fail on a fresh store, so assert against the row count rather than a fixed string.
- The sidebar hides on narrow viewports after an action, because `runAndClose` closes it below the `lg` breakpoint. A flow that clicks a project at 390px width then asserts the sidebar still shows it will fail for a reason that is correct behavior.
- Discovery scans the parent directory plus `~/code`, `~/Projects`, `~/dev`, `~/Work`, capped per root. On a machine with many worktrees the sidebar shows only the first six and a "+N more projects" line. Assert on "at least one", never on an exact count.

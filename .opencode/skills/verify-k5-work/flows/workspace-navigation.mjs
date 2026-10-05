// Flow: the parts of the workspace a user touches before any agent runs.
//
// Project discovery and selection, opening a folder by path including the
// refusal path, the sidebar collapse, and task search. None of this starts a
// harness, so it is the cheapest thing to drive and the first thing to drive when
// the instance itself looks wrong.
//
// The 404 on POST /api/projects/open that this flow provokes is the folder
// refusal assertion, not a defect. It is the only unexpected entry expected in
// report.json; see the baseline list in SKILL.md.

export default async ({ page, shot, log, assert }) => {
  // 1. Projects are discovered from disk and offered without a click.
  //
  // Addressed through the "Projects" heading, not through an aria-label on the
  // section. The expanded sidebar labels its sections with headings and only
  // labels them with aria-label once collapsed to the icon rail, so an
  // aria-label selector silently matches nothing in the default state.
  await page.locator('#composer-input').waitFor({ timeout: 20000 });
  const projects = page
    .locator('section:has(h2:text-is("Projects")) ul button')
    .filter({ hasNot: page.locator('[aria-label="Open project folder"]') });
  await projects.first().waitFor({ timeout: 15000 });
  const count = await projects.count();
  assert(count > 0, `sidebar lists ${count} discovered project(s)`);

  const hero = (await page.getByRole('heading', { name: /What should we build in/ }).textContent()) ?? '';
  const activeName = hero.replace('What should we build in', '').replace('?', '').trim();
  assert(activeName.length > 0, `a project is selected without a click (${activeName})`);

  // The composer mirrors the selection. Two sources, one fact.
  const projectMenu = page.locator('[aria-label^="Project folder. Current:"]');
  const menuLabel = await projectMenu.getAttribute('aria-label');
  assert(
    (menuLabel ?? '').includes(activeName),
    `composer agrees with the sidebar about the project (${menuLabel})`,
  );
  await shot('01-projects-discovered');

  // 2. Switching project renames the hero. The empty state must follow the
  //    selection, not keep the name it was rendered with.
  if (count > 1) {
    const other = projects.filter({ hasNotText: activeName }).first();
    const otherName = ((await other.innerText()) ?? '').split('\n')[0].trim();
    await other.click();
    const renamed = page.getByRole('heading', { name: `What should we build in ${otherName}?` });
    await renamed.waitFor({ timeout: 10000 });
    assert(true, `selecting ${otherName} renames the empty hero`);
    await shot('02-project-switched');
  } else {
    log(`only one project discovered, skipping the switch (${activeName})`);
  }

  // 3. The open-folder dialog refuses a path that is not a directory, and says so
  //    in the dialog rather than in a console log.
  await page.locator('button[aria-label="Open project folder"]').first().click();
  const dialog = page.getByRole('dialog', { name: 'Open project folder' });
  await dialog.waitFor({ timeout: 10000 });
  await shot('03-open-folder-dialog');

  await dialog.getByPlaceholder('/path/to/project').fill('/definitely/not/a/real/folder/xyz');
  await dialog.getByRole('button', { name: 'Open folder' }).click();
  const refusal = dialog.locator('#path-dialog-error');
  await refusal.waitFor({ timeout: 15000 });
  assert(
    /not found|not a directory/i.test((await refusal.textContent()) ?? ''),
    `a bad path is refused in the dialog (${(await refusal.textContent())?.trim()})`,
  );
  await shot('04-open-folder-refused');

  // 4. A real path is accepted and becomes the selection. The repo root is
  //    always a valid project, so this never depends on seeded state.
  const repoRoot = process.env.K5_VERIFY_REPO_ROOT;
  if (repoRoot) {
    await dialog.getByPlaceholder('/path/to/project').fill(repoRoot);
    await dialog.getByRole('button', { name: 'Open folder' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20000 });
    const nowSelected = ((await page.getByRole('heading', { name: /What should we build in/ }).textContent()) ?? '')
      .replace('What should we build in', '').replace('?', '').trim();
    assert(
      nowSelected.length > 0 && nowSelected !== 'your project',
      `opening a folder by path selects it (${nowSelected})`,
    );
    await shot('05-folder-opened');
  } else {
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    log('K5_VERIFY_REPO_ROOT unset, skipped the accepted-path case');
  }

  // 5. The sidebar collapses to an icon rail and comes back. Both ends of the
  //    door, in one run.
  const sidebar = page.locator('aside[aria-label="Workspace sidebar"]');
  const wideBefore = await settledWidth(sidebar);
  await page.keyboard.press('Control+b');
  await page.locator('button[aria-label="Expand sidebar"]').waitFor({ timeout: 10000 });
  const narrow = await settledWidth(sidebar);
  assert(narrow < wideBefore, `Ctrl+B collapses the sidebar (${Math.round(wideBefore)}px to ${Math.round(narrow)}px)`);
  await shot('06-sidebar-collapsed');

  await page.keyboard.press('Control+b');
  await page.locator('button[aria-label="Collapse sidebar"]').waitFor({ timeout: 10000 });
  const wideAgain = await settledWidth(sidebar);
  assert(wideAgain > narrow, `Ctrl+B expands it again (${Math.round(wideAgain)}px)`);
  await shot('07-sidebar-expanded');

  // 6. Search filters the task list, and the empty state names which case it is.
  //    "No tasks yet." and "No matching tasks." are both honest, and which one
  //    appears depends on whether the store holds anything. Asserting the wrong
  //    one makes this flow pass only on a machine that has run a turn before.
  const search = page.locator('input[aria-label="Search tasks"]');
  await search.waitFor({ timeout: 10000 });
  const rowsBefore = await taskRows(page).count();

  await search.fill('zzz-no-such-task-zzz');
  const emptyState = page.getByText(/^No (matching tasks|tasks yet)\.$/);
  await emptyState.waitFor({ timeout: 10000 });
  const words = (await emptyState.textContent())?.trim() ?? '';
  assert(
    rowsBefore === 0 ? words === 'No tasks yet.' : words === 'No matching tasks.',
    `a search with no hits names the case it is in (${words}, ${rowsBefore} rows before)`,
  );
  assert(await taskRows(page).count() === 0, 'no task rows survive a search with no hits');
  await shot('08-search-no-match');

  await search.fill('');
  await page.waitForTimeout(200);
  const rowsAfter = await taskRows(page).count();
  assert(rowsAfter >= rowsBefore, `clearing the search restores the list (${rowsBefore} then ${rowsAfter})`);
};

/**
 * Read a width after the sidebar's 320ms transition has stopped moving.
 *
 * The collapse and expand buttons render the instant the state flips, so a
 * single boundingBox read lands mid-animation and reports 74px for a sidebar
 * that is on its way to 276. Polling until two consecutive reads agree is what
 * makes the number mean something.
 */
async function settledWidth(locator) {
  let previous = -1;
  for (let i = 0; i < 40; i++) {
    const width = (await locator.boundingBox())?.width ?? 0;
    if (Math.abs(width - previous) < 0.5) return width;
    previous = width;
    await new Promise((r) => setTimeout(r, 50));
  }
  return previous;
}

/**
 * Task rows are the sidebar buttons that end in a turn count. Matching on that
 * suffix rather than on a class keeps the locator honest about what a user sees.
 */
function taskRows(page) {
  return page.locator('section:has(h2:text-is("Tasks")) ul button').filter({
    hasText: /^\s*\S.*\n?\s*\d+ turns?\s*$/,
  });
}

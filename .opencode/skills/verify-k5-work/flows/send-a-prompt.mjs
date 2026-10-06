// Flow: send one prompt and watch a whole turn land.
//
// Proves the seat opens lazily on the first prompt, the harness streams back, the
// answer reaches the transcript, the tool card settles, and the turn survives a
// reload because the store recorded it.
//
// Driven against the in-repo deterministic agent (fake-agent `ok` scenario), so
// the expected answer is "first second third" and the expected tool card is
// "read file: Completed". A run against a real harness changes those two strings
// and nothing else; update EXPECTED_* below when you do that on purpose.
//
// ui-verify records every console error, failed request and page exception into
// report.json, and two entries are baseline here: the WebSocket-close warning
// that page.reload() causes, and the 404 for /favicon.ico. Anything else in that
// report is a finding. The list lives in SKILL.md and features/README.md, not
// here, so it has one home.

const EXPECTED_ANSWER = process.env.K5_VERIFY_ANSWER || 'first second third';
const EXPECTED_TOOL = process.env.K5_VERIFY_TOOL || 'read file: Completed';

const PROMPT = process.env.K5_VERIFY_PROMPT
  || `verify ${new Date().toISOString().slice(11, 19)} list the project files`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default async ({ page, shot, log, assert }) => {
  log(`prompt: ${PROMPT}`);

  // 1. Empty hero. A project auto-selects from discovery, so the heading names
  //    one without the user having touched anything.
  await page.locator('#composer-input').waitFor({ timeout: 20000 });
  const hero = page.getByRole('heading', { name: /What should we build in/ });
  assert(await hero.isVisible(), 'empty hero offers a prompt');
  const heroText = (await hero.textContent()) ?? '';
  assert(!/your project/.test(heroText), `a real project is selected (${heroText.trim()})`);
  await shot('01-empty-hero');

  // 2. Type and send. Enter is the real user path; the Send button is disabled
  //    until there is text, so the button click doubles as the assertion that the
  //    composer accepted input.
  await page.locator('#composer-input').fill(PROMPT);
  await page.locator('button[aria-label="Send message"]').waitFor();
  await page.locator('button[aria-label="Send message"]').click();

  // 3. The prompt is on screen as the user's own bubble before any answer
  //    arrives. Screenshot here so the artifact shows the action, not only the
  //    result.
  await page.getByText(PROMPT, { exact: false }).first().waitFor({ timeout: 30000 });
  await shot('02-prompt-sent');

  // 4. The harness answer, chunked and reassembled.
  await page.getByText(EXPECTED_ANSWER, { exact: false }).first()
    .waitFor({ timeout: 45000 });
  assert(true, `agent answer "${EXPECTED_ANSWER}" reached the transcript`);

  // 5. The tool call settled, not left spinning.
  const card = page.locator(`ul[aria-label="Tool calls in this turn"] li[aria-label="${escapeRe(EXPECTED_TOOL)}"]`);
  await card.waitFor({ timeout: 20000 });
  assert(await card.count() === 1, `tool card settled as "${EXPECTED_TOOL}"`);

  // 6. The turn is over: the working dots are gone and the composer is empty and
  //    disabled again.
  await page.locator('[aria-label="The agent is working"]').waitFor({ state: 'detached', timeout: 20000 })
    .catch(() => assert(false, 'working indicator went away'));
  const sendDisabled = await page.locator('button[aria-label="Send message"]').isDisabled();
  assert(sendDisabled, 'composer cleared itself when the turn ended');

  // 7. Models come from the harness, never from a hardcoded list. Open the menu
  //    and read what is in it. The trigger deliberately says "not discovered yet"
  //    rather than naming the first entry, because this harness advertises no
  //    currentValue, so an assertion on the trigger label would be asserting a
  //    guess the app is built not to make.
  const modelTrigger = page.locator('[aria-label^="Model. Current:"]');
  assert(!(await modelTrigger.isDisabled()), 'model menu is enabled once the session is open');
  await modelTrigger.click();
  // menuitemradio, not menuitem: a select is a radio group, and aria-checked
  // marks which one the seat is running.
  const modelItem = page.getByRole('menuitemradio', { name: 'OpenCode Zen/Space Bunny Free' });
  await modelItem.waitFor({ timeout: 10000 });
  assert(await modelItem.count() === 1, 'model menu lists a value the harness advertised');
  await shot('03-model-menu');
  await page.keyboard.press('Escape');
  await shot('04-answer-landed');

  // 8. The durable side. Reload and the task must still be there, which means the
  //    store wrote it and /api/sessions read it back.
  await page.reload();
  const row = page.getByRole('button', { name: new RegExp(escapeRe(PROMPT)) });
  await row.first().waitFor({ timeout: 20000 });
  assert(await row.count() >= 1, 'the task is listed in the sidebar after a reload');
  await shot('05-task-in-sidebar');

  // 9. Reopening it puts the recorded conversation back on screen.
  await row.first().click();
  await page.getByText(EXPECTED_ANSWER, { exact: false }).first()
    .waitFor({ timeout: 30000 });
  assert(true, 'reopening the task shows its recorded answer');
  await shot('06-task-reopened');

  // 10. Read-only second view of the stored state, so the proof does not rest on
  //     the UI alone.
  const listed = await page.evaluate(async () => {
    const res = await fetch('/api/sessions', { headers: { Accept: 'application/json' } });
    return res.json();
  });
  const hit = (listed.sessions ?? []).find((s) => s.title === PROMPT);
  assert(!!hit, `GET /api/sessions lists the task (${(listed.sessions ?? []).length} stored)`);
  assert(hit?.turnCount === 1, `the task records exactly one turn (got ${hit?.turnCount})`);
};

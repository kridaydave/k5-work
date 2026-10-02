import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { AcpSeat, type SeatStreamEvent, type SeatStopReason } from "./acp-seat.js";
import { spawnAcpChild, type AcpChild } from "./spawn.js";

// The regression this file exists for, against the real binary.
//
// Before d00f588, acp-seat.ts armed CANCEL_DRAIN_MS (5s) at the START of every
// turn, so any turn slower than five seconds was force-settled as "cancelled"
// with its answer truncated mid-word, and the seat was poisoned with "harness
// did not stop after a cancel" so every later prompt was refused. Real OpenCode
// turns on this machine were measured at 4.25s, 6.84s and 16.44s, so nearly all
// of them were being killed.
//
// The 221-test server suite cannot see this: every seat test drives
// fake-agent.ts, which answers in milliseconds and therefore never reaches the
// five-second boundary. A green suite here is evidence about the fake, not about
// OpenCode. So this file drives the real binary and makes the turn honestly slow
// by asking the model for real work — no sleep, no injected latency, no
// assertion on wall-clock duration. The assertions are about what was observed:
// the stop reason the harness's own prompt response produced, the text that
// actually arrived, and whether a second turn can still run on the same seat.
//
// Duration is measured and reported through t.diagnostic only. Asserting a
// duration would be a flaky assertion about the maintainer's machine; asserting
// that it EXCEEDED five seconds is defensible only as an observation, and it is
// recorded as one.

const OPENCODE_ARGV = ["opencode", "acp"];
// A cold `session/new` against a real harness routinely takes tens of seconds.
const OPEN_TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 150_000;
const TEST_TIMEOUT_MS = 240_000;

/**
 * Turn one has to make the model work for it. Listing 78 primes from memory is
 * genuinely slow and produces a long, highly structured answer, which is
 * exactly the shape that a five-second force-settle truncates: the answer
 * arrives as a bare prefix of a list.
 */
const SLOW_TURN_TEXT =
  "Do not call any tools. From memory, list every prime number less than 400, " +
  "one per line, in ascending order, with no commentary and no other text. " +
  "After the final prime, output one last line that reads exactly: END OF LIST";

/** Turn two only has to prove the seat is still usable after a slow turn one. */
const SECOND_TURN_TEXT =
  "Do not call any tools. Reply with exactly this one line and nothing else: ACK 7F3A9";

const SENTINEL = /END OF LIST/i;
/** The largest prime below 400; its presence proves the tail of the list arrived. */
const LARGEST_PRIME = 397;
/** pi(400) = 78. A floor, so one stray or reformatted line does not decide it. */
const PRIME_FLOOR = 76;

function opencodeRunnable(): boolean {
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

function requireOpencode(t: TestContext): boolean {
  if (opencodeRunnable()) return true;
  t.skip(
    "opencode is not runnable here, so there is no real harness and no real turn to put past the five-second boundary; the fake-agent suite cannot cover this",
  );
  return false;
}

/**
 * A JSON-RPC failure raised by the harness or its model provider, as opposed to
 * a failure of this code.
 *
 * These are skipped with the reason attached, because a suite that goes red
 * whenever the provider is unwell tells nobody anything about acp-seat.ts. A
 * "cancelled" stop reason is deliberately NOT in this class: that is the bug
 * under test and it is asserted as a failure.
 */
function looksLikeProviderFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /auth|credential|api key|unauthor|forbidden|provider|model|OpenCode service|429|rate.?limit|quota|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|socket hang up/i.test(
    text,
  );
}

interface TurnOutcome {
  readonly turnId: string;
  /** Absent only when the turn threw; see the provider-failure classification. */
  readonly stop: SeatStopReason | null;
  readonly text: string;
  readonly durationMs: number;
  readonly error: unknown;
  /** Whether the seat was still usable at the instant the turn returned. */
  readonly seatPoisoned: boolean;
  readonly seatBusy: boolean;
}

interface Rig {
  readonly cwd: string;
  readonly child: AcpChild;
  readonly seat: AcpSeat;
  readonly pid: number | undefined;
  /** Live text per turn id, so a second turn cannot be scored on the first's. */
  readonly textByTurn: Map<string, string[]>;
}

let rigPromise: Promise<Rig> | null = null;

/**
 * One real harness, one real seat, for the whole file.
 *
 * A single seat is the point: "the seat is still usable" is a claim about this
 * exact object after this exact slow turn, and a second seat would prove nothing.
 */
function buildRig(): Promise<Rig> {
  rigPromise ??= (async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "k5-slow-turn-"));
    const child = await spawnAcpChild({ argv: OPENCODE_ARGV, cwd });
    const textByTurn = new Map<string, string[]>();
    const seat = await AcpSeat.open(
      child,
      { cwd, openTimeoutMs: OPEN_TIMEOUT_MS, turnTimeoutMs: TURN_TIMEOUT_MS },
      (turnId: string, event: SeatStreamEvent) => {
        if (event.kind !== "text") return;
        const chunks = textByTurn.get(turnId) ?? [];
        chunks.push(event.text);
        textByTurn.set(turnId, chunks);
      },
    );
    return { cwd, child, seat, pid: child.pid, textByTurn };
  })();
  return rigPromise;
}

const turnPromises = new Map<string, Promise<TurnOutcome>>();

/**
 * Runs one real turn and records what came back, asserting nothing.
 *
 * Memoised per turn id so each `it` below is self-sufficient: a test selected on
 * its own name still runs its own turn, and the shared seat is only ever driven
 * once per turn.
 */
function runTurn(rig: Rig, turnId: string, text: string): Promise<TurnOutcome> {
  const existing = turnPromises.get(turnId);
  if (existing !== undefined) return existing;
  const started = performance.now();
  const run = (async (): Promise<TurnOutcome> => {
    try {
      const stop = await rig.seat.prompt(turnId, [{ type: "text", text }]);
      return {
        turnId,
        stop,
        text: (rig.textByTurn.get(turnId) ?? []).join(""),
        durationMs: Math.round(performance.now() - started),
        error: null,
        seatPoisoned: rig.seat.poisoned,
        seatBusy: rig.seat.busy,
      };
    } catch (err) {
      return {
        turnId,
        stop: null,
        text: (rig.textByTurn.get(turnId) ?? []).join(""),
        durationMs: Math.round(performance.now() - started),
        error: err,
        seatPoisoned: rig.seat.poisoned,
        seatBusy: rig.seat.busy,
      };
    }
  })();
  turnPromises.set(turnId, run);
  return run;
}

function report(t: TestContext, outcome: TurnOutcome): void {
  t.diagnostic(
    `${outcome.turnId}: stopReason=${String(outcome.stop)} in ${String(outcome.durationMs)}ms, ` +
      `${String(outcome.text.length)} chars, seatPoisoned=${String(outcome.seatPoisoned)}`,
  );
  if (outcome.error !== null) {
    t.diagnostic(`${outcome.turnId} threw: ${outcome.error instanceof Error ? outcome.error.stack ?? outcome.error.message : String(outcome.error)}`);
  }
}

/**
 * Skips this test when the turn failed for a reason that is not this code.
 * Returns the outcome so the caller can keep asserting when the failure WAS
 * ours, which is why a non-provider error is rethrown rather than swallowed.
 */
function settleOutcome(t: TestContext, outcome: TurnOutcome, rig: Rig): TurnOutcome {
  report(t, outcome);
  if (outcome.error === null) return outcome;
  const stderr = rig.child.stderrTail().trim();
  if (!looksLikeProviderFailure(outcome.error)) {
    throw outcome.error;
  }
  t.skip(
    `the real turn failed before any answer for a provider or harness reason, which is not a contract of acp-seat.ts: ` +
      `${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}` +
      (stderr.length > 0 ? ` | harness stderr: ${stderr.slice(-400)}` : ""),
  );
  return outcome;
}

/** The answer's lines, minus a markdown fence and minus blank lines. */
function answerLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "```" && !/^```[a-z]*$/i.test(line));
}

/** The numbers the model actually emitted, in order, as written. */
function numericLines(text: string): string[] {
  return answerLines(text).filter((line) => /^\d{1,4}[.,)]?$/.test(line));
}

describe("a turn slower than five seconds against a real opencode", () => {
  after(async () => {
    const rig = await rigPromise?.catch(() => null);
    if (rig === null || rig === undefined) return;
    await rig.seat.close();
    const closed = await rig.child.close();
    rmSync(rig.cwd, { recursive: true, force: true });
    // A harness that did not die is a real orphan on the maintainer's machine,
    // so this is asserted rather than logged.
    assert.equal(
      closed.reaped,
      true,
      `harness pid ${String(rig.pid)} was not reaped, so a real opencode process was left running`,
    );
  });

  it(
    "completes a real turn that outlasts the old five-second drain",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      if (!requireOpencode(t)) return;
      const rig = await buildRig();
      const outcome = settleOutcome(t, await runTurn(rig, "slow-1", SLOW_TURN_TEXT), rig);

      // The load-bearing assertion. Pre-fix this returned "cancelled" for a turn
      // the harness itself finished with end_turn, purely because the seat gave
      // up at five seconds.
      assert.notEqual(
        outcome.stop,
        "cancelled",
        "a turn that was never cancelled came back as \"cancelled\": the five-second drain is being armed somewhere it must not be",
      );
      assert.equal(
        outcome.stop,
        "end_turn",
        `the real harness's own prompt response did not report a completion (observed ${String(outcome.stop)} after ${String(outcome.durationMs)}ms)`,
      );

      // A force-settle also leaves the seat unusable, which is the other half of
      // the original report.
      assert.equal(outcome.seatPoisoned, false, "a completed turn must not poison the seat");
      assert.equal(outcome.seatBusy, false, "the seat still holds a turn after a terminal stop reason");

      // Observation, not assertion: the whole point is that this outlasted five
      // seconds, and a loaded machine can only make that more true.
      t.diagnostic(`measured turn 1 at ${String(outcome.durationMs)}ms (CANCEL_DRAIN_MS was 5000)`);
    },
  );

  it(
    "receives the whole answer, not a prefix cut off mid-list",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      if (!requireOpencode(t)) return;
      const rig = await buildRig();
      const outcome = settleOutcome(t, await runTurn(rig, "slow-1", SLOW_TURN_TEXT), rig);

      assert.notEqual(
        outcome.stop,
        "cancelled",
        "cannot judge completeness of a turn the seat abandoned early",
      );

      const text = outcome.text;
      assert.ok(
        text.trim().length > 0,
        `no text arrived at all for a real turn that reported ${String(outcome.stop)}`,
      );
      t.diagnostic(`verbatim first answer (${String(text.length)} chars):\n${text}`);

      // A prefix of a prime list is still a list of primes, so counting lines is
      // not enough on its own. The sentinel the prompt asked for only appears if
      // the model reached the end of its own answer, so it is the honest
      // completeness check: truncation anywhere before it loses it.
      const lines = answerLines(text);
      const last = lines[lines.length - 1] ?? "";
      assert.match(
        last,
        SENTINEL,
        `the answer does not end with the "END OF LIST" sentinel the prompt asked for, so it was cut off early; observed last line: ${JSON.stringify(last)}`,
      );

      // And the body is whole, not just the sentinel: the whole prime list plus
      // the sentinel is a shape truncation cannot fake.
      const numbers = numericLines(text);
      assert.ok(
        numbers.length >= PRIME_FLOOR,
        `expected at least ${String(PRIME_FLOOR)} prime lines, saw ${String(numbers.length)}: the answer is truncated`,
      );
      assert.equal(numbers[0], "2", "the list must start at the first prime");
      assert.ok(
        numbers.includes(String(LARGEST_PRIME)),
        `the largest prime below 400 (${String(LARGEST_PRIME)}) is missing, so the tail of the list never arrived`,
      );
      t.diagnostic(
        `observed ${String(numbers.length)} numeric line(s), first=${String(numbers[0])}, last=${String(numbers[numbers.length - 1])}`,
      );
    },
  );

  it(
    "leaves the seat usable for a second turn on the same seat",
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      if (!requireOpencode(t)) return;
      const rig = await buildRig();
      // Run the slow turn first on this same seat, so "after a slow turn" is a
      // fact about the object under test and not an assumption about test order.
      const first = settleOutcome(t, await runTurn(rig, "slow-1", SLOW_TURN_TEXT), rig);
      assert.notEqual(first.stop, "cancelled", "the first turn did not complete, so there is nothing to recover from");

      const second = settleOutcome(t, await runTurn(rig, "slow-2", SECOND_TURN_TEXT), rig);

      assert.equal(
        second.stop,
        "end_turn",
        `a second turn on the same seat after a slow first turn reported ${String(second.stop)} instead of a completion`,
      );
      assert.equal(
        second.seatPoisoned,
        false,
        "the seat is poisoned after a slow turn followed by a second turn",
      );
      assert.equal(second.seatBusy, false, "the seat still holds a turn after the second completion");

      assert.ok(
        second.text.includes("ACK 7F3A9"),
        `the second turn's answer did not arrive intact; observed: ${JSON.stringify(second.text.slice(0, 400))}`,
      );
      t.diagnostic(`verbatim second answer: ${second.text}`);
    },
  );
});

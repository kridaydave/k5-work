import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawnAcpChild, type AcpChild } from "./spawn.js";
import { AcpSeat, AcpSeatError, type SeatStreamEvent } from "./acp-seat.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.js", import.meta.url));

interface SeatRig {
  readonly child: AcpChild;
  readonly seat: AcpSeat;
  readonly cwd: string;
  close(): Promise<void>;
}

async function startRig(
  scenario: string,
  mode: "new" | "headless" = "headless",
  onEvent: ((turnId: string, event: SeatStreamEvent) => void) | null = null,
): Promise<SeatRig> {
  const cwd = mkdtempSync(path.join(tmpdir(), "k5-lifecycle-"));
  const child = await spawnAcpChild({
    argv: [process.execPath, FAKE_AGENT, scenario],
    cwd,
  });
  const seat =
    mode === "headless"
      ? await AcpSeat.openHeadless(child, { cwd }, onEvent)
      : await AcpSeat.open(child, { cwd }, onEvent);
  return {
    child,
    seat,
    cwd,
    async close() {
      await seat.close();
      await child.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("a harness that flushes a chunk after its response leaves the seat usable", async () => {
  // ACP lets an agent answer session/prompt and then send trailing
  // notifications. The seat's own comments say the response alone cannot be
  // treated as proof the stream is finished, so a chunk that lands just after it
  // is ordinary, not misbehaviour. Poisoning the seat here meant one legal
  // trailing chunk killed every later prompt for the rest of the session.
  const seen: string[] = [];
  const rig = await startRig("trailing-update", "headless", (_turnId, event) => {
    if (event.kind === "text") seen.push(event.text);
  });
  try {
    await rig.seat.adopt("fake-session-1");

    const first = await rig.seat.prompt("t-1", [{ type: "text", text: "one" }]);
    assert.equal(first, "end_turn");

    // Long enough for the 60ms trailing chunk to have been read by the pump and
    // routed. It has no live turn, so it lands on the straggler path.
    await delay(300);

    assert.equal(
      rig.seat.poisoned,
      false,
      "a trailing chunk after the response must not poison the seat",
    );

    // And the seat must still take work, which is what a poisoned seat refuses.
    const second = await rig.seat.prompt("t-2", [{ type: "text", text: "two" }]);
    assert.equal(second, "end_turn");
    assert.equal(rig.seat.poisoned, false);
  } finally {
    await rig.close();
  }
});

test("the last chunk of an answer is recorded inside its own turn", async () => {
  // The turn was ended by the prompt response while the final chunk was still
  // in flight, so the chunk landed after turn.completed and the transcript read
  // back one word short of what the harness said. ACP does not promise the
  // response is last on the wire, so the end has to wait for a quiet stream.
  const seen: string[] = [];
  const rig = await startRig("trailing-update", "headless", (_turnId, event) => {
    if (event.kind === "text") seen.push(event.text);
  });
  try {
    await rig.seat.adopt("fake-session-1");
    const stop = await rig.seat.prompt("t-1", [{ type: "text", text: "hello" }]);
    assert.equal(stop, "end_turn");
    // Long enough for the harness's post-response chunk to have been read,
    // routed, and either kept or dropped.
    await delay(400);
    assert.equal(
      seen.join(""),
      "one last trailing chunk",
      "a chunk sent after the response must still be recorded on the turn",
    );
    assert.equal(rig.seat.poisoned, false);
  } finally {
    await rig.close();
  }
});

test("a harness that ignores a cancel and keeps streaming still poisons the seat", async () => {
  // The reason the straggler path exists at all. `slow` holds its response past
  // the cancel, so it keeps streaming after the grace window closes. That seat
  // must be refused rather than trusted with a stream nothing can be attributed
  // to. This is the case hazard one must not fix by deleting the check.
  const rig = await startRig("slow", "headless");
  try {
    await rig.seat.adopt("fake-session-1");
    const turn = rig.seat.prompt("t-1", [{ type: "text", text: "go" }]);
    await delay(100);
    assert.equal(rig.seat.cancel(), true, "a running turn can be cancelled");

    // Past the drain window, so the poison is earned rather than a stray chunk.
    await assert.rejects(
      () => rig.seat.prompt("t-2", [{ type: "text", text: "again" }]),
      AcpSeatError,
      "a turn is already running or the seat is unusable",
    );
    await turn.catch(() => undefined);
  } finally {
    await rig.close();
  }
});

test("close resolves only after the child is gone, with no orphan left behind", async () => {
  // close() tore the connection down and awaited the child, but it never awaited
  // the update pump. The pump holds a pending nextUpdate() that no abort
  // releases, so it stayed alive across the close and could still call onEvent
  // for a seat the service had already disposed. The guarantee a caller needs
  // is that nothing can emit into a closed seat.
  const emitted: string[] = [];
  const rig = await startRig("ok", "headless", (_turnId, event) => {
    emitted.push(event.kind);
  });
  try {
    await rig.seat.adopt("fake-session-1");
    await rig.seat.prompt("t-1", [{ type: "text", text: "go" }]);
    await delay(200);
    assert.equal(rig.seat.pumping, true, "a prompted seat is reading its stream");

    await rig.seat.close();

    // The load-bearing assertion. close() used to fire-and-forget the pump, so
    // it resolved while the pump was still mid-read against a dying child. That
    // window is where a late update reaches onEvent for a seat the service has
    // already disposed.
    assert.equal(
      rig.seat.pumping,
      false,
      "close() must not resolve while the update pump is still running",
    );
    assert.equal(rig.seat.busy, false, "a closed seat holds no turn");
    await assert.rejects(
      () => rig.seat.prompt("t-2", [{ type: "text", text: "after close" }]),
      /seat is closed/,
      "a closed seat refuses further work",
    );

    // Anything emitted after close resolved would land on a torn-down connection.
    await delay(300);
    const afterClose = emitted.length;
    await delay(300);
    assert.equal(emitted.length, afterClose, "nothing may be emitted once close resolves");
  } finally {
    await rig.child.close();
    rmSync(rig.cwd, { recursive: true, force: true });
  }
});

test("closing a seat twice is not an error", async () => {
  const rig = await startRig("ok", "headless");
  try {
    await rig.seat.adopt("fake-session-1");
    await rig.seat.close();
    await rig.seat.close();
  } finally {
    await rig.child.close();
    rmSync(rig.cwd, { recursive: true, force: true });
  }
});
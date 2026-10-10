import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAcpChild, type AcpChild } from "./spawn.js";
import { AcpCapabilityError, AcpSeat, type SeatStreamEvent } from "./acp-seat.js";
import { probeCapabilities } from "./capabilities.js";
import { initializeResult } from "./fake-agent.js";

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
  const cwd = mkdtempSync(path.join(tmpdir(), "k5-caps-"));
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

// --- the capability probe, which is where a wrong answer becomes a wrong call ---

test("capabilities are read leniently off the raw initialize result", () => {
  // The real OpenCode 2.0.24 shape, from a live probe.
  const real = probeCapabilities(initializeResult("ok"));
  assert.equal(real.loadSession, true);
  assert.equal(real.resume, true);
  assert.equal(real.close, true);
  assert.equal(real.image, true);
  assert.equal(real.embeddedContext, true);
  assert.deepEqual(real.mismatches, []);

  // Absent means unsupported, and `{}` means supported.
  const empty = probeCapabilities({ agentCapabilities: { sessionCapabilities: { resume: {} } } });
  assert.equal(empty.loadSession, false);
  assert.equal(empty.resume, true);
  assert.equal(empty.close, false);

  // A harness that advertises nothing at all.
  assert.equal(probeCapabilities({}).loadSession, false);
  assert.equal(probeCapabilities({ agentCapabilities: null }).resume, false);
  assert.equal(probeCapabilities(null).loadSession, false);
  assert.equal(probeCapabilities("nonsense").resume, false);
});

test("a mis-shaped capability is reported and treated as unsupported, never thrown", () => {
  // The SDK's generated schema wraps every field in .catch(), so these lose
  // their capability silently. A strict k5 parse would instead fail the seat
  // open entirely, bricking a harness that merely spelled it differently.
  const weird = probeCapabilities(initializeResult("weird-caps"));
  assert.equal(weird.loadSession, false, 'a string "true" is not a boolean');
  assert.equal(weird.resume, false);
  assert.deepEqual([...weird.mismatches].sort(), [
    "loadSession",
    "sessionCapabilities.resume",
  ]);

  // A garbage capability block must degrade, not throw.
  const garbage = probeCapabilities({ agentCapabilities: 7 });
  assert.equal(garbage.loadSession, false);
  assert.deepEqual(garbage.mismatches, ["agentCapabilities"]);
});

// --- gates, end to end against a real child process ---

test("a seat reports the harness's real capabilities", async () => {
  const rig = await startRig("ok");
  try {
    assert.equal(rig.seat.capabilities.loadSession, true);
    assert.equal(rig.seat.capabilities.resume, true);
  } finally {
    await rig.close();
  }
});

test("a harness advertising none of them gates every method", async () => {
  const rig = await startRig("no-session-caps");
  try {
    const caps = rig.seat.capabilities;
    assert.equal(caps.loadSession, false);
    assert.equal(caps.resume, false);
    // The spec is explicit that a client MUST NOT call a method the agent did
    // not advertise, so the gate fires before the wire.
    await assert.rejects(
      () => rig.seat.adopt("fake-session-1"),
      (error: unknown) => error instanceof AcpCapabilityError && error.capability === "resume",
    );
  } finally {
    await rig.close();
  }
});

test("a mis-shaped capability block opens the seat and refuses the method", async () => {
  // The seat must still open: a harness that advertises badly is not a harness
  // that cannot be talked to.
  const rig = await startRig("weird-caps");
  try {
    assert.equal(rig.seat.capabilities.loadSession, false);
    await assert.rejects(
      () => rig.seat.adopt("fake-session-1"),
      (error: unknown) => error instanceof AcpCapabilityError,
    );
  } finally {
    await rig.close();
  }
});

test("a headless seat creates no ACP session", async () => {
  // A seat opened to adopt one that already exists must not also create one:
  // the harness would bill a new session for a connection that only ever meant
  // to resume an old one.
  const rig = await startRig("ok");
  try {
    assert.throws(() => rig.seat.sessionId, /seat has no session/);
    // But it is a live connection.
    assert.ok(rig.seat.busy === false);
  } finally {
    await rig.close();
  }
});

test("resume adopts a session and leaves it ready to prompt", async () => {
  // The continue path. k5 holds the transcript, so a replay would be history it
  // already has; and session/load streams that replay before responding with no
  // way to tell a drained queue from an empty one, so draining it would either
  // truncate the replay or leave a task that swallows the next turn.
  const chunks: string[] = [];
  const rig = await startRig("ok", "headless", (_turnId, event) => {
    if (event.kind === "text") chunks.push(event.text);
  });
  try {
    const adopted = await rig.seat.adopt("fake-session-2");
    assert.equal(adopted.sessionId, "fake-session-2", "the id is the one we asked for");
    assert.ok(adopted.configOptions.length > 0, "config options come back from the response");
    // The name promises the seat is ready to prompt, so prompt it. This is the
    // whole point of adopting: the adopted queue has to carry a live turn.
    const stop = await rig.seat.prompt("t-adopted", [
      { type: "text", text: "echo: resumed" },
    ]);
    assert.equal(stop, "end_turn");
    assert.ok(chunks.length > 0, "the adopted session must deliver a real reply");
    assert.equal(chunks.join(""), "first second third");
    assert.equal(rig.seat.busy, false);
    assert.equal(rig.seat.poisoned, false, "a resumed turn must not poison the seat");
  } finally {
    await rig.close();
  }
});

test("adopting an unknown session is a refusal, not an adopted ghost", async () => {
  const rig = await startRig("ok");
  try {
    await assert.rejects(
      () => rig.seat.adopt("no-such-session"),
      /no such session/,
    );
  } finally {
    await rig.close();
  }
});

test("a seat cannot adopt twice", async () => {
  const rig = await startRig("ok");
  try {
    await rig.seat.adopt("fake-session-1");
    await assert.rejects(
      () => rig.seat.adopt("fake-session-2"),
      /already has a session/,
    );
  } finally {
    await rig.close();
  }
});

test("a seat that has been closed refuses to adopt", async () => {
  const rig = await startRig("ok");
  await rig.seat.close();
  await assert.rejects(() => rig.seat.adopt("fake-session-1"), /seat is closed/);
  rmSync(rig.cwd, { recursive: true, force: true });
});

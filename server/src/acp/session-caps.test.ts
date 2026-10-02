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
  // The real OpenCode 1.18.32 shape, from a live probe.
  const real = probeCapabilities(initializeResult("ok"));
  assert.equal(real.loadSession, true);
  assert.equal(real.list, true);
  assert.equal(real.resume, true);
  assert.equal(real.close, true);
  assert.equal(real.image, true);
  assert.equal(real.embeddedContext, true);
  assert.deepEqual(real.mismatches, []);

  // Absent means unsupported, and `{}` means supported.
  const empty = probeCapabilities({ agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } } });
  assert.equal(empty.loadSession, false);
  assert.equal(empty.list, true);
  assert.equal(empty.resume, true);
  assert.equal(empty.close, false);

  // A harness that advertises nothing at all.
  assert.equal(probeCapabilities({}).list, false);
  assert.equal(probeCapabilities({ agentCapabilities: null }).loadSession, false);
  assert.equal(probeCapabilities(null).list, false);
  assert.equal(probeCapabilities("nonsense").list, false);
});

test("a mis-shaped capability is reported and treated as unsupported, never thrown", () => {
  // The SDK's generated schema wraps every field in .catch(), so these lose
  // their capability silently. A strict k5 parse would instead fail the seat
  // open entirely, bricking a harness that merely spelled it differently.
  const weird = probeCapabilities(initializeResult("weird-caps"));
  assert.equal(weird.loadSession, false, 'a string "true" is not a boolean');
  assert.equal(weird.list, false, "true is not an empty capability object");
  assert.equal(weird.resume, false);
  assert.deepEqual([...weird.mismatches].sort(), [
    "loadSession",
    "sessionCapabilities.list",
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
    assert.equal(rig.seat.capabilities.list, true);
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
    assert.equal(caps.list, false);
    assert.equal(caps.resume, false);
    // The spec is explicit that a client MUST NOT call a method the agent did
    // not advertise, so the gate fires before the wire.
    await assert.rejects(
      () => rig.seat.listSessions(),
      (error: unknown) => error instanceof AcpCapabilityError && error.capability === "list",
    );
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
      () => rig.seat.listSessions(),
      (error: unknown) => error instanceof AcpCapabilityError,
    );
  } finally {
    await rig.close();
  }
});

test("a headless seat creates no ACP session", async () => {
  // A sidebar that lists tasks must not leave a new harness session behind on
  // every page load.
  const rig = await startRig("ok");
  try {
    assert.throws(() => rig.seat.sessionId, /seat has no session/);
    // But it is a live connection, so the read works.
    const sessions = await rig.seat.listSessions();
    assert.ok(sessions.length > 0);
  } finally {
    await rig.close();
  }
});

test("session/list is narrowed, bounded, and filtered by the seat's cwd", async () => {
  const rig = await startRig("ok");
  try {
    // The seat sends its own cwd, and the agent filters on it: the third fixture
    // lives in /somewhere/else and must not come back.
    const mine = await rig.seat.listSessions();
    assert.equal(mine.length, 2);
    assert.deepEqual(
      mine.map((s) => s.sessionId).sort(),
      ["fake-session-1", "fake-session-3"],
    );
    const first = mine.find((s) => s.sessionId === "fake-session-1");
    assert.equal(first?.cwd, rig.cwd);
    assert.equal(first?.title, "A previous task");
    assert.equal(first?.updatedAt, "2026-09-27T09:00:00.000Z");
    // A session the harness has not named yet is kept, with the field null
    // rather than an invented title.
    assert.equal(mine.find((s) => s.sessionId === "fake-session-3")?.title, null);

    // Every reported cwd is absolute, which is what the stored-cwd check needs.
    for (const entry of mine) assert.ok(entry.cwd.startsWith("/"));

    // And the cap is honoured.
    assert.equal((await rig.seat.listSessions({ limit: 1 })).length, 1);
  } finally {
    await rig.close();
  }
});

test("a session with no usable id or an absolute cwd is dropped, not half-kept", async () => {
  const rig = await startRig("ok");
  try {
    // Exercised through the narrowing helper directly, because a real agent
    // would have to be broken in a very specific way to send these.
    const { toHarnessSessionInfo } = await import("./adopt.js");
    assert.equal(toHarnessSessionInfo({ cwd: "/abs" }), null, "no id");
    assert.equal(toHarnessSessionInfo({ sessionId: "s" }), null, "no cwd");
    assert.equal(toHarnessSessionInfo({ sessionId: "s", cwd: "relative/path" }), null, "a relative cwd");
    assert.equal(toHarnessSessionInfo({ sessionId: "", cwd: "/abs" }), null, "an empty id");
    assert.equal(toHarnessSessionInfo(null), null);
    assert.equal(toHarnessSessionInfo("nonsense"), null);
    // An unparseable timestamp becomes null rather than a value that would make
    // the row un-evictable by age.
    const odd = toHarnessSessionInfo({ sessionId: "s", cwd: "/abs", updatedAt: "not a date" });
    assert.equal(odd?.updatedAt, null);
    assert.equal(odd?.title, null);
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

test("a seat that has been closed refuses to list or adopt", async () => {
  const rig = await startRig("ok");
  await rig.seat.close();
  await assert.rejects(() => rig.seat.listSessions(), /seat is closed/);
  await assert.rejects(() => rig.seat.adopt("fake-session-1"), /seat is closed/);
  rmSync(rig.cwd, { recursive: true, force: true });
});

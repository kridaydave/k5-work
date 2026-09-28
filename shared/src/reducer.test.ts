import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerEvent } from "./contracts.js";
import {
  INITIAL_VIEW_STATE,
  applyServerEvent,
  applyServerEvents,
  beginTurn,
  createCoalescer,
  isTurnTerminal,
  requestCancel,
  resetSession,
  type K5ViewState,
  type Scheduler,
} from "./reducer.js";

const opened: ServerEvent = {
  type: "session.opened",
  commandId: "c-1",
  sessionId: "s-1",
  storeId: "11111111-1111-4111-8111-111111111111",
  projectId: "p-1",
  cwd: "/tmp/p",
  configOptions: [{ id: "model", name: "model", type: "select", current: null, values: [] }],
};

function running(): K5ViewState {
  return beginTurn({ ...INITIAL_VIEW_STATE, session: "open", sessionId: "s-1" }, "t-1", "hello");
}

describe("view reducer", () => {
  it("keeps the user's text even if the turn never starts", () => {
    const state = beginTurn(INITIAL_VIEW_STATE, "t-1", "hello");
    assert.equal(state.entries[0].text, "hello");
    assert.equal(state.turnStatus, "running");
  });

  it("streams deltas into the assistant entry for the active turn only", () => {
    let state = running();
    state = applyServerEvent(state, { type: "turn.delta", sessionId: "s-1", turnId: "t-1", stream: "text", text: "He" });
    state = applyServerEvent(state, { type: "turn.delta", sessionId: "s-1", turnId: "t-1", stream: "text", text: "llo" });
    assert.equal(state.entries[1].text, "Hello");

    state = applyServerEvent(state, { type: "turn.delta", sessionId: "s-1", turnId: "t-2", stream: "text", text: "wrong turn" });
    assert.equal(state.entries[1].text, "Hello", "a stale turn must not append");
  });

  it("keeps thought text out of the transcript", () => {
    let state = running();
    state = applyServerEvent(state, { type: "turn.delta", sessionId: "s-1", turnId: "t-1", stream: "thought", text: "hmm" });
    assert.equal(state.thinking, "hmm");
    assert.equal(state.entries[1].text, "");
  });

  // The exactly-once guarantee: a watchdog and a real response can race.
  it("accepts only the first terminal event for a turn", () => {
    let state = running();
    state = applyServerEvent(state, { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason: "k5-timeout" });
    assert.equal(state.turnStatus, "error");
    assert.equal(state.turnReason, "k5-timeout");

    const afterLate = applyServerEvent(state, { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason: "end_turn" });
    assert.deepEqual(afterLate, state, "a late completion must not overwrite the terminal state");

    const afterDelta = applyServerEvent(state, { type: "turn.delta", sessionId: "s-1", turnId: "t-1", stream: "text", text: "late" });
    assert.equal(afterDelta.entries[1].text, "");
  });

  it("treats refusal and k5 error as a failed turn", () => {
    for (const stopReason of ["refusal", "k5-error", "k5-timeout"] as const) {
      const state = applyServerEvent(running(), { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason });
      assert.equal(state.turnStatus, "error", `${stopReason} must be an error`);
    }
    for (const stopReason of ["end_turn", "cancelled", "k5-cancelled"] as const) {
      const state = applyServerEvent(running(), { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason });
      assert.equal(state.turnStatus, "done", `${stopReason} must not be an error`);
    }
  });

  it("never leaves a tool card in a pending state after a cancelled turn", () => {
    let state = running();
    state = applyServerEvent(state, {
      type: "tool.updated", sessionId: "s-1", turnId: "t-1",
      toolCallId: "tool-1", title: "read file", status: "pending", lifecycle: "active",
    });
    state = applyServerEvent(state, { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason: "cancelled" });
    assert.equal(state.tools["tool-1"].lifecycle, "cancelled");
    assert.equal(state.tools["tool-1"].status, "pending", "the ACP status is not invented");
  });

  it("preserves a tool status the harness already reported", () => {
    let state = running();
    state = applyServerEvent(state, {
      type: "tool.updated", sessionId: "s-1", turnId: "t-1",
      toolCallId: "tool-1", title: "done", status: "completed", lifecycle: "active",
    });
    state = applyServerEvent(state, { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason: "end_turn" });
    assert.equal(state.tools["tool-1"].status, "completed");
    assert.equal(state.tools["tool-1"].lifecycle, "active");
  });

  it("orphans live tool cards when the seat is reaped", () => {
    let state = running();
    state = applyServerEvent(state, {
      type: "tool.updated", sessionId: "s-1", turnId: "t-1",
      toolCallId: "tool-1", title: "read file", status: "in_progress", lifecycle: "active",
    });
    state = applyServerEvent(state, { type: "seat.reaped", sessionId: "s-1", reason: "child-failure" });
    assert.equal(state.tools["tool-1"].lifecycle, "orphaned");
    assert.equal(state.session, "none");
  });

  // A dropped socket must never leave the UI claiming a live turn.
  it("fails an in-flight turn when the socket closes", () => {
    const state = applyServerEvent(running(), { type: "connection.closed", reason: "network" });
    assert.equal(state.connection, "closed");
    assert.equal(state.turnStatus, "error");
    assert.equal(state.turnReason, "socket-closed");
    assert.equal(state.session, "failed");
  });

  it("does not downgrade a completed turn when the socket closes later", () => {
    let state = running();
    state = applyServerEvent(state, { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason: "end_turn" });
    const closed = applyServerEvent(state, { type: "connection.closed", reason: "network" });
    assert.equal(closed.turnStatus, "done");
    assert.equal(closed.turnReason, null);
  });

  it("surfaces a failed open instead of leaving an optimistic pending state", () => {
    let state: K5ViewState = { ...INITIAL_VIEW_STATE, session: "opening" };
    state = applyServerEvent(state, { type: "command.result", commandId: "c-1", ok: false, reason: "auth-required", message: "login first" });
    assert.equal(state.session, "failed");
    assert.equal(state.sessionReason, "auth-required");
    assert.equal(state.sessionMessage, "login first");
    assert.equal(state.turnStatus, "error");
  });

  it("records the session failure with a null scope before any session exists", () => {
    const state = applyServerEvent(INITIAL_VIEW_STATE, {
      type: "session.failed", sessionId: null, reason: "project-has-plugins",
    });
    assert.equal(state.session, "failed");
    assert.equal(state.sessionReason, "project-has-plugins");
  });

  it("tracks cancel as an explicit state", () => {
    const state = requestCancel(running());
    assert.equal(state.turnStatus, "cancelling");
    assert.equal(requestCancel(state), state, "cancelling twice is a no-op");
  });

  it("clears the transcript for a new task but keeps the connection", () => {
    // Connection is owned by the socket layer, so a new task must not reset it.
    const live: K5ViewState = {
      ...applyServerEvent(running(), opened),
      connection: "open",
    };
    const state = resetSession(live);
    assert.equal(state.connection, "open");
    assert.deepEqual(state.entries, []);
    assert.equal(state.session, "none");
    assert.equal(state.activeTurnId, null);
  });



  it("stores the advertised config options from session.opened", () => {
    const state = applyServerEvent(INITIAL_VIEW_STATE, opened);
    assert.deepEqual(state.configOptions.map((o) => o.id), ["model"]);
  });
});

describe("delta coalescing", () => {
  it("batches into one application per scheduled frame", () => {
    const frames: (() => void)[] = [];
    const scheduler: Scheduler = (run) => frames.push(run);
    const batches: number[] = [];
    const coalescer = createCoalescer<number>(scheduler, (values) => batches.push(values.length));

    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);
    assert.deepEqual(batches, [], "nothing is applied before the frame runs");
    assert.equal(frames.length, 1, "many deltas schedule one frame");

    frames[0]();
    assert.deepEqual(batches, [3], "the frame applies the batch in order");
  });

  it("schedules a new frame after a flush", () => {
    const frames: (() => void)[] = [];
    const batches: number[][] = [];
    const coalescer = createCoalescer<number>((run) => frames.push(run), (v) => batches.push(v));
    coalescer.push(1);
    frames[0]();
    coalescer.push(2);
    assert.equal(frames.length, 2);
    frames[1]();
    assert.deepEqual(batches, [[1], [2]]);
  });

  it("applies a batch in order so terminal last", () => {
    const deltas = (text: string): ServerEvent => ({
      type: "turn.delta", sessionId: "s-1", turnId: "t-1", stream: "text", text,
    });
    const done: ServerEvent = { type: "turn.completed", sessionId: "s-1", turnId: "t-1", stopReason: "end_turn" };
    const final = applyServerEvents(running(), [deltas("a"), deltas("b"), done]);
    assert.equal(final.entries[1].text, "ab");
    assert.equal(final.turnStatus, "done");
  });

  it("drops a pending batch on cancel so nothing lands after a new task", () => {
    let ran = 0;
    const coalescer = createCoalescer<number>(() => undefined, () => {
      ran += 1;
    });
    coalescer.push(1);
    coalescer.cancel();
    coalescer.flush();
    assert.equal(ran, 0);
  });
});

describe("turn status helpers", () => {
  it("recognises only done and error as terminal", () => {
    assert.equal(isTurnTerminal("done"), true);
    assert.equal(isTurnTerminal("error"), true);
    for (const status of ["idle", "queued", "running", "cancelling"] as const) {
      assert.equal(isTurnTerminal(status), false);
    }
  });
});

describe("configure failures are not turn failures", () => {
  const opened = applyServerEvents(INITIAL_VIEW_STATE, [
      {
        type: "session.opened",
        commandId: "c-open",
        sessionId: "s-1",
        storeId: "11111111-1111-4111-8111-111111111111",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [],
      },
      {
        type: "session.configured",
        sessionId: "s-1",
        configOptions: [
          { id: "model", name: "Model", type: "select", current: "a", values: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
        ],
      },
    ]);

  // Built the way the real flow builds it, so there is a live turn to protect.
  const running: K5ViewState = beginTurn(opened, "t-1", "go");

  it("keeps a streaming turn alive when a model change is refused", () => {
    // A harness refusing a model change mid-turn says nothing about the turn.
    // Killing it here would strand the user on "error" while deltas keep
    // arriving, and the next delta would be dropped as a terminal-after event.
    const after = applyServerEvent(
      running,
      { type: "command.result", commandId: "c-1", ok: false, reason: "busy", message: "wait for the turn" },
      "session.configure",
    );
    assert.equal(after.turnStatus, "running");
    assert.equal(after.sessionMessage, "wait for the turn");
  });

  it("still kills a real turn failure", () => {
    const after = applyServerEvent(
      running,
      { type: "command.result", commandId: "c-1", ok: false, reason: "seat-busy" },
      "session.prompt",
    );
    assert.equal(after.turnStatus, "error");
  });

  it("keeps a mid-stream delta after a refused configure", () => {
    // The regression this protects: the turn is still live, so its deltas must
    // still land rather than being discarded as post-terminal noise.
    const refused = applyServerEvent(
      running,
      { type: "command.result", commandId: "c-1", ok: false, reason: "busy" },
      "session.configure",
    );
    const after = applyServerEvent(refused, {
      type: "turn.delta",
      sessionId: "s-1",
      turnId: "t-1",
      stream: "text",
      text: "still going",
    });
    assert.equal(after.entries.at(-1)?.text, "still going");
  });
});

it("a failed discovery or continuation is not a turn failure", () => {
  // A sidebar refresh that fails while the model is working used to kill the turn:
  // the dots stopped and every later delta was dropped, so a finished answer stayed
  // truncated with an error badge on it.
  for (const scope of ["session.list", "session.load", "session.configure"] as const) {
    let state: K5ViewState = beginTurn(INITIAL_VIEW_STATE, "t-1", "do the thing");
    state = applyServerEvent(state, {
      type: "turn.started",
      sessionId: "s-1",
      turnId: "t-1",
      userText: "do the thing",
      attachments: [],
    });
    state = applyServerEvent(state, {
      type: "turn.delta",
      sessionId: "s-1",
      turnId: "t-1",
      stream: "text",
      text: "working on it",
    });

    state = applyServerEvent(
      state,
      { type: "command.result", commandId: "c-1", ok: false, reason: "posture-unverifiable", message: "no" },
      scope,
    );
    assert.equal(state.turnStatus, "running", `a failed ${scope} must not stop the turn`);
    assert.equal(state.sessionMessage, "no", `a failed ${scope} is reported`);

    // And the stream continues to land.
    state = applyServerEvent(state, {
      type: "turn.delta",
      sessionId: "s-1",
      turnId: "t-1",
      stream: "text",
      text: " and finished",
    });
    state = applyServerEvent(state, {
      type: "turn.completed",
      sessionId: "s-1",
      turnId: "t-1",
      stopReason: "end_turn",
    });
    assert.equal(state.turnStatus, "done");
    const assistant = state.entries.find((e) => e.id === "assistant:t-1");
    assert.equal(assistant?.text, "working on it and finished", "the answer is not truncated");
  }
});

it("a title does not leak from one session into the next", () => {
  let state: K5ViewState = applyServerEvent(INITIAL_VIEW_STATE, {
    type: "session.opened",
    commandId: "c-1",
    sessionId: "s-1",
    storeId: "11111111-1111-4111-8111-111111111111",
    projectId: "p-1",
    cwd: "/tmp/p",
    configOptions: [],
  });
  state = applyServerEvent(state, {
    type: "session.updated",
    sessionId: "s-1",
    title: "Named task",
    updatedAt: null,
  });
  assert.equal(state.sessionTitle, "Named task");

  // A new session starts untitled, not carrying the previous one forward.
  state = applyServerEvent(state, {
    type: "session.opened",
    commandId: "c-2",
    sessionId: "s-2",
    storeId: "11111111-1111-4111-8111-111111111111",
    projectId: "p-1",
    cwd: "/tmp/p",
    configOptions: [],
  });
  assert.equal(state.sessionTitle, null, "a new session must not inherit a title");

  // And a closed session drops it too.
  state = applyServerEvent(state, {
    type: "session.updated",
    sessionId: "s-2",
    title: "Second",
    updatedAt: null,
  });
  state = applyServerEvent(state, { type: "session.closed", sessionId: "s-2", reason: "client-request" });
  assert.equal(state.sessionTitle, null, "a closed session drops its title");
});

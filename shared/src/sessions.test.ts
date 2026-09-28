import test from "node:test";
import assert from "node:assert/strict";
import {
  PERSISTED_EVENT_TYPES,
  RECORD_VERSION,
  SessionEventsResponseSchema,
  SessionListResponseSchema,
  SessionSummarySchema,
  StoredEventRecordSchema,
  isPersistedEventType,
  isFailedTurn,
  projectTranscript,
  transcriptEntries,
  type StoredEventRecord,
} from "./sessions.js";
import type {
  AttachmentManifestEntry,
  ServerEvent,
  ToolLifecycle,
  ToolStatus,
} from "./contracts.js";
import {
  INITIAL_VIEW_STATE,
  applyServerEvent,
  beginTurn,
  hydrateTranscript,
  MAX_VIEW_ENTRIES,
  type K5ViewState,
} from "./reducer.js";

function record(seq: number, event: ServerEvent): StoredEventRecord {
  return { v: RECORD_VERSION, seq, ts: "2026-09-27T10:00:00.000Z", event };
}

const turnStarted = (turnId: string, userText = "what should we build?"): ServerEvent => ({
  type: "turn.started",
  sessionId: "ses_live",
  turnId,
  userText,
  attachments: [],
});
const turnStartedWith = (
  turnId: string,
  attachments: AttachmentManifestEntry[],
  userText = "what should we build?",
): ServerEvent => ({
  type: "turn.started",
  sessionId: "ses_live",
  turnId,
  userText,
  attachments,
});
const text = (turnId: string, chunk: string): ServerEvent => ({
  type: "turn.delta",
  sessionId: "ses_live",
  turnId,
  stream: "text",
  text: chunk,
});
const thought = (turnId: string, chunk: string): ServerEvent => ({
  type: "turn.delta",
  sessionId: "ses_live",
  turnId,
  stream: "thought",
  text: chunk,
});
const completed = (turnId: string, stopReason: "end_turn" | "refusal"): ServerEvent => ({
  type: "turn.completed",
  sessionId: "ses_live",
  turnId,
  stopReason,
});
const tool = (
  turnId: string,
  status: ToolStatus,
  lifecycle: ToolLifecycle = "active",
): ServerEvent => ({
  type: "tool.updated",
  sessionId: "ses_live",
  turnId,
  toolCallId: `tool-${turnId}`,
  title: "read a file",
  status,
  lifecycle,
});

test("the stored record wraps an event rather than mutating the wire shape", () => {
  // ServerEventSchema is .strict(), so a seq on the wire would be rejected. The
  // sequence lives on the stored wrapper, which is why no command or event
  // changed shape to add replay.
  const event = text("t1", "hello");
  const parsed = StoredEventRecordSchema.parse(record(1, event));
  assert.equal(parsed.seq, 1);
  assert.equal((parsed.event as { type: string }).type, "turn.delta");
  // A record at the wrong version is refused rather than guessed at.
  assert.equal(
    StoredEventRecordSchema.safeParse({ v: 2, seq: 1, ts: "x", event }).success,
    false,
  );
  // And zero is not a sequence number.
  assert.equal(
    StoredEventRecordSchema.safeParse({ v: 1, seq: 0, ts: "x", event }).success,
    false,
  );
  const ok = SessionEventsResponseSchema.safeParse({
    storeId: "11111111-1111-4111-8111-111111111111",
    status: "up-to-date",
    firstSeq: 0,
    lastSeq: 0,
    nextSince: 0,
    hasMore: false,
    dropped: 0,
    events: [],
  });
  assert.equal(ok.success, true);
});

test("the four replay states are all representable and none is a typo", () => {
  const base = {
    storeId: "11111111-1111-4111-8111-111111111111",
    firstSeq: 0,
    lastSeq: 0,
    nextSince: 0,
    hasMore: false,
    dropped: 0,
    events: [],
  };
  for (const status of ["up-to-date", "appended", "cursor-too-old", "cursor-invalid"] as const) {
    assert.equal(SessionEventsResponseSchema.safeParse({ ...base, status }).success, true, status);
  }
  assert.equal(
    SessionEventsResponseSchema.safeParse({ ...base, status: "synced" }).success,
    false,
  );
});

test("only session-scoped variants are persisted", () => {
  for (const type of PERSISTED_EVENT_TYPES) {
    assert.equal(isPersistedEventType(type), true, `${type} should persist`);
  }
  // connection.closed would pin the browser's connection state shut on replay,
  // and command.result correlates a browser command rather than history.
  for (const type of ["command.result", "connection.closed", "error"] as const) {
    assert.equal(isPersistedEventType(type), false, `${type} must not persist`);
  }
});

test("a stored transcript projects to turns, not to a flat entry list", () => {
  const projected = projectTranscript([
    record(1, turnStarted("t1", "first question")),
    record(2, text("t1", "Hello ")),
    record(3, text("t1", "world")),
    record(4, completed("t1", "end_turn")),
    record(5, turnStarted("t2", "second question")),
    record(6, text("t2", "Second")),
    record(7, completed("t2", "end_turn")),
  ]);
  assert.equal(projected.truncated, false);
  assert.equal(projected.turns.length, 2);
  assert.equal(projected.turns[0]?.assistantText, "Hello world");
  assert.equal(projected.turns[0]?.stopReason, "end_turn");
  assert.equal(projected.turns[1]?.assistantText, "Second");
  assert.equal(projected.outcome, null);
});

test("a reloaded transcript shows what the user asked, not only the answer", () => {
  // Without the prompt on turn.started the projection had no way to fill
  // userText, and every reloaded session showed only the assistant's half.
  const projected = projectTranscript([
    record(1, turnStarted("t1", "refactor the composer")),
    record(2, text("t1", "Done.")),
    record(3, completed("t1", "end_turn")),
  ]);
  assert.equal(projected.turns[0]?.userText, "refactor the composer");
  assert.deepEqual(transcriptEntries(projected), [
    { id: "user:t1", role: "user", text: "refactor the composer" },
    { id: "assistant:t1", role: "assistant", text: "Done." },
  ]);
});

test("a reloaded turn carries the attachment manifest through from the store", () => {
  // The spooled bytes are addressed by id alone, so a reloaded transcript can
  // only say what was attached by reading the manifest off the turn.started
  // record. Without this the names and sizes are simply gone after a reload.
  const attachments: AttachmentManifestEntry[] = [
    { attachmentId: "att-1", name: "screenshot.png", mimeType: "image/png", kind: "image", size: 2048 },
    { attachmentId: "att-2", name: "notes.md", mimeType: "text/markdown", kind: "text", size: 512 },
  ];
  const projected = projectTranscript([
    record(1, turnStartedWith("t1", attachments, "what is wrong with this?")),
    record(2, text("t1", "Two things.")),
    record(3, completed("t1", "end_turn")),
  ]);
  assert.deepEqual(projected.turns[0]?.attachments, attachments);
});

test("a turn recorded before attachments existed projects an empty manifest", () => {
  const projected = projectTranscript([
    record(1, turnStarted("t1", "no files here")),
    record(2, text("t1", "ok")),
  ]);
  assert.deepEqual(projected.turns[0]?.attachments, []);
});

test("a turn with a manifest still projects its text and stop reason", () => {
  // The manifest is additive: it must not disturb anything the projection
  // already carried, or an attached turn would render differently from a bare
  // one.
  const bare = projectTranscript([
    record(1, turnStarted("t1", "compare these")),
    record(2, text("t1", "Answer.")),
    record(3, completed("t1", "end_turn")),
  ]);
  const attached = projectTranscript([
    record(4, turnStartedWith("t1", [
      { attachmentId: "att-1", name: "a.png", mimeType: "image/png", kind: "image", size: 10 },
    ], "compare these")),
    record(5, text("t1", "Answer.")),
    record(6, completed("t1", "refusal")),
  ]);
  assert.equal(attached.turns[0]?.userText, bare.turns[0]?.userText);
  assert.equal(attached.turns[0]?.assistantText, "Answer.");
  assert.equal(attached.turns[0]?.stopReason, "refusal");
  // The manifest is not a transcript entry, so the bubble stays the user's
  // words rather than becoming a wall of base64.
  assert.deepEqual(transcriptEntries(attached), transcriptEntries(bare));
});

test("a duplicated record cannot replace the prompt the user sent", () => {
  const projected = projectTranscript([
    record(1, turnStarted("t1", "the real question")),
    record(2, turnStarted("t1", "")),
    record(3, text("t1", "ok")),
  ]);
  assert.equal(projected.turns[0]?.userText, "the real question");
});

test("thoughts are kept out of the visible transcript but not discarded", () => {
  const projected = projectTranscript([
    record(1, turnStarted("t1")),
    record(2, thought("t1", "let me ")),
    record(3, thought("t1", "think")),
    record(4, text("t1", "answer")),
    record(5, completed("t1", "end_turn")),
  ]);
  const turn = projected.turns[0];
  assert.equal(turn?.assistantText, "answer", "thoughts never leak into the answer");
  assert.equal(turn?.thoughtText, "let me think", "but they are not thrown away");
  const assistant = transcriptEntries(projected).filter((e) => e.role === "assistant");
  assert.equal(assistant[0]?.text, "answer");
});

test("a stored tool card is corrected the same way the live reducer corrects it", () => {
  // Compared against the real reducer rather than a hardcoded literal, so this
  // test can actually detect the divergence its name is about.
  const scenarios: { status: ToolStatus; label: string }[] = [
    { status: "pending", label: "pending" },
    { status: "in_progress", label: "in progress" },
    { status: "completed", label: "reported complete" },
    { status: "failed", label: "reported failed" },
  ];
  for (const { status, label } of scenarios) {
    const stored = projectTranscript([
      record(1, turnStarted("t1")),
      record(2, tool("t1", status)),
      record(3, completed("t1", "end_turn")),
    ]).turns[0]?.tools[0];

    let live: K5ViewState = beginTurn(INITIAL_VIEW_STATE, "t1", "q");
    live = applyServerEvent(live, turnStarted("t1", "q"));
    live = applyServerEvent(live, tool("t1", status));
    live = applyServerEvent(live, completed("t1", "end_turn"));
    const liveCard = live.tools["tool-t1"];

    assert.equal(
      stored?.lifecycle,
      liveCard?.lifecycle,
      `stored and live lifecycle must agree for a ${label} card`,
    );
    assert.equal(stored?.status, liveCard?.status, `stored and live status must agree for a ${label} card`);
  }
});

test("a log that ends mid-turn does not leave a tool spinning forever", () => {
  // The reachable case: the byte cap stopped the log, so there is no
  // turn.completed and no reap, and the session is flagged truncated.
  const projected = projectTranscript(
    [record(1, turnStarted("t1")), record(2, tool("t1", "in_progress"))],
    { truncated: true },
  );
  assert.equal(projected.truncated, true);
  assert.equal(projected.turns[0]?.tools[0]?.lifecycle, "orphaned");
});

test("a reaped seat orphans the cards that were still live", () => {
  const projected = projectTranscript([
    record(1, turnStarted("t1")),
    record(2, tool("t1", "in_progress")),
    record(3, { type: "seat.reaped", sessionId: "ses_live", reason: "idle-timeout" }),
  ]);
  assert.equal(projected.turns[0]?.tools[0]?.lifecycle, "orphaned");
});

test("a session that failed to open rehydrates with its failure, not as empty", () => {
  const projected = projectTranscript([
    record(1, { type: "session.failed", sessionId: null, reason: "posture-too-weak", message: "too broad" }),
  ]);
  assert.deepEqual(projected.outcome, { reason: "failed", message: "too broad" });
  // A failure with no message still names the reason, rather than showing nothing.
  const bare = projectTranscript([
    record(1, { type: "session.failed", sessionId: null, reason: "auth-required" }),
  ]);
  assert.deepEqual(bare.outcome, { reason: "failed", message: "auth-required" });
});

test("an empty log projects to an empty transcript, not a throw", () => {
  assert.deepEqual(projectTranscript([]), {
    turns: [],
    truncated: false,
    outcome: null,
    dropped: 0,
  });
  assert.deepEqual(projectTranscript([], { truncated: true, dropped: 2 }), {
    turns: [],
    truncated: true,
    outcome: null,
    dropped: 2,
  });
  assert.deepEqual(transcriptEntries(projectTranscript([])), []);
});

test("a tool-only turn keeps its card in the projection", () => {
  // A store that began mid-stream can hold a tool call with no text. The card
  // must survive, so consumers read turns rather than entries.
  const projected = projectTranscript([
    record(1, turnStarted("t1")),
    record(2, tool("t1", "completed")),
  ]);
  assert.equal(projected.turns.length, 1);
  assert.equal(projected.turns[0]?.tools.length, 1);
});

test("a failed stop reason is distinguishable from a clean finish", () => {
  const clean = projectTranscript([
    record(1, turnStarted("t1")),
    record(2, text("t1", "done")),
    record(3, completed("t1", "end_turn")),
  ]);
  const refused = projectTranscript([
    record(4, turnStarted("t2")),
    record(5, completed("t2", "refusal")),
  ]);
  assert.equal(isFailedTurn(clean.turns[0]!), false);
  assert.equal(isFailedTurn(refused.turns[0]!), true);
});

test("the list response is bounded and rejects a malformed summary", () => {
  const summary = {
    storeId: "11111111-1111-4111-8111-111111111111",
    title: "A task",
    projectId: "p",
    projectName: null,
    cwd: "/tmp/p",
    harness: "opencode",
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    turnCount: 2,
    firstSeq: 1,
    lastSeq: 9,
    truncated: false,
  };
  assert.equal(SessionSummarySchema.safeParse(summary).success, true);
  assert.equal(SessionListResponseSchema.safeParse({ sessions: [summary] }).success, true);
  // Extra keys are refused rather than silently accepted, so a future field
  // cannot slip a wrong shape past the boundary.
  assert.equal(
    SessionSummarySchema.safeParse({ ...summary, sneaky: true }).success,
    false,
  );
  // The list really is bounded, not just annotated.
  const tooMany = {
    sessions: Array.from({ length: 501 }, () => summary),
  };
  assert.equal(SessionListResponseSchema.safeParse(tooMany).success, false);
  assert.equal(
    SessionListResponseSchema.safeParse({ sessions: Array.from({ length: 500 }, () => summary) }).success,
    true,
  );
});

test("a stored transcript hydrates into view state the live socket can continue", () => {
  // The whole point of the store: a reloaded task shows its history and the socket
  // keeps appending to the same shape.
  const records: StoredEventRecord[] = [];
  let seq = 0;
  const push = (event: ServerEvent): void => {
    records.push({ v: 1, seq: ++seq, ts: "2026-09-27T10:00:00.000Z", event });
  };
  push(turnStarted("t1", "first"));
  push(text("t1", "one "));
  push(text("t1", "two"));
  push(tool("t1", "completed"));
  push(completed("t1", "end_turn"));
  push(turnStarted("t2", "second"));
  push(text("t2", "three"));
  push(tool("t2", "in_progress"));
  push(completed("t2", "end_turn"));

  let state = hydrateTranscript(
    applyServerEvent(INITIAL_VIEW_STATE, {
      type: "session.opened",
      commandId: "c-1",
      sessionId: "ses_live",
      storeId: "11111111-1111-4111-8111-111111111111",
      projectId: "p-1",
      cwd: "/tmp/p",
      configOptions: [],
    }),
    projectTranscript(records),
  );

  assert.equal(state.entries.length, 4);
  assert.deepEqual(
    state.entries.map((e) => [e.id, e.text]),
    [
      ["user:t1", "first"],
      ["assistant:t1", "one two"],
      ["user:t2", "second"],
      ["assistant:t2", "three"],
    ],
  );
  // A hydrated prefix is not a running turn.
  assert.equal(state.turnStatus, "idle");
  // Only the last turn's card is live state.
  assert.deepEqual(Object.keys(state.tools), ["tool-t2"]);
  assert.equal(state.storeId, "11111111-1111-4111-8111-111111111111");

  // And a live turn continues onto it.
  state = beginTurn(state, "t3", "third");
  state = applyServerEvent(state, turnStarted("t3", "third"));
  state = applyServerEvent(state, text("t3", "four"));
  state = applyServerEvent(state, completed("t3", "end_turn"));
  assert.equal(state.entries.length, 6);
  assert.equal(state.entries[5]?.text, "four");
  assert.equal(state.turnStatus, "done");
});

test("a transcript the store could not fully read says so rather than implying completeness", () => {
  const records: StoredEventRecord[] = [
    { v: 1, seq: 1, ts: "t", event: turnStarted("t1", "q") },
    { v: 1, seq: 2, ts: "t", event: text("t1", "a") },
    { v: 1, seq: 3, ts: "t", event: completed("t1", "end_turn") },
  ];
  const dropped = hydrateTranscript(INITIAL_VIEW_STATE, projectTranscript(records, { dropped: 2 }));
  assert.match(String(dropped.sessionMessage), /could not be read back/);

  const cut = hydrateTranscript(INITIAL_VIEW_STATE, projectTranscript(records, { truncated: true }));
  assert.match(String(cut.sessionMessage), /storage limit/);
});

test("a session that failed or closed rehydrates with its outcome", () => {
  const failed = hydrateTranscript(
    INITIAL_VIEW_STATE,
    projectTranscript([
      {
        v: 1,
        seq: 1,
        ts: "t",
        event: { type: "session.failed", sessionId: null, reason: "auth-required", message: "sign in" },
      },
    ]),
  );
  assert.match(String(failed.sessionMessage), /sign in/);
});

test("the retained view is capped, and the drop is a tail rather than a gap", () => {
  // Deltas arrive per chunk and the old append rebuilt every entry each time, so a
  // long turn was quadratic. The cap also bounds what a rehydrating browser can be
  // asked to render.
  const turns = Math.ceil(MAX_VIEW_ENTRIES / 2) + 40;
  const records: StoredEventRecord[] = [];
  for (let index = 0; index < turns; index += 1) {
    records.push({ v: 1, seq: index * 2 + 1, ts: "t", event: turnStarted(`t${index}`, `q${index}`) });
    records.push({ v: 1, seq: index * 2 + 2, ts: "t", event: text(`t${index}`, `a${index}`) });
  }
  const hydrated = hydrateTranscript(INITIAL_VIEW_STATE, projectTranscript(records));
  assert.ok(hydrated.entries.length <= MAX_VIEW_ENTRIES, `kept ${hydrated.entries.length} entries`);
  // What survives is the newest, contiguously.
  assert.equal(hydrated.entries[hydrated.entries.length - 1]?.id, `assistant:t${turns - 1}`);
  for (let index = 1; index < hydrated.entries.length; index += 1) {
    const previous = hydrated.entries[index - 1]?.id ?? "";
    const current = hydrated.entries[index]?.id ?? "";
    const previousTurn = Number(previous.split(":")[1]?.slice(1));
    const currentTurn = Number(current.split(":")[1]?.slice(1));
    assert.ok(currentTurn - previousTurn <= 1, "the cap drops a prefix, never a middle entry");
  }
});

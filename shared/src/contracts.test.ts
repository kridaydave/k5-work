import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BROWSER_COMMAND_TYPES,
  BrowserCommandSchema,
  CommandFailureReasonSchema,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  ServerEventSchema,
  SessionPromptCommandSchema,
  TurnStartedEventSchema,
} from "./contracts.js";

describe("browser command contract", () => {
  const base = { commandId: "c-1" };

  it("accepts every command the union declares", () => {
    // Enumerated from the schema rather than hand-listed, so a new command cannot
    // be added to the union and left untested.
    const commands = [
      { ...base, type: "session.open", projectId: "p-1" },
      {
        ...base,
        type: "session.configure",
        sessionId: "s-1",
        configOptionId: "model",
        value: "anthropic/claude",
      },
      { ...base, type: "session.prompt", sessionId: "s-1", turnId: "t-1", text: "hi" },
      { ...base, type: "session.cancel", sessionId: "s-1" },
      { ...base, type: "session.close", sessionId: "s-1" },
      { ...base, type: "session.list", projectId: "p-1" },
      {
        ...base,
        type: "session.load",
        storeId: "11111111-1111-4111-8111-111111111111",
      },
    ];
    assert.equal(
      commands.length,
      BROWSER_COMMAND_TYPES.length,
      "a command was added to the union and not exercised here",
    );
    for (const command of commands) {
      const parsed = BrowserCommandSchema.safeParse(command);
      assert.equal(parsed.success, true, `${command.type} must parse`);
    }
  });

  it("rejects an unknown command type rather than ignoring it", () => {
    const parsed = BrowserCommandSchema.safeParse({ ...base, type: "session.hack" });
    assert.equal(parsed.success, false);
  });

  it("rejects unknown keys so a drifted client fails loudly", () => {
    const parsed = BrowserCommandSchema.safeParse({
      ...base,
      type: "session.cancel",
      sessionId: "s-1",
      surprise: true,
    });
    assert.equal(parsed.success, false, "extra keys must not be stripped silently");
  });

  it("rejects an empty prompt and an empty session id", () => {
    assert.equal(
      BrowserCommandSchema.safeParse({
        ...base,
        type: "session.prompt",
        sessionId: "s-1",
        turnId: "t-1",
        text: "",
      }).success,
      false,
    );
    assert.equal(
      BrowserCommandSchema.safeParse({ ...base, type: "session.close", sessionId: "" })
        .success,
      false,
    );
  });

  it("requires a correlation id on every command", () => {
    assert.equal(
      BrowserCommandSchema.safeParse({ type: "session.close", sessionId: "s-1" })
        .success,
      false,
    );
  });

  it("caps prompt length so one command cannot exhaust memory", () => {
    const parsed = BrowserCommandSchema.safeParse({
      ...base,
      type: "session.prompt",
      sessionId: "s-1",
      turnId: "t-1",
      text: "x".repeat(20_001),
    });
    assert.equal(parsed.success, false);
  });
});

describe("server event contract", () => {
  it("keeps tool lifecycle separate from the ACP tool status", () => {
    // ACP 1.5.0 has no `cancelled` status, so a cancelled card must be
    // expressible without inventing an ACP status value.
    const parsed = ServerEventSchema.safeParse({
      type: "tool.updated",
      sessionId: "s-1",
      turnId: "t-1",
      toolCallId: "tool-1",
      title: "read file",
      status: "pending",
      lifecycle: "cancelled",
    });
    assert.equal(parsed.success, true);
    assert.equal(
      ServerEventSchema.safeParse({
        type: "tool.updated",
        sessionId: "s-1",
        turnId: "t-1",
        toolCallId: "tool-1",
        title: "read file",
        status: "cancelled",
        lifecycle: "active",
      }).success,
      false,
      "cancelled must not be a valid ACP status",
    );
  });

  it("allows a seat failure with no session scope", () => {
    assert.equal(
      ServerEventSchema.safeParse({
        type: "seat.reaped",
        sessionId: null,
        reason: "initialize-failed",
      }).success,
      true,
    );
    assert.equal(
      ServerEventSchema.safeParse({
        type: "seat.reaped",
        reason: "initialize-failed",
      }).success,
      false,
      "sessionId must be present, even when null",
    );
  });

  it("bounds the advertised config option inventory", () => {
    const option = {
      id: "model",
      name: "Model",
      type: "select",
      current: null,
      values: [],
    };
    assert.equal(
      ServerEventSchema.safeParse({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        storeId: "11111111-1111-4111-8111-111111111111",
        projectId: "p-1",
        cwd: "/tmp",
        configOptions: [option],
      }).success,
      true,
    );
    assert.equal(
      ServerEventSchema.safeParse({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        storeId: "11111111-1111-4111-8111-111111111111",
        projectId: "p-1",
        cwd: "/tmp",
        configOptions: Array.from({ length: 33 }, () => option),
      }).success,
      false,
      "a harness must not be able to push an unbounded option list",
    );
  });

  it("keeps the failure reason enum closed", () => {
    assert.equal(CommandFailureReasonSchema.safeParse("made-up").success, false);
    assert.equal(CommandFailureReasonSchema.safeParse("auth-required").success, true);
  });

  it("distinguishes a k5-side stop from a harness stop reason", () => {
    for (const stopReason of ["end_turn", "cancelled", "k5-timeout", "k5-cancelled", "k5-error"]) {
      assert.equal(
        ServerEventSchema.safeParse({
          type: "turn.completed",
          sessionId: "s-1",
          turnId: "t-1",
          stopReason,
        }).success,
        true,
        `${stopReason} must be a valid stop reason`,
      );
    }
  });

  it("carries the prompt on turn.started so a turn is durable history", () => {
    // The browser already holds this text and shows it optimistically, but a
    // reloaded transcript is read from the store, and without the prompt it
    // would show only the assistant's half of every exchange.
    const valid = {
      type: "turn.started",
      sessionId: "s-1",
      turnId: "t-1",
      userText: "refactor the composer",
    };
    assert.equal(ServerEventSchema.safeParse(valid).success, true);

    const { userText: _omitted, ...withoutPrompt } = valid;
    assert.equal(
      ServerEventSchema.safeParse(withoutPrompt).success,
      false,
      "a turn with no recorded prompt is not durable history",
    );
    assert.equal(
      ServerEventSchema.safeParse({ ...valid, userText: "" }).success,
      false,
    );
    assert.equal(
      ServerEventSchema.safeParse({ ...valid, userText: "x".repeat(20_001) }).success,
      false,
      "bounded by the same cap as session.prompt",
    );
  });
});

describe("a prompt is capped in bytes, not in characters", () => {
  const base = { commandId: "c-1", type: "session.prompt", sessionId: "s-1", turnId: "t-1" };

  it("refuses a prompt whose UTF-8 encoding does not fit the frame", () => {
    // 20,000 CJK characters is 20,000 code units, so it passes the character cap,
    // and 60,000 bytes, so it does not fit a 64 KiB frame. Before this the
    // gateway killed the socket with no command.result at all.
    const cjk = "\u4f60\u597d".repeat(10_000);
    const parsed = BrowserCommandSchema.safeParse({ ...base, text: cjk });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.issues[0]?.path.join("."), "text");
    assert.match(parsed.error?.issues[0]?.message ?? "", /bytes of UTF-8/);
  });

  it("accepts a prompt of emoji right at the character cap", () => {
    // The byte cap does not over-reject. 10,000 emoji is the most the character
    // cap allows, and it is 40,000 bytes, which fits. Only a script that costs
    // three or more bytes per code unit can actually reach 48 KiB, and a
    // byte-blind cap is what used to kill those.
    const emoji = "\u{1f600}".repeat(10_000);
    assert.equal(emoji.length, 20_000, "at the character cap");
    assert.equal(new TextEncoder().encode(emoji).length, 40_000);
    assert.equal(BrowserCommandSchema.safeParse({ ...base, text: emoji }).success, true);
  });

  it("still accepts an ordinary prompt, and one right at the byte cap", () => {
    assert.equal(BrowserCommandSchema.safeParse({ ...base, text: "hi" }).success, true);
    // 16,384 three-byte CJK characters is exactly 48 KiB.
    const atCap = "\u4f60\u597d".repeat(8_192);
    assert.equal(atCap.length, 16_384, "the character cap is not the one doing the work");
    assert.equal(BrowserCommandSchema.safeParse({ ...base, text: atCap }).success, true);
  });
});

describe("attachments on the wire", () => {
  const prompt = { commandId: "c-1", type: "session.prompt", sessionId: "s-1", turnId: "t-1", text: "look" };
  const manifestEntry = {
    attachmentId: "att-1",
    name: "screenshot.png",
    mimeType: "image/png",
    kind: "image",
    size: 2048,
  };
  const turnStarted = {
    type: "turn.started",
    sessionId: "s-1",
    turnId: "t-1",
    userText: "look",
  };

  it("reads a prompt from a client that predates attachments", () => {
    // A stale web build sends no such key, and refusing it would break prompts
    // for everyone on that build the moment the server shipped.
    assert.equal(BrowserCommandSchema.safeParse(prompt).success, true);
    assert.deepEqual(SessionPromptCommandSchema.parse(prompt).attachments, []);
  });

  it("takes an attachment by id and nothing else", () => {
    const parsed = SessionPromptCommandSchema.safeParse({
      ...prompt,
      attachments: [{ attachmentId: "att-1" }],
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success ? parsed.data.attachments : null, [
      { attachmentId: "att-1" },
    ]);
    // Name, mime, size and kind are the server's to read off the bytes, so a
    // client supplying them is claiming authority it does not have.
    assert.equal(
      SessionPromptCommandSchema.safeParse({
        ...prompt,
        attachments: [{ attachmentId: "att-1", name: "innocent.txt", size: 10 }],
      }).success,
      false,
    );
  });

  it("caps the attachments one prompt can carry", () => {
    const refs = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ attachmentId: `att-${index}` }));
    assert.equal(SessionPromptCommandSchema.safeParse({ ...prompt, attachments: refs(MAX_ATTACHMENTS) }).success, true);
    assert.equal(
      SessionPromptCommandSchema.safeParse({ ...prompt, attachments: refs(MAX_ATTACHMENTS + 1) }).success,
      false,
    );
  });

  it("reads a turn.started recorded before the manifest existed", () => {
    assert.equal(ServerEventSchema.safeParse(turnStarted).success, true);
    assert.deepEqual(TurnStartedEventSchema.parse(turnStarted).attachments, []);
  });

  it("carries the resolved manifest on turn.started", () => {
    const parsed = TurnStartedEventSchema.safeParse({ ...turnStarted, attachments: [manifestEntry] });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success ? parsed.data.attachments : null, [manifestEntry]);
    // Bytes never reach the transcript, so there is no field here that could
    // hold them even by accident.
    assert.equal(
      TurnStartedEventSchema.safeParse({
        ...turnStarted,
        attachments: [{ ...manifestEntry, data: "AAAA" }],
      }).success,
      false,
    );
  });

  it("bounds a manifest entry to the per-attachment byte cap", () => {
    assert.equal(MAX_ATTACHMENT_BYTES, 26_214_400);
    assert.equal(
      TurnStartedEventSchema.safeParse({
        ...turnStarted,
        attachments: [{ ...manifestEntry, size: MAX_ATTACHMENT_BYTES }],
      }).success,
      true,
    );
    assert.equal(
      TurnStartedEventSchema.safeParse({
        ...turnStarted,
        attachments: [{ ...manifestEntry, size: MAX_ATTACHMENT_BYTES + 1 }],
      }).success,
      false,
    );
  });

  it("keeps the prompt byte budget in force on a prompt that has attachments", () => {
    // The budget cannot live on the member object, so it runs as a refinement
    // over the union. A new field on the member is exactly the kind of change
    // that can silently strand that refinement.
    const cjk = "\u4f60\u597d".repeat(10_000);
    const parsed = BrowserCommandSchema.safeParse({
      ...prompt,
      text: cjk,
      attachments: [{ attachmentId: "att-1" }],
    });
    assert.equal(parsed.success, false);
    assert.match(parsed.error?.issues[0]?.message ?? "", /bytes of UTF-8/);
  });
});

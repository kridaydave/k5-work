import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { classifySessionUpdate, lifecycleForStop } from "./updates.js";

// The pinned SDK has 16 SessionUpdate variants; every one needs an explicit
// verdict, so this table mirrors the generated union rather than the prose docs.
const VARIANTS: SessionUpdate["sessionUpdate"][] = [
  "agent_message_chunk",
  "agent_thought_chunk",
  "available_commands_update",
  "compaction_summary_chunk",
  "compaction_update",
  "config_option_update",
  "current_mode_update",
  "notice",
  "plan",
  "plan_removed",
  "plan_update",
  "session_info_update",
  "tool_call",
  "tool_call_update",
  "usage_update",
  "user_message_chunk",
];

const minimal = (sessionUpdate: SessionUpdate["sessionUpdate"]): SessionUpdate =>
  ({ sessionUpdate } as SessionUpdate);

describe("session update classification", () => {
  it("gives every pinned variant an explicit verdict, none falling through", () => {
    for (const variant of VARIANTS) {
      // A bare tool variant legitimately suppresses (no toolCallId), so the
      // check is that nothing is left unclassified.
      const verdict = classifySessionUpdate(minimal(variant));
      if (verdict.kind === "suppress") {
        assert.doesNotMatch(
          verdict.reason,
          /unclassified/,
          `${variant} has no classification`,
        );
      }
    }
  });

  it("classifies each variant into the expected bucket", () => {
    const expected: Record<string, string> = {
      agent_message_chunk: "text",
      user_message_chunk: "text",
      agent_thought_chunk: "text",
      usage_update: "ignore",
      config_option_update: "ignore",
      current_mode_update: "ignore",
      session_info_update: "ignore",
      available_commands_update: "ignore",
      plan: "ignore",
      notice: "suppress",
      compaction_update: "suppress",
      compaction_summary_chunk: "suppress",
      plan_update: "suppress",
      plan_removed: "suppress",
    };
    for (const [variant, kind] of Object.entries(expected)) {
      // The content-bearing variants need real content, or they suppress for a
      // different reason and the bucket assertion would be measuring that.
      const payload = variant.includes("chunk")
        ? ({
            sessionUpdate: variant,
            content: { type: "text", text: "x" },
          } as SessionUpdate)
        : minimal(variant as SessionUpdate["sessionUpdate"]);
      const verdict = classifySessionUpdate(payload);
      assert.equal(verdict.kind, kind, `${variant} must be ${kind}`);
    }
  });

  it("renders text and thought chunks as separate streams", () => {
    assert.deepEqual(
      classifySessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      } as SessionUpdate),
      { kind: "text", stream: "text", text: "hi" },
    );
    assert.deepEqual(
      classifySessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      } as SessionUpdate),
      { kind: "text", stream: "thought", text: "thinking" },
    );
  });

  it("suppresses non-text content rather than coercing it to text", () => {
    const verdict = classifySessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AAAA", mimeType: "image/png" },
    } as SessionUpdate);
    assert.equal(verdict.kind, "suppress");
  });

  it("suppresses the capability-gated and unstable variants", () => {
    for (const variant of [
      "notice",
      "compaction_update",
      "compaction_summary_chunk",
      "plan_update",
      "plan_removed",
    ] as const) {
      const verdict = classifySessionUpdate(minimal(variant));
      assert.equal(verdict.kind, "suppress", `${variant} must be suppressed`);
    }
  });

  it("ignores, rather than forwards, a large command inventory", () => {
    const verdict = classifySessionUpdate(minimal("available_commands_update"));
    assert.equal(verdict.kind, "ignore");
  });

  it("maps a tool update onto the ACP status and defaults to pending", () => {
    assert.deepEqual(
      classifySessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "t-1",
        title: "read file",
        status: "completed",
      } as SessionUpdate),
      { kind: "tool", toolCallId: "t-1", title: "read file", status: "completed" },
    );
    assert.deepEqual(
      classifySessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t-1",
      } as SessionUpdate),
      { kind: "tool", toolCallId: "t-1", title: "", status: "pending" },
    );
  });

  it("suppresses a tool update with no toolCallId instead of inventing one", () => {
    const verdict = classifySessionUpdate({
      sessionUpdate: "tool_call",
      title: "orphan",
    } as SessionUpdate);
    assert.equal(verdict.kind, "suppress");
  });

  it("keeps a cancelled card out of an in-progress state", () => {
    assert.equal(lifecycleForStop("cancelled"), "cancelled");
    assert.equal(lifecycleForStop("k5-timeout"), "cancelled");
    assert.equal(lifecycleForStop("k5-cancelled"), "cancelled");
    assert.equal(lifecycleForStop("k5-error"), "orphaned");
  });
});

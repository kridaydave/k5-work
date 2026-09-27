import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { createMemoryService } from "../service.js";
import {
  RecordingAcpTransport,
  createOpencodePlug,
  sessionUpdateMessage,
} from "./plug.js";

const textChunk = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

describe("plug contract: opencode + memory service", () => {
  it("plug advertises full caps, owns no policy", () => {
    const plug = createOpencodePlug();
    assert.equal(plug.name, "opencode");
    assert.deepEqual(plug.caps, {
      streaming: true,
      toolCalls: true,
      permissions: true,
      sessions: true,
    });
  });

  it("emits a real ACP session/prompt with content blocks, not a bare text field", () => {
    const plug = createOpencodePlug();
    const rpc = plug.toHarnessPrompt({ sessionId: "s-1", text: "build me x" });
    assert.equal(rpc.method, "session/prompt");
    assert.equal(rpc.jsonrpc, "2.0");

    const params = rpc.params as {
      sessionId: string;
      prompt: { type: string; text: string }[];
    };
    assert.equal(params.sessionId, "s-1");
    assert.deepEqual(params.prompt, [{ type: "text", text: "build me x" }]);
  });

  it("carries the access label in _meta, leaving ACP fields untouched", () => {
    const plug = createOpencodePlug();
    const rpc = plug.toHarnessPrompt({
      sessionId: "s-1",
      text: "hi",
      access: "read",
      model: "anthropic/claude",
    });
    const params = rpc.params as {
      access?: unknown;
      model?: unknown;
      _meta?: { k5?: { access?: unknown; model?: unknown } };
    };
    assert.equal(params.access, undefined, "access is not an ACP field");
    assert.equal(params.model, undefined, "model is not an ACP field");
    assert.equal(params._meta?.k5?.access, "read");
    assert.equal(params._meta?.k5?.model, "anthropic/claude");
  });

  it("translates a real agent_message_chunk notification into a chat event", () => {
    const plug = createOpencodePlug();
    const transport = new RecordingAcpTransport();
    transport.record(plug.toHarnessPrompt({ sessionId: "s-1", text: "hi" }));
    assert.equal(transport.recorded.length, 1);

    transport.queueInbound(sessionUpdateMessage("s-1", textChunk("working")));
    const events = transport.drainInbound(plug.fromHarnessMessage);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "chat");
    assert.equal(events[0].sessionId, "s-1");
    assert.deepEqual(events[0].payload, { text: "working" });
  });

  it("drops update variants the chat event cannot render, rather than faking them", () => {
    const plug = createOpencodePlug();
    const transport = new RecordingAcpTransport();

    transport.queueInbound(
      sessionUpdateMessage("s-1", {
        sessionUpdate: "tool_call",
        toolCallId: "t-1",
        title: "read file",
        kind: "read",
        status: "pending",
      } satisfies SessionUpdate),
    );
    transport.queueInbound(
      sessionUpdateMessage("s-1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "AAAA", mimeType: "image/png" },
      } satisfies SessionUpdate),
    );
    transport.queueInbound(sessionUpdateMessage("s-1", textChunk("kept")));

    const events = transport.drainInbound(plug.fromHarnessMessage);
    assert.equal(events.length, 1, "only the text chunk survives");
    assert.deepEqual(events[0].payload, { text: "kept" });
  });

  it("ignores non-update methods and malformed notifications", () => {
    const plug = createOpencodePlug();
    const transport = new RecordingAcpTransport();
    transport.queueInbound({ method: "noise/ping", params: {} });
    transport.queueInbound({ method: "session/update", params: {} });
    transport.queueInbound({ method: "session/update" });
    transport.queueInbound("not-an-object");
    assert.deepEqual(transport.drainInbound(plug.fromHarnessMessage), []);
    assert.equal(transport.drainInbound(plug.fromHarnessMessage).length, 0);
  });

  it("ask-question is harness-origin: recorded, translated, never gated by plug", async () => {
    const svc = createMemoryService();
    const s = svc.sessionNew("opencode");
    const res = await svc.execTool({
      id: "t-ask",
      sessionId: s.id,
      origin: "harness",
      tool: "ask-question",
      args: { q: "which folder?" },
      idempotencyKey: "k-ask-1",
    });
    assert.deepEqual(res, {
      ok: true,
      tool: "ask-question",
      origin: "harness",
    });
    const logged = svc.audit(s.id).find((a) => a.refId === "t-ask");
    assert.equal(logged?.actor, "harness");
  });
});

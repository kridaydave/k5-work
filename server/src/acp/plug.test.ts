import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryService } from "../service.js";
import { FakeHarness, createOpencodePlug } from "./plug.js";

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

  it("prompt roundtrip: service -> plug JSON-RPC -> harness update -> event", async () => {
    const svc = createMemoryService();
    const s = svc.sessionNew("opencode");
    const plug = createOpencodePlug();
    const fake = new FakeHarness(plug);

    const req = { sessionId: s.id, text: "build me x", access: "full" as string };
    const rpc = fake.sendPrompt(req);
    assert.equal(rpc.method, "session/prompt");
    assert.deepEqual((rpc.params as Record<string, unknown>).access, "full");
    assert.equal(fake.recorded.length, 1);

    // Harness streams back an update; plug translates, service would emit.
    fake.queueInbound({
      method: "session/update",
      params: { sessionId: s.id, text: "working…", seq: 7 },
    });
    const events = fake.drainInbound();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "chat");
    assert.equal(events[0].sessionId, s.id);

    // Service side still streams its own receipt independently.
    const svcEvents = [];
    for await (const e of svc.prompt(req)) svcEvents.push(e);
    assert.equal(svcEvents[0].kind, "chat");
  });

  it("opaque access forwarded verbatim per harness", () => {
    const plug = createOpencodePlug();
    const fake = new FakeHarness(plug);
    const rpc = fake.sendPrompt({
      sessionId: "s-9",
      text: "hi",
      access: "kilo-plan-mode",
    });
    assert.equal(
      (rpc.params as Record<string, unknown>).access,
      "kilo-plan-mode",
    );
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

  it("unknown harness messages translate to null, queue drains", () => {
    const plug = createOpencodePlug();
    const fake = new FakeHarness(plug);
    fake.queueInbound({ method: "noise/ping", params: {} });
    fake.queueInbound({
      method: "session/update",
      params: { sessionId: "s-1", text: "ok", seq: 0 },
    });
    const events = fake.drainInbound();
    assert.equal(events.length, 1);
    assert.equal(fake.drainInbound().length, 0);
  });
});

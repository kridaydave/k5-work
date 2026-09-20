import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryService } from "./service.js";

describe("K5Service memory impl", () => {
  it("session lifecycle new/load/close", () => {
    const svc = createMemoryService();
    const s = svc.sessionNew("opencode");
    assert.match(s.id, /^s-\d+$/);
    assert.equal(s.status, "active");
    assert.deepEqual(svc.sessionLoad(s.id), s);
    svc.sessionClose(s.id);
    assert.equal(svc.sessionLoad(s.id)?.status, "closed");
    assert.equal(svc.sessionLoad("missing"), null);
  });

  it("prompt streams chat event with full access default", async () => {
    const svc = createMemoryService();
    const s = svc.sessionNew("opencode");
    const events = [];
    for await (const e of svc.prompt({ sessionId: s.id, text: "hi" })) {
      events.push(e);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "chat");
    assert.deepEqual(events[0].payload, { text: "hi", access: "full" });
  });

  it("prompt forwards opaque access verbatim", async () => {
    const svc = createMemoryService();
    const s = svc.sessionNew("kilo");
    const events = [];
    for await (const e of svc.prompt({
      sessionId: s.id,
      text: "hi",
      access: "kilo-plan-mode",
    })) {
      events.push(e);
    }
    assert.deepEqual(events[0].payload, {
      text: "hi",
      access: "kilo-plan-mode",
    });
  });

  it("execTool audits harness ask-question and k5 tools separately", async () => {
    const svc = createMemoryService();
    const s = svc.sessionNew("opencode");
    const ask = await svc.execTool({
      id: "t-ask",
      sessionId: s.id,
      origin: "harness",
      tool: "ask-question",
      args: { q: "which file?" },
      idempotencyKey: "k-ask",
    });
    assert.deepEqual(ask, {
      ok: true,
      tool: "ask-question",
      origin: "harness",
    });
    const nav = await svc.execTool({
      id: "t-nav",
      sessionId: s.id,
      origin: "k5",
      tool: "browser.navigate",
      args: { url: "https://example.com" },
      idempotencyKey: "k-nav",
    });
    assert.deepEqual(nav, {
      ok: true,
      tool: "browser.navigate",
      origin: "k5",
    });

    const tools = svc.audit(s.id).filter((a) => a.action === "tool");
    assert.equal(tools.length, 2);
    assert.equal(tools[0].actor, "harness");
    assert.equal(tools[0].refId, "t-ask");
    assert.equal(tools[1].actor, "service");
    assert.equal(tools[1].refId, "t-nav");
  });

  it("decide records permission decision", () => {
    const svc = createMemoryService();
    svc.decide({ toolCallId: "t-1", level: "Deny" });
    const perms = svc.audit("").filter((a) => a.action === "permission");
    assert.equal(perms.length, 1);
    assert.equal(perms[0].decision, "Deny");
    assert.equal(perms[0].refId, "t-1");
  });

  it("audit seq increases monotonically", async () => {
    const svc = createMemoryService();
    const s = svc.sessionNew("cline");
    for await (const _ of svc.prompt({ sessionId: s.id, text: "x" })) {
      // drain
    }
    await svc.execTool({
      id: "t-1",
      sessionId: s.id,
      origin: "k5",
      tool: "office.docx",
      args: {},
      idempotencyKey: "k-1",
    });
    const seqs = svc.audit(s.id).map((a) => a.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    assert.deepEqual(seqs, sorted);
  });
});

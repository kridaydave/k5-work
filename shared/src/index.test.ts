import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AccessModeSchema,
  AuditSchema,
  EventSchema,
  HarnessSchema,
  OoxmlPackageSpecSchema,
  OoxmlPartSchema,
  PermissionSchema,
  PromptSchema,
  SessionSchema,
  ToolCallSchema,
} from "./index.js";

describe("shared wire contracts", () => {
  it("prompt defaults access to full", () => {
    const p = PromptSchema.parse({ sessionId: "s-1", text: "hello" });
    assert.equal(p.access, "full");
    assert.equal(AccessModeSchema.parse(undefined), "full");
  });

  it("prompt rejects empty text/session", () => {
    assert.throws(() => PromptSchema.parse({ sessionId: "", text: "x" }));
    assert.throws(() => PromptSchema.parse({ sessionId: "s-1", text: "" }));
  });

  it("access is opaque per-harness string", () => {
    const p = PromptSchema.parse({
      sessionId: "s-1",
      text: "hi",
      access: "opencode-full-bypass",
    });
    assert.equal(p.access, "opencode-full-bypass");
  });

  it("toolCall keeps harness vs k5 origin", () => {
    const ask = ToolCallSchema.parse({
      id: "t-1",
      sessionId: "s-1",
      origin: "harness",
      tool: "ask-question",
      args: { q: "which file?" },
      idempotencyKey: "k-1",
    });
    assert.equal(ask.origin, "harness");
    assert.equal(ask.tool, "ask-question");

    const k5 = ToolCallSchema.parse({
      id: "t-2",
      sessionId: "s-1",
      origin: "k5",
      tool: "browser.navigate",
      args: { url: "https://example.com" },
      idempotencyKey: "k-2",
    });
    assert.equal(k5.origin, "k5");
  });

  it("toolCall rejects missing idempotencyKey", () => {
    assert.throws(() =>
      ToolCallSchema.parse({
        id: "t-1",
        sessionId: "s-1",
        origin: "k5",
        tool: "browser.navigate",
        args: {},
        idempotencyKey: "",
      }),
    );
  });

  it("permission levels are exact", () => {
    const p = PermissionSchema.parse({ toolCallId: "t-1", level: "Deny" });
    assert.equal(p.level, "Deny");
    assert.throws(() =>
      PermissionSchema.parse({ toolCallId: "t-1", level: "Full" }),
    );
    assert.deepEqual(HarnessSchema.options, ["opencode", "kilo", "cline"]);
  });

  it("session validates harness seat", () => {
    const s = SessionSchema.parse({
      id: "s-1",
      harness: "opencode",
      status: "active",
    });
    assert.equal(s.harness, "opencode");
    assert.throws(() =>
      SessionSchema.parse({ id: "s-1", harness: "codex", status: "active" }),
    );
  });

  it("audit + event carry seq", () => {
    const a = AuditSchema.parse({
      seq: 0,
      sessionId: "s-1",
      ts: 1,
      actor: "harness",
      action: "tool",
      refId: "t-1",
    });
    assert.equal(a.seq, 0);
    const e = EventSchema.parse({
      seq: 1,
      sessionId: "s-1",
      kind: "audit",
      payload: a,
    });
    assert.equal(e.kind, "audit");
  });

  it("ooxml package spec validates parts", () => {
    const spec = OoxmlPackageSpecSchema.parse({
      parts: [
        {
          name: "word/document.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
          xml: "<w:document/>",
        },
      ],
    });
    assert.equal(spec.parts.length, 1);
    assert.throws(() => OoxmlPackageSpecSchema.parse({ parts: [] }));
    assert.throws(() =>
      OoxmlPackageSpecSchema.parse({
        parts: [{ name: "", contentType: "text/xml", xml: "<x/>" }],
      }),
    );
  });

  it("ooxml schemas reject blanks and unknown keys, default rels", () => {
    assert.throws(() =>
      OoxmlPartSchema.parse({ name: "   ", contentType: "t", xml: "x" }),
    );
    assert.throws(() =>
      OoxmlPartSchema.parse({
        name: "a",
        contentType: "t",
        xml: "x",
        extra: 1,
      }),
    );
    const spec = OoxmlPackageSpecSchema.parse({
      parts: [{ name: "a", contentType: "t", xml: "x" }],
    });
    assert.deepEqual(spec.packageRels, []);
    assert.deepEqual(spec.partRels, {});
    const withRels = OoxmlPackageSpecSchema.parse({
      parts: [{ name: "a", contentType: "t", xml: "x" }],
      packageRels: [{ type: "t", target: "x" }],
    });
    assert.equal(withRels.packageRels[0].mode, "internal");
  });
});

import {
  Audit,
  Event,
  Harness,
  Permission,
  PromptSchema,
  Session,
  ToolCall,
} from "@k5-work/shared";
import type { z } from "zod";

export type PromptInput = z.input<typeof PromptSchema>;

// Stable service interface. Plugs only spawn + translate to this.
// Service owns validation, permission gate, audit, timeouts.
// `access` on Prompt is opaque per-harness ("full" default), set in composer.
export interface K5Service {
  sessionNew(harness: Harness): Session;
  sessionLoad(id: string): Session | null;
  sessionClose(id: string): void;
  prompt(req: PromptInput): AsyncIterable<Event>;
  execTool(call: ToolCall): Promise<unknown>;
  decide(p: Permission): void;
  audit(sessionId: string): Audit[];
}

// Minimal in-memory impl for C fake-harness tests.
// Full access default: origin:'k5' validated + audited, origin:'harness'
// (incl. ask-question) streamed + audited, no k5 schema.
export function createMemoryService(): K5Service {
  const sessions = new Map<string, Session>();
  const audits: Audit[] = [];
  let seq = 0;
  let sid = 0;

  const log = (a: Omit<Audit, "seq" | "ts">) => {
    audits.push({ ...a, seq: seq++, ts: Date.now() });
  };

  return {
    sessionNew(harness) {
      const s: Session = {
        id: `s-${++sid}`,
        harness,
        status: "active",
      };
      sessions.set(s.id, s);
      log({ sessionId: s.id, actor: "service", action: "session", refId: s.id });
      return s;
    },
    sessionLoad(id) {
      return sessions.get(id) ?? null;
    },
    sessionClose(id) {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, status: "closed" });
      log({ sessionId: id, actor: "service", action: "session", refId: id });
    },
    async *prompt(req) {
      const parsed = PromptSchema.parse(req);
      log({
        sessionId: parsed.sessionId,
        actor: "user",
        action: "prompt",
        refId: parsed.sessionId,
      });
      yield {
        seq: seq++,
        sessionId: parsed.sessionId,
        kind: "chat" as const,
        payload: { text: parsed.text, access: parsed.access },
      };
    },
    async execTool(call) {
      log({
        sessionId: call.sessionId,
        actor: call.origin === "k5" ? "service" : "harness",
        action: "tool",
        refId: call.id,
      });
      return { ok: true, tool: call.tool, origin: call.origin };
    },
    decide(p) {
      log({
        sessionId: "",
        actor: "user",
        action: "permission",
        refId: p.toolCallId,
        decision: p.level,
      });
    },
    audit(sessionId) {
      return audits.filter((a) => a.sessionId === sessionId || a.sessionId === "");
    },
  };
}

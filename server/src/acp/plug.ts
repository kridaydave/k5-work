import type { Event, Harness } from "@k5-work/shared";
import type { PromptInput } from "../service.js";

// Thin plug: spawn + protocol translate + capability advertise only.
// No validation, no permission policy, no audit — service owns those.
export interface PlugCaps {
  streaming: boolean;
  toolCalls: boolean;
  permissions: boolean;
  sessions: boolean;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

export interface K5Plug {
  name: Harness;
  caps: PlugCaps;
  toHarnessPrompt(req: PromptInput): JsonRpcRequest;
  fromHarnessMessage(msg: unknown): Event | null;
}

export const OPENCODE_CAPS: PlugCaps = {
  streaming: true,
  toolCalls: true,
  permissions: true,
  sessions: true,
};

let rpcId = 0;

// First real plug: opencode over ACP stdio JSON-RPC.
// access passthrough: opaque composer string forwarded verbatim.
export function createOpencodePlug(): K5Plug {
  return {
    name: "opencode",
    caps: OPENCODE_CAPS,
    toHarnessPrompt(req) {
      return {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "session/prompt",
        params: {
          sessionId: req.sessionId,
          text: req.text,
          model: req.model,
          access: req.access,
        },
      };
    },
    fromHarnessMessage(msg) {
      const m = msg as {
        method?: string;
        params?: { sessionId?: string; text?: string; seq?: number };
      };
      if (m.method === "session/update" && m.params?.sessionId) {
        return {
          seq: m.params.seq ?? 0,
          sessionId: m.params.sessionId,
          kind: "chat",
          payload: { text: m.params.text ?? "" },
        };
      }
      return null;
    },
  };
}

// Fake harness for contract tests: records outbound, replays canned inbound.
// No business logic — proves plugs stay pure translate.
export class FakeHarness {
  recorded: JsonRpcRequest[] = [];
  private replay: unknown[] = [];

  constructor(private plug: K5Plug) {}

  sendPrompt(req: PromptInput): JsonRpcRequest {
    const out = this.plug.toHarnessPrompt(req);
    this.recorded.push(out);
    return out;
  }

  queueInbound(msg: unknown): void {
    this.replay.push(msg);
  }

  drainInbound(): Event[] {
    const events: Event[] = [];
    for (const msg of this.replay.splice(0)) {
      const e = this.plug.fromHarnessMessage(msg);
      if (e) events.push(e);
    }
    return events;
  }
}

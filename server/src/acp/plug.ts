import type { Event, Harness } from "@k5-work/shared";
import type {
  PromptRequest,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
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
      // Real ACP PromptRequest: content blocks, not a bare text field.
      const params: PromptRequest = {
        sessionId: req.sessionId,
        prompt: [{ type: "text", text: req.text }],
      };
      return {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "session/prompt",
        params: {
          ...params,
          // Composer access is k5 policy metadata, not an ACP field. It rides in
          // _meta so the seat can read it without a protocol fork.
          _meta: { k5: { access: req.access, model: req.model } },
        },
      };
    },
    fromHarnessMessage(msg) {
      const m = msg as {
        method?: string;
        params?: SessionNotification;
      };      if (m.method !== "session/update" || !m.params?.sessionId) return null;

      const update = m.params.update as SessionUpdate | undefined;
      if (!update || !("sessionUpdate" in update)) return null;

      // Only text chunks map onto today's chat event. Tool calls, plans, and
      // usage are Phase 2 work: forwarding them through a chat payload would
      // claim a shape the web cannot render.
      const text = extractTextChunk(update);
      if (text === null) return null;

      return {
        seq: 0,
        sessionId: m.params.sessionId,
        kind: "chat",
        payload: { text },
      };
    },
  };
}

function extractTextChunk(update: SessionUpdate): string | null {
  if (
    update.sessionUpdate !== "agent_message_chunk" &&
    update.sessionUpdate !== "user_message_chunk" &&
    update.sessionUpdate !== "agent_thought_chunk"
  ) {
    return null;
  }
  const content = update.content;
  if (content === undefined || content === null) return null;
  if (content.type !== "text") return null;
  return content.text;
}

// Deterministic ACP transport double for plug tests. It records outbound
// requests and replays real `session/update` notifications. It replaces the old
// record/replay helper, which spoke a guessed protocol and so could not fail
// when the real wire format moved.
export class RecordingAcpTransport {
  readonly recorded: JsonRpcRequest[] = [];
  private readonly inbound: unknown[] = [];

  record(request: JsonRpcRequest): void {
    this.recorded.push(request);
  }

  queueInbound(message: unknown): void {
    this.inbound.push(message);
  }

  drainInbound(translate: (msg: unknown) => Event | null): Event[] {
    return this.inbound.splice(0).map(translate).filter((e): e is Event => e !== null);
  }
}

// Builds a real `session/update` notification for a given update variant.
export function sessionUpdateMessage(
  sessionId: string,
  update: SessionUpdate,
): unknown {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  };
}

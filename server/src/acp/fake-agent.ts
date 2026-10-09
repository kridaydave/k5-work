// Deterministic ACP agent for tests that must not depend on a real harness.
// Speaks NDJSON JSON-RPC on stdin/stdout so the probe's framing, auth
// branching, and protocol negotiation are exercised without a model.
//
// This file is a program, not a module: importing it must not attach a stdin
// listener, because that keeps the event loop alive and hangs any consumer.
//
// Usage: node fake-agent.js <scenario>
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Json = Record<string, unknown>;

export const SCENARIOS = [
  "ok",
  "agent-auth",
  "auth-required",
  "terminal-auth",
  "protocol-mismatch",
  "session-new-auth-required",
  "echo",
  // Repeats the received prompt back verbatim. The only way a test can see what
  // the harness actually got, rather than what k5 believes it sent.
  "echo-blocks",
  "no-embedded-context",
  "slow",
  "unsupported-request",
  "long-title",
  "permission",
  "session-title",
  "meta-update",
  "no-session-caps",
  "weird-caps",
  "slow-resume",
  // Sends one last chunk *after* the prompt response. Legal ACP: the spec lets
  // an agent answer the request and then flush trailing notifications, and the
  // seat's own comments say a client cannot use the response alone as proof the
  // stream is finished. A seat must survive this and stay usable.
  "trailing-update",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

// Absent `type` is the documented "agent" default: the agent handles login
// itself through `authenticate`. This is the shape OpenCode 1.18.31 returns.
const AGENT_AUTH_METHOD = { id: "fake-login", name: "Login with fake" };

const TERMINAL_AUTH_METHOD = {
  id: "fake-tty",
  name: "Login in a terminal",
  type: "terminal",
};

export function initializeResult(scenario: Scenario): Json {
  const base: Json = {
    protocolVersion: 1,
    agentInfo: { name: "FakeAgent", version: "0.0.0" },
    // Real OpenCode 1.18.32 advertises loadSession plus
    // {close, fork, list, resume}, so the default fake matches it and the
    // capability gates are exercised on the happy path.
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
      promptCapabilities: { image: true, embeddedContext: true },
    },
    authMethods: [],
  };
  if (scenario === "no-session-caps") {
    // A harness that supports none of the session lifecycle extras. The gates
    // must refuse rather than call a method it never advertised.
    return {
      ...base,
      agentCapabilities: { loadSession: false, sessionCapabilities: {} },
    };
  }
  if (scenario === "no-embedded-context") {
    // Text prompts only. `promptCapabilities.embeddedContext` is the gate on ACP
    // `resource` blocks, so this harness provably cannot take an attachment and
    // k5 must refuse the turn rather than send a block it will drop.
    return {
      ...base,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
        promptCapabilities: { image: true },
      },
    };
  }
  if (scenario === "weird-caps") {
    // Capabilities advertised in a shape k5 does not read. The SDK's generated
    // schema drops these silently, so k5 must treat them as unsupported and say
    // so rather than failing the seat open.
    return {
      ...base,
      agentCapabilities: {
        loadSession: "true",
        sessionCapabilities: { resume: "yes" },
      },
    };
  }
  if (scenario === "terminal-auth") {
    return { ...base, authMethods: [TERMINAL_AUTH_METHOD] };
  }
  if (scenario === "auth-required" || scenario === "agent-auth") {
    return { ...base, authMethods: [AGENT_AUTH_METHOD] };
  }
  if (scenario === "protocol-mismatch") {
    return { ...base, protocolVersion: 99 };
  }
  return base;
}

/**
 * Emits a deterministic turn: a thought, three text chunks, two tool updates,
 * then a completed response. The `slow` scenario splits the text across
 * notifications so a cancel race is reproducible.
 */
function configOptionsFixture(): Json[] {
  return [
    {
      id: "model",
      name: "Model",
      type: "select",
      options: [
        { value: "opencode/space-bunny-free", name: "OpenCode Zen/Space Bunny Free" },
        { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
      ],
    },
    {
      id: "mode",
      name: "Session Mode",
      type: "select",
      options: [
        { value: "build", name: "build" },
        { value: "plan", name: "plan" },
      ],
    },
  ];
}

export function promptScript(
  scenario: Scenario,
  text: string,
  sessionId = "fake-session-1",
  blocks: unknown = null,
): {
  notifications: Json[];
  response: Json;
} {
  const notifications: Json[] = [
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "read file",
          status: "completed",
        },
      },
    },
  ];
  // A title beyond the wire cap must still be delivered by the harness; k5 is
  // responsible for truncating rather than for the update being undeliverable.
  const longTitle = "x".repeat(2_000);
  if (scenario === "long-title") {
    notifications.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: longTitle, status: "completed" },
      },
    });
  }
  // Agents auto-generate a title after the first meaningful exchange, which is
  // the only reason a stored session is not a blank row in the sidebar forever.
  if (scenario === "session-title") {
    notifications.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          title: "Refactor the session store",
          updatedAt: "2026-09-27T10:00:00.000Z",
        },
      },
    });
  }
  // A timestamp with no title. It must reach the service (so the ordering hint
  // is applied) and must NOT blank a title the session already has.
  if (scenario === "meta-update") {
    notifications.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          updatedAt: "2026-09-27T12:00:00.000Z",
        },
      },
    });
  }
  // An attachment arrives as a `resource` block, which carries no text, so a
  // prompt that only joined the text blocks would look identical to one with no
  // attachment at all. Serialising the whole received array is what makes the
  // difference observable from the outside.
  const pieces =
    scenario === "echo"
      ? [`echo: ${text}`]
      : scenario === "echo-blocks"
        ? [`blocks:${JSON.stringify(blocks)}`]
        : ["first ", "second ", "third"];
  for (const piece of pieces) {
    notifications.push({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } },
      },
    });
  }
  return {
    notifications,
    response: {
      jsonrpc: "2.0",
      id: "pending",
      result: { stopReason: scenario === "slow" ? "cancelled" : "end_turn" },
    },
  };
}

/**
 * Sessions the fake knows about, and the ids `session/load` and
 * `session/resume` accept.
 *
 * `cwd` comes from the request rather than from `process.cwd()`, because Node
 * resolves the child's own cwd to the real path: on macOS the client's temp
 * directory is a symlink under `/var` while `process.cwd()` reports
 * `/private/var`, so an exact-string filter dropped every fixture and the test
 * passed on an empty list it never meant to assert on.
 */
function knownSessions(requestedCwd: string | null): Json[] {
  const cwd = requestedCwd ?? process.cwd();
  return [
    {
      sessionId: "fake-session-1",
      cwd,
      title: "A previous task",
      updatedAt: "2026-09-27T09:00:00.000Z",
    },
    {
      sessionId: "fake-session-2",
      cwd: "/somewhere/else",
      updatedAt: "2026-09-26T09:00:00.000Z",
    },
    {
      // No title: a session the harness has not named yet.
      sessionId: "fake-session-3",
      cwd,
    },
  ];
}

/** The history a `session/load` replays, as `session/update` notifications. */
function replayScript(sessionId: string): Json[] {
  return [
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } },
      },
    },
    {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "and the earlier answer" },
        },
      },
    },
  ];
}

export function handleMessage(
  scenario: Scenario,
  message: Json,
  sessionCounter: number,
):
  | { result: Json }
  | { error: { code: number; message: string } }
  | { hold: true; permission?: boolean; sessionId?: string; holdMs?: number }
  | { trailing: true; sessionId: string } {
  const { id, method, params } = message as {
    id?: unknown;
    method: string;
    params?: Json;
  };
  if (id === undefined) return { error: { code: -32600, message: "notification ignored" } };


  switch (method) {
    case "initialize":
      return { result: initializeResult(scenario) };
    case "authenticate":
      if (scenario === "auth-required") {
        return { error: { code: -32000, message: "Authentication required" } };
      }
      return { result: {} };
    case "session/new": {
      const cwd = params?.cwd;
      if (typeof cwd !== "string" || !cwd.startsWith("/")) {
        return { error: { code: -32602, message: "cwd must be an absolute path" } };
      }
      if (scenario === "session-new-auth-required") {
        return { error: { code: -32000, message: "Authentication required" } };
      }
      // Remembered so a later set_config_option can validate against it.
      configOptions = configOptionsFixture();
      return {
        result: {
          sessionId: `fake-session-${String(sessionCounter)}`,
          configOptions,
          modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
        },
      };
    }
    case "session/set_config_option": {
      const configId = params?.configId;
      const value = params?.value;
      const offered = Array.isArray(configOptions)
        ? configOptions.find((o) => o.id === configId)
        : undefined;
      if (!offered) {
        return { error: { code: -32602, message: `unknown config option ${String(configId)}` } };
      }
      const values = (offered.options ?? []) as { value?: string }[];
      if (offered.type === "select" && !values.some((v) => v?.value === value)) {
        return { error: { code: -32602, message: `unknown value ${String(value)}` } };
      }
      const next = configOptions.map((o) =>
        o.id === configId
          ? { ...(o as Json), currentValue: value }
          : o,
      );
      configOptions = next;
      return { result: { configOptions: next } };
    }
    case "session/load": {
      // ACP requires the replay to be streamed and only then answered, and the
      // client must have attached a queue before the request was issued.
      const loadId = String(params?.sessionId ?? "");
      const known = knownSessions(typeof params?.cwd === "string" ? params.cwd : null);
      if (!known.some((s) => s.sessionId === loadId)) {
        return { error: { code: -32602, message: `no such session ${loadId}` } };
      }
      pending.push(...replayScript(loadId));
      return { result: { configOptions: configOptionsFixture() } };
    }
    case "session/resume": {
      const resumeId = String(params?.sessionId ?? "");
      const known = knownSessions(typeof params?.cwd === "string" ? params.cwd : null);
      if (!known.some((s) => s.sessionId === resumeId)) {
        return { error: { code: -32602, message: `no such session ${resumeId}` } };
      }
      // No replay: that is the whole difference between load and resume.
      if (scenario === "slow-resume") {
        // Held open, so a socket that closes mid-continuation lands inside the
        // window where the seat is adopted but not yet the connection's.
        return { hold: true, holdMs: 1_500 };
      }
      return { result: { configOptions: configOptionsFixture() } };
    }
    case "session/prompt": {
      if (scenario === "unsupported-request") {
        return { error: { code: -32601, message: "session/prompt unsupported" } };
      }
      const promptSessionId = String(params?.sessionId ?? "fake-session-1");
      const prompt = Array.isArray(params?.prompt) ? (params?.prompt as Json[]) : [];
      const text = prompt
        .filter((b) => b?.["type"] === "text")
        .map((b) => String(b?.["text"] ?? ""))
        .join("");
      const script = promptScript(scenario, text, promptSessionId, prompt);
      if (scenario === "permission") {
        pending.push(
          {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: promptSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-1",
                title: "write a file",
                kind: "edit",
                status: "pending",
              },
            },
          },
        );
        // A real harness blocks here until the client answers, then finishes
        // the turn. Answering with anything else must not be treated as consent.
        return { hold: true, permission: true, sessionId: promptSessionId };
      }
      if (scenario === "slow") {
        // Stream, then hold the response open so a cancel or a second turn can
        // race it. `stop` is resolved by run()'s drain loop.
        pending.push(...script.notifications);
        return { hold: true };
      }
      if (scenario === "trailing-update") {
        // Answer the prompt first, then flush a final chunk. The turn is over
        // from the client's point of view when the response lands, so this
        // arrives with nothing live to attribute it to.
        return { trailing: true, sessionId: promptSessionId };
      }
      pending.push(...script.notifications);
      return { result: { stopReason: "end_turn" } };
    }
    default:
      if (scenario === "unsupported-request") {
        return { error: { code: -32601, message: "unsupported in this scenario" } };
      }
      return { error: { code: -32601, message: `method not found: ${method}` } };
  }
}

/** Notifications the harness must emit after the current request resolves. */
let pending: Json[] = [];
let configOptions: Json[] = [];

function run(scenario: Scenario): void {
  let counter = 0;
  const send = (payload: Json): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // A `slow` prompt is answered only when the turn is cancelled, so a cancel
  // race and a concurrent turn are both reproducible.
  let holdId: unknown = null;
  let holdTimer: NodeJS.Timeout | null = null;
  /** The id of our outstanding permission question, if one is unanswered. */
  let outstandingPermission: number | null = null;
  /** Ids for requests the harness sends *to* the client. */
  let outboundCounter = 10_000;

  input.on("line", (line) => {
    const text = line.trim();
    if (text.length === 0) return;
    const message = JSON.parse(text) as Json;
    // A response to our own permission question, not a request from the client.
    if (message.id !== undefined && message.id === outstandingPermission) {
      outstandingPermission = null;
      const outcome = (message.result as { outcome?: { outcome?: unknown } } | null)?.outcome?.outcome;
      const chosen = outcome === "selected" ? "ran the tool" : "skipped the tool";
      // Before the stop, as a real agent does: a chunk sent after the turn's
      // response is trailing noise the client has already stopped reading.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `decision: ${chosen}` },
          },
        },
      });
      if (holdId !== null) {
        send({ jsonrpc: "2.0", id: holdId, result: { stopReason: "end_turn" } });
        holdId = null;
      }
      return;
    }
    const id = message.id;
    if (id === undefined) return;
    // Only a real session creation consumes an id, so the numbering is stable
    // regardless of how many initialize/authenticate calls preceded it.
    if (message.method === "session/new") counter += 1;
    const outcome = handleMessage(scenario, message, counter);
    // Read after the handler: the notifications are produced by it.
    const queued = pending;
    pending = [];
    // Updates are streamed *before* the response, as a real agent does. ACP
    // clients queue updates and a trailing `stop`, so responding first would
    // make the final chunks arrive after the turn was already reported done.
    for (const notification of queued) send(notification);
    if ("hold" in outcome) {
      holdId = id;
      if (outcome.permission) {
        // The client has to actually answer this request. The turn is only
        // completed once it does, which is the behaviour under test: a harness
        // must not assume it was granted.
        const permissionId = ++outboundCounter;
        outstandingPermission = permissionId;
        send({
          jsonrpc: "2.0",
          id: permissionId,
          method: "session/request_permission",
          params: {
            sessionId: outcome.sessionId,
            toolCall: {
              toolCallId: "tool-1",
              title: "write a file",
              kind: "edit",
              status: "pending",
            },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
      }
      // Bounded, so a held turn still ends on its own: a test for a cancel race
      // must not depend on the turn never finishing.
      holdTimer = setTimeout(() => {
        if (holdId === null) return;
        send({ jsonrpc: "2.0", id: holdId, result: { stopReason: "end_turn" } });
        holdId = null;
      }, outcome.holdMs ?? 8_000);
    } else if ("trailing" in outcome) {
      // The response lands first, then the last chunk. Delayed by a tick so the
      // ordering is real rather than a same-write race.
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: outcome.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "one last trailing chunk" },
            },
          },
        });
      }, 10);
    } else if ("error" in outcome) {
      send({ jsonrpc: "2.0", id, error: outcome.error });
    } else {
      send({ jsonrpc: "2.0", id, result: outcome.result });
    }
  });

  input.on("close", () => {
    if (holdTimer) clearTimeout(holdTimer);
    if (outstandingPermission !== null) {
      // Never leave the client waiting on a question that cannot be answered.
      send({ jsonrpc: "2.0", id: outstandingPermission, result: { outcome: { outcome: "cancelled" } } });
      outstandingPermission = null;
    }
    if (holdId !== null) {
      send({ jsonrpc: "2.0", id: holdId, result: { stopReason: "cancelled" } });
    }
    process.exit(0);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const scenario = (process.argv[2] ?? "ok") as Scenario;
  // An optional third argument records this process's own pid, so an external
  // reaping check can confirm the harness really died without guessing the
  // process tree.
  const pidFile = process.argv[3];
  if (pidFile !== undefined) {
    writeFileSync(pidFile, String(process.pid));
  }
  run(SCENARIOS.includes(scenario) ? scenario : "ok");
}

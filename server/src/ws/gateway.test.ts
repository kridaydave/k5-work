import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import type { BrowserCommand } from "@k5-work/shared";
import {
  DEFAULT_BOUNDS,
  OutboundQueue,
  assertOriginAllowed,
  createGateway,
  type AcceptedConnection,
  type ConnectionHandlers,
} from "./gateway.js";

const servers: Server[] = [];

after(async () => {
  for (const server of servers) {
    // A lingering keep-alive or upgraded socket would make close() hang, so the
    // sockets are destroyed first and the wait is bounded.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});

async function startGateway(
  options: Partial<Parameters<typeof createGateway>[0]> = {},
): Promise<{
  origin: string;
  gateway: ReturnType<typeof createGateway>;
  commands: BrowserCommand[];
  closed: () => number;
  overflowed: () => number;
}> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  const commands: BrowserCommand[] = [];
  let closeCount = 0;
  let overflowCount = 0;

  const gateway = createGateway({
    server,
    allowedOrigins: ["http://127.0.0.1:5173"],
    onConnect: (_c: AcceptedConnection): ConnectionHandlers => ({
      command: (c) => commands.push(c),
      overflow: () => {
        overflowCount += 1;
      },
      closed: () => {
        closeCount += 1;
      },
    }),
    ...options,
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    // The gateway only serves the /ws path, so the test URL must include it.
    origin: `ws://127.0.0.1:${port}/ws`,
    gateway,
    commands,
    closed: () => closeCount,
    overflowed: () => overflowCount,
  };
}

interface Handshake {
  ws: WebSocket;
  status: number;
}

// A refused upgrade is reported by `ws` as an 'unexpected-response' event
// carrying the status, not as an error with a statusCode, so both are watched.
function connect(url: string, headers: Record<string, string>): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("handshake timed out"));
    }, 5_000);

    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
      resolve({ ws, status });
    });
    ws.once("error", (err: Error) => {
      clearTimeout(timer);
      const err2 = err as Error & { statusCode?: number };
      resolve({ ws, status: err2.statusCode ?? 0 });
    });
    ws.once("open", () => {
      clearTimeout(timer);
      resolve({ ws, status: 101 });
    });
  });
}

async function expectStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  const { ws, status } = await connect(url, headers);
  ws.terminate();
  return status;
}

describe("origin validation", () => {
  const allowed = ["http://127.0.0.1:5173", "http://localhost:5173"];

  it("accepts an explicitly allowed origin", () => {
    for (const origin of allowed) {
      assert.doesNotThrow(() => assertOriginAllowed(origin, { allowedOrigins: allowed }));
    }
  });

  it("rejects a missing origin from a browser", () => {
    assert.throws(
      () => assertOriginAllowed(undefined, { allowedOrigins: allowed }),
      /missing Origin/,
    );
    assert.throws(
      () => assertOriginAllowed("", { allowedOrigins: allowed }),
      /missing Origin/,
    );
  });

  it("rejects the literal null origin from a sandboxed frame", () => {
    assert.throws(
      () => assertOriginAllowed("null", { allowedOrigins: allowed }),
      /origin not allowed/,
    );
  });

  it("rejects an unlisted origin", () => {
    assert.throws(
      () => assertOriginAllowed("https://evil.example", { allowedOrigins: allowed }),
      /origin not allowed/,
    );
  });

  it("fails loudly rather than denying everything silently", () => {
    assert.throws(
      () => assertOriginAllowed("http://127.0.0.1:5173", { allowedOrigins: null }),
      /K5_ALLOWED_ORIGINS is not configured/,
    );
  });

  it("tolerates a missing origin only when explicitly opted into", () => {
    assert.doesNotThrow(() =>
      assertOriginAllowed(undefined, {
        allowedOrigins: allowed,
        allowMissingOrigin: true,
      }),
    );
  });
});

describe("outbound queue bounds", () => {
  it("accepts until the byte bound, then reports overflow", () => {
    const queue = new OutboundQueue({ ...DEFAULT_BOUNDS, maxOutboundBytes: 100, maxOutboundFrames: 1000 });
    assert.equal(queue.wouldOverflow("x".repeat(50)), false);
    queue.push("x".repeat(50));
    assert.equal(queue.wouldOverflow("x".repeat(60)), true);
    assert.equal(queue.state.bytes, 50);
    assert.equal(queue.state.frames, 1);
  });

  it("reports overflow on the frame count too", () => {
    const queue = new OutboundQueue({ ...DEFAULT_BOUNDS, maxOutboundBytes: 1e9, maxOutboundFrames: 2 });
    assert.equal(queue.wouldOverflow("a"), false);
    queue.push("a");
    queue.push("b");
    assert.equal(queue.wouldOverflow("c"), true);
  });

  it("resets so a reused connection does not inherit a full queue", () => {
    const queue = new OutboundQueue({ ...DEFAULT_BOUNDS, maxOutboundFrames: 1 });
    queue.push("a");
    assert.equal(queue.wouldOverflow("b"), true);
    queue.reset();
    assert.equal(queue.wouldOverflow("b"), false);
  });
});

describe("gateway upgrade", () => {
  it("accepts an allowed origin and delivers a valid command", async () => {
    const g = await startGateway();
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    ws.send(
      JSON.stringify({
        commandId: "c-1",
        type: "session.close",
        sessionId: "s-1",
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(g.commands.length, 1);
    assert.equal(g.commands[0].type, "session.close");
    ws.terminate();
  });

  it("refuses a disallowed origin before the handshake completes", async () => {
    const g = await startGateway();
    const status = await expectStatus(g.origin, { Origin: "https://evil.example" });
    assert.equal(status, 403);
  });

  it("refuses a missing origin by default", async () => {
    const g = await startGateway();
    const status = await expectStatus(g.origin, {});
    assert.equal(status, 403);
  });

  it("refuses the null origin", async () => {
    const g = await startGateway();
    const status = await expectStatus(g.origin, { Origin: "null" });
    assert.equal(status, 403);
  });

  it("refuses every upgrade when no allowlist is configured", async () => {
    const g = await startGateway({ allowedOrigins: null });
    const status = await expectStatus(g.origin, { Origin: "http://127.0.0.1:5173" });
    assert.equal(status, 500);
  });

  it("rejects a binary frame instead of guessing at it", async () => {
    const g = await startGateway();
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    ws.send(Buffer.from([1, 2, 3]));
    const [code, reason] = (await once(ws, "close")) as [number, Buffer];
    assert.equal(code, 1003);
    assert.match(reason.toString(), /binary/);
  });

  it("answers an unparseable command with a correlated failure, not silence", async () => {
    const g = await startGateway();
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    const received: unknown[] = [];
    ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    ws.send("{ not json");
    ws.send(JSON.stringify({ commandId: "c-9", type: "session.hack" }));
    await new Promise((r) => setTimeout(r, 80));
    // Unparseable JSON has no recoverable id, so it is dropped; the well-formed
    // but unknown command is answered.
    assert.equal(g.commands.length, 0);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      type: "command.result",
      commandId: "c-9",
      ok: false,
      reason: "invalid-payload",
    });
    ws.terminate();
  });

  it("closes a connection that exceeds the command rate limit", async () => {
    const g = await startGateway({
      bounds: { commandRateLimit: 3, commandRateWindowMs: 60_000 },
    });
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ commandId: `c-${i}`, type: "session.close", sessionId: "s-1" }));
    }
    const [code, reason] = (await once(ws, "close")) as [number, Buffer];
    assert.equal(code, 1008);
    assert.match(reason.toString(), /rate limit/);
  });

  it("refuses a frame larger than the payload bound", async () => {
    const g = await startGateway({ bounds: { maxPayloadBytes: 256 } });
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    ws.send(
      JSON.stringify({
        commandId: "c-1",
        type: "session.prompt",
        sessionId: "s-1",
        turnId: "t-1",
        text: "x".repeat(1000),
      }),
    );
    const [code] = (await once(ws, "close")) as [number, Buffer];
    assert.equal(code, 1009);
  });

  it("caps concurrent sockets", async () => {
    const g = await startGateway({ bounds: { maxSockets: 1 } });
    const first = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    const second = await expectStatus(g.origin, { Origin: "http://127.0.0.1:5173" });
    assert.equal(second, 503);
    first.ws.terminate();
  });

  it("refuses a socket that does not ask for /ws", async () => {
    const g = await startGateway();
    const status = await expectStatus(g.origin.replace("/ws", "/other"), {
      Origin: "http://127.0.0.1:5173",
    });
    assert.notEqual(status, 101);
  });

  it("closes a slow consumer with a typed reason instead of dropping a frame", async () => {
    const g = await startGateway({
      bounds: { maxOutboundFrames: 2, maxOutboundBytes: 1e9 },
    });
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    const connection = [...g.gateway.connections][0];
    const event = {
      type: "turn.delta",
      sessionId: "s-1",
      turnId: "t-1",
      stream: "text",
      text: "x",
    } as const;

    const closed = once(ws, "close");
    const results = [connection.send(event), connection.send(event), connection.send(event)];
    const [code, reason] = (await closed) as [number, Buffer];

    assert.deepEqual(results, [true, true, false], "the third send must report overflow");
    assert.equal(code, 1013, "overflow must close with a retryable code");
    assert.match(reason.toString(), /outbound overflow/);
    assert.equal(g.overflowed(), 1, "the handler must be told, to resolve pending permissions");
    // The server releases its own bookkeeping only after the peer acknowledges
    // the close frame, so this waits for the real transition.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(g.gateway.connections.size, 0, "the socket must be released");
  });

  // S1: the bound must describe frames still in flight, not a lifetime total.
  it("does not wedge a connection once the client drains", async () => {
    const g = await startGateway({
      bounds: { maxOutboundFrames: 3, maxOutboundBytes: 1e9 },
    });
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    const connection = [...g.gateway.connections][0];
    const event = {
      type: "turn.delta",
      sessionId: "s-1",
      turnId: "t-1",
      stream: "text",
      text: "x",
    } as const;

    let accepted = 0;
    for (let i = 0; i < 60; i++) {
      if (connection.send(event)) accepted += 1;
      // Awaiting each send models a client that keeps up: the socket flushes,
      // in-flight accounting returns to zero, and the bound is never reached.
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.equal(accepted, 60, "a draining client must never be cut off");
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.terminate();
  });

  it("refuses to emit an event that violates the contract", async () => {
    const g = await startGateway();
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    const connection = [...g.gateway.connections][0];
    assert.throws(
      () =>
        connection.send({
          type: "turn.delta",
          sessionId: "s-1",
          turnId: "t-1",
          stream: "not-a-stream",
          text: "x",
        } as never),
      /invalid turn.delta event/,
    );
    ws.terminate();
  });

  it("notifies the handler exactly once when a socket closes", async () => {
    const g = await startGateway();
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    assert.equal(g.gateway.connections.size, 1);
    ws.close();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(g.gateway.connections.size, 0);
    assert.equal(g.closed(), 1);
  });

  it("closes every live socket on shutdown", async () => {
    const g = await startGateway();
    const { ws } = await connect(g.origin, { Origin: "http://127.0.0.1:5173" });
    await g.gateway.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(g.gateway.connections.size, 0);
    assert.notEqual(ws.readyState, WebSocket.OPEN);
  });
});

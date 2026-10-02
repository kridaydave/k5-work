import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BrowserCommandSchema,
  ServerEventSchema,
  type BrowserCommand,
  type ServerEvent,
} from "@k5-work/shared";

export class OriginRejectedError extends Error {
  constructor(readonly origin: string | null) {
    super(
      origin === null
        ? "missing Origin header"
        : `origin not allowed: ${origin}`,
    );
    this.name = "OriginRejectedError";
  }
}

export interface OriginCheckOptions {
  allowedOrigins: readonly string[] | null;
  /** Tolerates a missing Origin for non-browser clients. Never for a browser. */
  allowMissingOrigin?: boolean;
}

/**
 * Rejects a missing browser Origin, the literal `null` origin, and anything not
 * on the allowlist. `Host` is deliberately not consulted: it is
 * attacker-controlled in a rebinding attack, which is what this guards.
 */
export function assertOriginAllowed(
  requestOrigin: string | undefined,
  options: OriginCheckOptions,
): void {
  if (options.allowedOrigins === null) {
    // A silent deny-all would look like a broken proxy. Fail the reason loudly.
    throw new Error(
      "K5_ALLOWED_ORIGINS is not configured; refusing every upgrade rather than denying silently",
    );
  }
  if (requestOrigin === undefined || requestOrigin.length === 0) {
    if (options.allowMissingOrigin === true) return;
    throw new OriginRejectedError(null);
  }
  // `Origin: null` is what a sandboxed iframe, a data: document, and some
  // redirect flows send. None of them is the dev or preview origin.
  if (requestOrigin === "null" || !options.allowedOrigins.includes(requestOrigin)) {
    throw new OriginRejectedError(requestOrigin);
  }
}

export interface GatewayBounds {
  /** Largest accepted inbound frame. The first slice is text-only. */
  maxPayloadBytes: number;
  /** Outbound queue depth before the socket is closed as a slow consumer. */
  maxOutboundBytes: number;
  maxOutboundFrames: number;
  commandRateLimit: number;
  commandRateWindowMs: number;
  maxSockets: number;
}

export const DEFAULT_BOUNDS: GatewayBounds = {
  maxPayloadBytes: 64 * 1024,
  maxOutboundBytes: 1024 * 1024,
  maxOutboundFrames: 256,
  commandRateLimit: 20,
  commandRateWindowMs: 10_000,
  maxSockets: 8,
};

export interface OutboundQueueState {
  bytes: number;
  frames: number;
}

/**
 * Bounded count of frames still in flight, not a lifetime total.
 *
 * The bound has to describe what the socket has not yet flushed, or a single
 * streaming turn would exhaust a lifetime budget and wedge the connection
 * permanently while the client sits there fully caught up.
 */
export class OutboundQueue {
  private bytes = 0;
  private frames = 0;

  constructor(private readonly bounds: GatewayBounds) {}

  get state(): OutboundQueueState {
    return { bytes: this.bytes, frames: this.frames };
  }

  wouldOverflow(payload: string): boolean {
    return (
      this.bytes + Buffer.byteLength(payload) > this.bounds.maxOutboundBytes ||
      this.frames + 1 > this.bounds.maxOutboundFrames
    );
  }

  push(payload: string): void {
    this.bytes += Buffer.byteLength(payload);
    this.frames += 1;
  }

  /** Called once the socket has actually flushed the frame. */
  release(payload: string): void {
    this.bytes = Math.max(0, this.bytes - Buffer.byteLength(payload));
    this.frames = Math.max(0, this.frames - 1);
  }

  reset(): void {
    this.bytes = 0;
    this.frames = 0;
  }
}

/** RFC 6455 caps a close reason at 123 *bytes*; slicing UTF-16 units can exceed it. */
export function fitCloseReason(reason: string, limit = 120): string {
  const buffer = Buffer.from(reason, "utf8");
  if (buffer.length <= limit) return reason;
  // Truncate on a byte budget without splitting a multi-byte character.
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, limit));
}

export interface AcceptedConnection {
  readonly socket: WebSocket;
  readonly queue: OutboundQueue;
  /** Returns false when the outbound bound is hit; the caller must then close. */
  send(event: ServerEvent): boolean;
  close(code: number, reason: string): void;
}

export interface ConnectionHandlers {
  /**
   * Resolves when any in-flight work this connection owns has finished, such as
   * a seat teardown or a session read that is holding a harness process. Optional
   * because a handler with nothing to wait for need not implement it.
   */
  waitForIdle?(): Promise<void>;
  command(command: BrowserCommand): void;
  /**
   * The outbound bound was hit. The socket is being closed, so this is the last
   * chance to resolve any pending permission request locally; dropping one
   * silently would leave the agent blocked forever.
   */
  overflow(): void;
  closed(): void;
}

export interface GatewayOptions {
  server: {
    on(
      event: "upgrade",
      listener: (
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ) => void,
    ): unknown;
  };
  allowedOrigins: readonly string[] | null;
  bounds?: Partial<GatewayBounds>;
  allowMissingOrigin?: boolean;
  onConnect: (connection: AcceptedConnection) => ConnectionHandlers;
}

export interface Gateway {
  readonly connections: Set<AcceptedConnection>;
  close(): Promise<void>;
  /**
   * Waits for every live connection to finish its in-flight work.
   *
   * A handler may be mid-request when the socket closes — a session read owns a
   * harness process that nothing else knows about. Without this, a shutdown that
   * lands during one exits clean with the process still running.
   */
  settle(): Promise<void>;
}

export const WS_PATH = "/ws";

/** How long a client may take to acknowledge a close frame before termination. */
const CLOSE_GRACE_MS = 1_000;

/** One socket per browser tab, with the session-ownership map kept by the caller. */
export function createGateway(options: GatewayOptions): Gateway {
  const bounds = { ...DEFAULT_BOUNDS, ...options.bounds };
  const connections = new Set<AcceptedConnection>();
  const handlersBySocket = new Map<WebSocket, ConnectionHandlers>();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: bounds.maxPayloadBytes,
    // Off initially: compression costs CPU on a local socket and buys a single
    // tab nothing.
    perMessageDeflate: false,
  });
  // Without this, a server-side socket error is an unhandled 'error' event and
  // takes the process down.
  wss.on("error", () => undefined);

  options.server.on("upgrade", (req, socket, head) => {
    if ((req.url?.split("?", 1)[0] ?? "") !== WS_PATH) {
      socket.destroy();
      return;
    }

    try {
      assertOriginAllowed(req.headers.origin, {
        allowedOrigins: options.allowedOrigins,
        ...(options.allowMissingOrigin === undefined
          ? {}
          : { allowMissingOrigin: options.allowMissingOrigin }),
      });
    } catch (err) {
      // Refused before the handshake completes, so a rejected origin never
      // becomes a live socket.
      const forbidden =
        err instanceof Error && err.name === "OriginRejectedError";
      const status = forbidden ? "403 Forbidden" : "500 Internal Server Error";
      socket.write(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
      return;
    }

    if (connections.size >= bounds.maxSockets) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const queue = new OutboundQueue(bounds);
      const connection: AcceptedConnection = {
        socket: ws,
        queue,
        send(event) {
          if (ws.readyState !== ws.OPEN) return false;
          // Validated outbound too, so a malformed internal event is caught here
          // rather than reaching the client as unparseable noise.
          const parsed = ServerEventSchema.safeParse(event);
          if (!parsed.success) {
            throw new Error(
              `refusing to emit an invalid ${String((event as { type?: unknown }).type)} event: ${parsed.error.message}`,
            );
          }
          const payload = JSON.stringify(parsed.data);
          if (queue.wouldOverflow(payload)) {
            // Overflow closes the connection with a typed reason. Returning
            // false alone would let a permission request vanish silently and
            // strand the agent on an answer that will never come.
            handlers.overflow();
            connection.close(1013, "outbound overflow");
            return false;
          }
          queue.push(payload);
          ws.send(payload, () => queue.release(payload));
          return true;
        },
        close(code, reason) {
          if (ws.readyState === ws.CLOSED) return;
          try {
            ws.close(code, fitCloseReason(reason));
          } catch {
            // A close that cannot be framed must still release the socket;
            // otherwise teardown waits on a peer that was never told.
            ws.terminate();
          }
        },
      };

      const handlers = options.onConnect(connection);
      handlersBySocket.set(ws, handlers);
      connections.add(connection);

      let windowStart = Date.now();
      let accepted = 0;

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          // The first slice is text-only. A binary frame is not a protocol
          // event and must not be guessed at.
          connection.close(1003, "binary frames are not accepted");
          return;
        }

        const now = Date.now();
        if (now - windowStart > bounds.commandRateWindowMs) {
          windowStart = now;
          accepted = 0;
        }
        accepted += 1;
        if (accepted > bounds.commandRateLimit) {
          connection.close(1008, "command rate limit exceeded");
          return;
        }

        const raw = typeof data === "string" ? data : data.toString("utf8");
        const parsed = BrowserCommandSchema.safeParse(parseJson(raw));
        if (!parsed.success) {
          // Recover the correlation id so the failure is attributable; without
          // one the client would wait forever on a request it cannot match.
          const id = recoverCommandId(raw);
          if (id) {
            connection.send({
              type: "command.result",
              commandId: id,
              ok: false,
              reason: "invalid-payload",
            });
          }
          return;
        }
        handlers.command(parsed.data);
      });

      ws.on("error", () => {
        // A transport error is followed by 'close'; the cleanup lives there.
      });

      ws.on("close", () => {
        connections.delete(connection);
        queue.reset();
        handlersBySocket.delete(ws);
        try {
          handlers.closed();
        } catch {
          // A handler that throws during teardown must not abort the remaining
          // cleanup, and must not become an uncaught exception.
        }
      });
    });
  });

  return {
    connections,
    async close() {
      const pending = new Set<WebSocket>(handlersBySocket.keys());
      for (const connection of [...connections]) {
        connection.close(1001, "server shutting down");
      }
      // A client that ignores the close frame must not hold shutdown open, and
      // the wait must not resolve until every handler has seen its close: a
      // caller that reaps harness children while a session still believes it is
      // live would resolve permissions as child-failure instead of socket-closed.
      const grace = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, CLOSE_GRACE_MS);
      grace.unref();

      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
        if (pending.size === 0) resolve();
        else {
          const check = (): void => {
            if (pending.size === 0) resolve();
          };
          const interval = setInterval(check, 10);
          interval.unref();
          wss.once("close", () => clearInterval(interval));
        }
      });
      clearTimeout(grace);
      connections.clear();
      handlersBySocket.clear();
    },
    async settle() {
      // Snapshot first: a handler may add to this set as its own teardown runs.
      const handlers = [...new Set(handlersBySocket.values())];
      await Promise.all(
        handlers.map(async (handler) => {
          try {
            await handler.waitForIdle?.();
          } catch {
            // A handler that throws while reporting idle must not hold shutdown
            // open; its own cleanup has already been attempted.
          }
        }),
      );
    },
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return Symbol.for("k5.invalid-json");
  }
}

function recoverCommandId(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { commandId?: unknown };
    return typeof parsed.commandId === "string" && parsed.commandId.length > 0
      ? parsed.commandId
      : null;
  } catch {
    return null;
  }
}

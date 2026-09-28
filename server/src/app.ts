import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { handleProjectApiRequest } from "./project-api.js";
import { handleSessionApiRequest, isSessionApiPath } from "./session-api.js";
import type { SessionStore } from "./store/session-store.js";
import { isAllowedHostHeader, REQUEST_TIMEOUT_MS, type ServerConfig } from "./env.js";
import {
  createGateway,
  type AcceptedConnection,
  type ConnectionHandlers,
  type Gateway,
  type GatewayBounds,
} from "./ws/gateway.js";

export interface K5App {
  readonly server: Server;
  readonly config: ServerConfig;
  /** Upgraded sockets, which server.close() will not reap. */
  readonly upgraded: ReadonlySet<Duplex>;
  readonly gateway: Gateway;
  closeUpgraded(): number;
}

export interface CreateAppOptions {
  config: ServerConfig;
  bounds?: Partial<GatewayBounds>;
  /**
   * Read side of the durable session store. Optional so a test can exercise the
   * existing HTTP surface without standing up a store; when absent the session
   * routes report that history is unavailable rather than 404-ing ambiguously.
   */
  store?: SessionStore;
  /**
   * Called once per accepted browser socket. Required on purpose: a server with
   * no command sink would accept a browser, validate its commands, and discard
   * them, leaving the UI waiting on a request it can never match.
   */
  onConnect: (connection: AcceptedConnection) => ConnectionHandlers;
}

// Grace is the window in which sockets may close on their own; the hard
// deadline is when teardown is declared failed. They must differ, or the grace
// phase is zero-length and `clean` becomes a coin flip on timer ordering.
export const SHUTDOWN_GRACE_MS = 2_000;
export const SHUTDOWN_HARD_MS = 8_000;


export function createApp(options: CreateAppOptions): K5App {
  const { config } = options;
  const upgraded = new Set<Duplex>();
  const server = createServer((req, res) => {
    if (!isAllowedHostHeader(req.headers.host, config)) {
      // DNS rebinding makes a request same-origin, so this must be answered
      // before any routing rather than relying on CORS.
      res.statusCode = 421;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Misdirected request: unknown Host" }));
      return;
    }

    if (req.url?.split("?", 1)[0] === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const notFound = (): void => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Not found" }));
    };

    // One dispatch chain, so exactly one handler answers. Each handler calls
    // `next()` only for paths that are not its own, which is the signal to keep
    // looking; passing a shared terminal 404 to both would let the first one end
    // the response and leave the second unable to reply.
    let notAProjectRoute = false;
    handleProjectApiRequest(req, res, () => {
      notAProjectRoute = true;
    }, config.workspaceRoot);
    if (!notAProjectRoute) return;

    // The same predicate the session handler uses, so /api/sessionsfoo is a 404
    // rather than being treated as a session route.
    const isSessionPath = isSessionApiPath(req.url?.split("?", 1)[0] ?? "");
    if (options.store === undefined) {
      if (isSessionPath) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ error: "Stored session history is unavailable" }));
        return;
      }
      notFound();
      return;
    }
    void handleSessionApiRequest(req, res, notFound, { store: options.store }).catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "The session store failed" }));
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;

  // Tracking here rather than in the gateway: teardown must see upgraded
  // sockets even if the gateway is mid-handshake, and an upgraded socket
  // ignores closeAllConnections().
  server.on("upgrade", (_req, socket) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
  });

  const gateway = createGateway({
    server,
    // A missing allowlist fails every upgrade loudly inside the gateway rather
    // than degrading into a silent deny-all that looks like a broken proxy.
    allowedOrigins: config.allowedOrigins,
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    onConnect: options.onConnect,
  });

  return {
    server,
    config,
    upgraded,
    gateway,
    closeUpgraded() {
      const survivors = [...upgraded];
      for (const socket of survivors) socket.destroy();
      return survivors.length;
    },
  };
}

export interface ShutdownResult {
  /** False when the listener itself did not close before the hard deadline. */
  clean: boolean;
  /** Sockets and captured child identifiers that survived their own deadline. */
  unreaped: string[];
}

export interface ShutdownHooks {
  /**
   * Close browser sockets and reap captured children. Called before
   * server.close. Returns identifiers that survived its own deadline.
   */
  drainConnections?: () => Promise<string[]>;
}

export async function shutdown(
  app: K5App,
  hooks: ShutdownHooks = {},
): Promise<ShutdownResult> {
  const fromDrain = await (hooks.drainConnections?.() ?? Promise.resolve([]));

  const closed = new Promise<void>((resolve) => {
    app.server.close(() => resolve());
  });

  // Both timers stay ref'd: an unref'd hard deadline can be skipped entirely if
  // the loop drains first, which would exit 0 with teardown silently incomplete.
  const timers: NodeJS.Timeout[] = [];
  try {
    timers.push(
      setTimeout(() => {
        app.server.closeAllConnections?.();
      }, SHUTDOWN_GRACE_MS),
    );

    const outcome = await new Promise<"closed" | "timeout">((resolve) => {
      const hardTimer = setTimeout(() => resolve("timeout"), SHUTDOWN_HARD_MS);
      timers.push(hardTimer);
      closed.then(() => {
        clearTimeout(hardTimer);
        resolve("closed");
      });
    });

    if (outcome === "timeout") {
      return { clean: false, unreaped: [...fromDrain, ...describeUpgraded(app)] };
    }
    const destroyed = app.closeUpgraded();
    return {
      clean: true,
      unreaped: [
        ...fromDrain,
        ...(destroyed > 0 ? [`${destroyed} upgraded socket(s)`] : []),
      ],
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

function describeUpgraded(app: K5App): string[] {
  return app.upgraded.size > 0 ? [`${app.upgraded.size} upgraded socket(s)`] : [];
}

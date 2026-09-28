import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, shutdown } from "./app.js";
import { loadServerConfig } from "./env.js";
import { SeatRegistry } from "./acp/seat-registry.js";
import { MAX_SEATS, SEAT_IDLE_TTL_MS, SeatPool } from "./acp/seat-pool.js";
import { SeatRunner } from "./acp/seat-runner.js";
import { createSessionHandlers } from "./acp/session-service.js";
import { discoverLocalProjects } from "./projects.js";
import { SessionStore } from "./store/session-store.js";

// Resolved once, at module scope, and passed into the config. Moving this file
// must not change which directory is treated as the workspace seed.
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

let config;
try {
  config = loadServerConfig({ workspaceRoot });
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

// With no error listener, an EPIPE on stderr (a closed terminal, a rotated
// log pipe) surfaces as an uncaught exception and takes the process down. The
// gateway already does this for its websocket.
process.stderr.on("error", () => {});

const seats = new SeatRegistry();
const pool = new SeatPool({
  maxSeats: MAX_SEATS,
  idleTtlMs: SEAT_IDLE_TTL_MS,
});
const runner = new SeatRunner({
  pool,
  acpCommand: config.acpCommand,
  disableLiveSeats: config.disableLiveSeats,
});

// k5 is the store for transcripts. Opened here rather than at module scope,
// because opening repairs a torn log tail and prunes by age, and that is real
// filesystem work that must not happen when a module is merely imported.
const store = new SessionStore({
  root: config.storeRoot,
  onError: (error) => {
    // Loud rather than silent: a full disk or an unwritable store otherwise
    // produces zero diagnostics and a sidebar that silently stops remembering.
    process.stderr.write(`k5 session store: ${error.message}\n`);
  },
});

// A project id is only honoured if the server itself issued it, so the browser
// can never present a path the service has not discovered and canonicalized.
// Re-discovered per open because a project may have appeared since boot.
const projects = {
  resolve(projectId: string): string | null {
    for (const project of discoverLocalProjects(undefined, workspaceRoot).projects) {
      if (project.id === projectId) return project.path;
    }
    return null;
  },
};

const app = createApp({
  config,
  store,
  onConnect: (connection) =>
    createSessionHandlers(connection, {
      runner,
      pool,
      projects,
      recorder: {
        create: (input) => store.create(input),
        append: (storeId, event) => store.append(storeId, event),
        flush: (storeId) => store.flushMeta(storeId),
        setTitle: (storeId, title, updatedAt) => store.setTitle(storeId, title, updatedAt),
        titleFromPrompt: (storeId, prompt) => store.titleFromPrompt(storeId, prompt),
        remove: (storeId) => store.remove(storeId),
        stored: (storeId) => store.stored(storeId),
      },
      trackSeat: (child) => seats.register(child),
      untrackSeat: (child) => seats.unregister(child),
      onAudit: (entry) => {
        process.stdout.write(
          `k5 audit ${entry.action} session=${entry.sessionId ?? "-"} ${entry.detail}\n`,
        );
      },
    }),
});

// The store is opened before the listener, so /api/sessions never answers from a
// half-loaded index. A store that cannot be opened is fatal rather than
// degraded: the alternative is a workspace whose history silently forgets.
store.open().then(
  () => {
    app.server.listen(config.port, config.host, () => {
      process.stdout.write(
        `k5-work server listening on ${config.host}:${config.port}\n`,
      );
      process.stdout.write(`k5 session store at ${config.storeRoot}\n`);
      if (config.allowedOrigins === null) {
        // Loud rather than silent: every /ws upgrade will be refused, and an
        // operator should not have to read a browser console to learn why.
        process.stderr.write(
          "K5_ALLOWED_ORIGINS is unset; /ws upgrades will be refused with 500\n",
        );
      }
    });
  },
  (err: unknown) => {
    process.stderr.write(
      `k5 could not open the session store at ${config.storeRoot}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  },
);

// Registered with `on`, not `once`: the first signal starts graceful teardown
// and a second one escalates rather than being silently ignored.
let shuttingDown = false;

async function terminate(): Promise<void> {
  const result = await shutdown(app, {
    drainConnections: async () => {
      // Order matters: a live socket must stop asking for work before the seat
      // it is bound to is torn down, and upgraded sockets ignore
      // closeAllConnections(), so the gateway closes them itself.
      const unreaped: string[] = [];
      try {
        // Close the gateway first so no new socket can start work, then wait for
        // whatever each connection already had in flight. Without this a shutdown
        // that lands mid-read exits with a live harness behind it.
        await app.gateway.close();
        await app.gateway.settle();
        const survivors = await seats.closeAll();
        unreaped.push(...survivors.map((pid) => `acp child pid ${pid}`));
        if (app.upgraded.size > 0) {
          unreaped.push(`${String(app.upgraded.size)} upgraded socket(s)`);
        }
      } catch (err) {
        // A drain that throws must not skip the listener close, or shutdown
        // hangs with the port still bound.
        unreaped.push(`drain failed: ${(err as Error).message}`);
        try {
          await app.gateway.close();
        } catch {
          // already failing; the server close below still has to run
        }
      }
      // Flushed after the seats are down, so the last events of a turn that was
      // in flight during shutdown are on disk before the process leaves. Each
      // flush drains that session's own append queue first, so the summary it
      // writes can never describe records whose lines are still queued.
      try {
        await store.flushAll();
      } catch (err) {
        unreaped.push(`store flush failed: ${(err as Error).message}`);
      }
      return unreaped;
    },
  });
  // Every handle is closed even on a clean shutdown, so a restart on the same
  // root finds no open descriptor.
  await store.close().catch(() => {});
  if (!result.clean || result.unreaped.length > 0) {
    process.stderr.write(
      `k5-work shutdown incomplete: clean=${String(result.clean)} ` +
        `unreaped=${JSON.stringify(result.unreaped)}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      process.stderr.write(
        `k5-work received ${signal} during shutdown; exiting non-zero\n`,
      );
      process.exit(1);
    }
    shuttingDown = true;
    void terminate();
  });
}

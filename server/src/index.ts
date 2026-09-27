import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, shutdown } from "./app.js";
import { loadServerConfig } from "./env.js";
import { SeatRegistry } from "./acp/seat-registry.js";
import { MAX_SEATS, SEAT_IDLE_TTL_MS, SeatPool } from "./acp/seat-pool.js";
import { SeatRunner } from "./acp/seat-runner.js";
import { createSessionHandlers } from "./acp/session-service.js";
import { discoverLocalProjects } from "./projects.js";

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
  onConnect: (connection) =>
    createSessionHandlers(connection, {
      runner,
      pool,
      projects,
      trackSeat: (child) => seats.register(child),
      untrackSeat: (child) => seats.unregister(child),
      onAudit: (entry) => {
        process.stdout.write(
          `k5 audit ${entry.action} session=${entry.sessionId ?? "-"} ${entry.detail}\n`,
        );
      },
    }),
});

app.server.listen(config.port, config.host, () => {
  process.stdout.write(
    `k5-work server listening on ${config.host}:${config.port}\n`,
  );
  if (config.allowedOrigins === null) {
    // Loud rather than silent: every /ws upgrade will be refused, and an
    // operator should not have to read a browser console to learn why.
    process.stderr.write(
      "K5_ALLOWED_ORIGINS is unset; /ws upgrades will be refused with 500\n",
    );
  }
});

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
        await app.gateway.close();
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
      return unreaped;
    },
  });
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

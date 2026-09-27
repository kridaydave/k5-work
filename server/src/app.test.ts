import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createApp, shutdown } from "./app.js";
import { loadServerConfig } from "./env.js";
import { SeatRegistry } from "./acp/seat-registry.js";
import { spawnAcpChild } from "./acp/spawn.js";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface RawResponse {
  status: number;
  body: string;
}

// fetch() silently drops `Host` because it is a forbidden header name, so the
// rebinding guard has to be exercised over a raw request or it looks like it
// works while proving nothing.
function rawRequest(
  port: number,
  path: string,
  options: { host?: string; method?: string; body?: string; contentType?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          ...(options.host === undefined ? {} : { Host: options.host }),
          ...(options.body === undefined
            ? {}
            : { "Content-Type": options.contentType ?? "application/json" }),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function buildApp(env: NodeJS.ProcessEnv = {}) {
  return createApp({
    config: loadServerConfig({ env, workspaceRoot: repoRoot }),
    // The sink is required so a test can never accidentally exercise a server
    // that accepts a browser and discards its commands.
    onConnect: () => ({
      command: () => undefined,
      overflow: () => undefined,
      closed: () => undefined,
    }),
  });
}

// Config validation rightly refuses PORT=0, so tests bind an ephemeral port at
// listen time instead of smuggling it through the environment.
async function listen(app: ReturnType<typeof buildApp>): Promise<number> {
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  return (app.server.address() as AddressInfo).port;
}

describe("server app", () => {
  it("serves the exact health body and closes cleanly", async () => {
    const app = buildApp();
    const port = await listen(app);
    try {
      const res = await rawRequest(port, "/health", { host: `127.0.0.1:${port}` });
      assert.equal(res.status, 200);
      assert.equal(res.body, '{"status":"ok"}');
    } finally {
      const result = await shutdown(app);
      assert.equal(result.clean, true);
      assert.deepEqual(result.unreaped, []);
    }
  });

  it("still serves project discovery from the Node server", async () => {
    const app = buildApp();
    const port = await listen(app);
    try {
      const res = await rawRequest(port, "/api/projects", { host: `127.0.0.1:${port}` });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      assert.ok("projects" in body);
      assert.ok("currentProjectPath" in body);
    } finally {
      await shutdown(app);
    }
  });

  it("404s an unknown path as JSON", async () => {
    const app = buildApp();
    const port = await listen(app);
    try {
      const res = await rawRequest(port, "/nope", { host: `127.0.0.1:${port}` });
      assert.equal(res.status, 404);
      assert.deepEqual(JSON.parse(res.body), { error: "Not found" });
    } finally {
      await shutdown(app);
    }
  });
});

// DNS rebinding makes a request same-origin, so CORS cannot save this surface.
// A rebound name must be refused before any routing happens.
describe("host header guard", () => {
  it("rejects a rebound Host on reads and on health", async () => {
    const app = buildApp();
    const port = await listen(app);
    try {
      for (const path of ["/api/projects", "/health", "/"]) {
        const res = await rawRequest(port, path, { host: "evil.example:8787" });
        assert.equal(res.status, 421, `${path} must refuse a rebound Host`);
        assert.deepEqual(JSON.parse(res.body), {
          error: "Misdirected request: unknown Host",
        });
      }
    } finally {
      await shutdown(app);
    }
  });

  it("rejects the write path too, not just reads", async () => {
    const app = buildApp();
    const port = await listen(app);
    try {
      const res = await rawRequest(port, "/api/projects/open", {
        method: "POST",
        host: "attacker.test:8787",
        body: JSON.stringify({ path: "/etc" }),
      });
      assert.equal(res.status, 421, "a rebound Host must not open arbitrary dirs");
    } finally {
      await shutdown(app);
    }
  });

  it("accepts loopback names with and without a port", async () => {
    const app = buildApp();
    const port = await listen(app);
    try {
      for (const host of [
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
        "127.0.0.1",
        "localhost",
        `127.0.0.1:${port + 1}`,
      ]) {
        const res = await rawRequest(port, "/health", { host });
        assert.equal(res.status, 200, `Host ${host} must be accepted`);
      }
    } finally {
      await shutdown(app);
    }
  });
});

// The drain hook is the only thing that can reap an upgraded socket, since
// closeAllConnections() ignores them. This proves a real child is reaped.
describe("shutdown drain", () => {
  it("reaps a real captured child through the registry", async () => {
    const seats = new SeatRegistry();
    const child = await spawnAcpChild({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: repoRoot,
    });
    seats.register(child);
    assert.equal(seats.size, 1);
    const pid = child.pid;
    assert.ok(typeof pid === "number");

    const app = buildApp();
    await listen(app);
    const survivors = await seats.closeAll();

    assert.deepEqual(survivors, [], "a cooperative child must be reaped");
    assert.equal(seats.size, 0);
    // The captured process is genuinely gone, not merely detached.
    await child.exited;
    assert.equal(child.pid, pid);
    assert.equal(isAlive(pid), false, `pid ${pid} must no longer exist`);

    const result = await shutdown(app, {
      drainConnections: async () => survivors.map((p) => `acp child pid ${p}`),
    });
    assert.equal(result.clean, true);
    assert.deepEqual(result.unreaped, []);
  });

  it("forgets a child that already exited on its own", async () => {
    const seats = new SeatRegistry();
    const child = await spawnAcpChild({
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: repoRoot,
    });
    seats.register(child);
    await child.exited;
    await new Promise((r) => setImmediate(r));
    assert.equal(seats.size, 0, "a reaped child must not linger in the registry");
    assert.deepEqual(await seats.closeAll(), []);
  });
});

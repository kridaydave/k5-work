import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type K5App } from "./app.js";
import { loadServerConfig } from "./env.js";
import { SessionStore } from "./store/session-store.js";
import type { AcceptedConnection, ConnectionHandlers } from "./ws/gateway.js";

interface Harness {
  readonly url: string;
  readonly store: SessionStore;
  close(): Promise<void>;
}

const noHandlers = (): ConnectionHandlers => ({
  command: () => true,
  overflow: () => {},
  closed: () => {},
});

function tempHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A raw request per call rather than fetch: undici pools keep-alive sockets, and
 * a pooled idle socket is enough to make server.close() never call back, which
 * hangs the whole file. It is also the only way to set a Host header, which one
 * of these tests depends on.
 */
function send(
  baseUrl: string,
  pathname: string,
  options: { method?: string; host?: string } = {},
): Promise<{ status: number; body: unknown; allow: string | undefined }> {
  const target = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        agent: false,
        headers: options.host === undefined ? {} : { Host: options.host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            // Left as raw text so a non-JSON response is visible in the failure.
          }
          resolve({
            status: response.statusCode ?? 0,
            body,
            allow: response.headers.allow,
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function startHarness(): Promise<Harness> {
  const home = tempHome("k5-api-");
  const config = loadServerConfig({
    env: { XDG_DATA_HOME: path.join(home, "share") },
    workspaceRoot: home,
    homeDir: home,
  });
  const store = new SessionStore({ root: config.storeRoot });
  await store.open();
  const app = createApp({
    config,
    store,
    onConnect: (_connection: AcceptedConnection) => noHandlers(),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    close: async () => {
      await stopApp(app);
      await store.close();
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

async function stopApp(app: K5App): Promise<void> {
  await new Promise<void>((resolve) => {
    app.server.close(() => resolve());
    app.server.closeAllConnections?.();
  });
}

async function withApp(
  options: { env?: NodeJS.ProcessEnv; store: boolean },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const home = tempHome("k5-app-");
  const config = loadServerConfig({
    env: options.env ?? { XDG_DATA_HOME: path.join(home, "share") },
    workspaceRoot: home,
    homeDir: home,
  });
  const store = options.store ? new SessionStore({ root: config.storeRoot }) : null;
  if (store !== null) await store.open();
  const app = createApp({
    config,
    ...(store === null ? {} : { store }),
    onConnect: () => noHandlers(),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = (app.server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await stopApp(app);
    if (store !== null) await store.close();
    await fsp.rm(home, { recursive: true, force: true });
  }
}

async function get(
  harness: Harness,
  pathname: string,
  method = "GET",
): Promise<{ status: number; body: unknown }> {
  return send(harness.url, pathname, { method });
}

test("the session list is served with no harness process", async () => {
  const harness = await startHarness();
  try {
    const created = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_1",
      projectId: "proj-1",
      projectName: "k5-work",
      cwd: "/home/k5/code/k5-work",
      title: "First task",
    });
    const listed = await get(harness, "/api/sessions");
    assert.equal(listed.status, 200);
    const body = listed.body as { sessions: { storeId: string; title: string }[] };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0]?.storeId, created.storeId);
    assert.equal(body.sessions[0]?.title, "First task");
  } finally {
    await harness.close();
  }
});

test("events are paged by cursor and the four states are distinguishable", async () => {
  const harness = await startHarness();
  try {
    const session = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_1",
      projectId: "p",
      projectName: null,
      cwd: "/tmp/p",
      title: "Paged",
    });
    for (let index = 1; index <= 5; index += 1) {
      harness.store.append(session.storeId, {
        type: "turn.delta",
        sessionId: "ses_live",
        turnId: `t-${index}`,
        stream: "text",
        text: `m${index}`,
      });
    }
    await harness.store.flushMeta(session.storeId);

    const first = await get(harness, `/api/sessions/${session.storeId}/events?limit=2`);
    assert.equal(first.status, 200);
    const page = first.body as {
      status: string;
      events: unknown[];
      hasMore: boolean;
      nextSince: number;
    };
    assert.equal(page.status, "appended");
    assert.equal(page.events.length, 2);
    assert.equal(page.hasMore, true);
    // Directly passable back as `since`, with no off-by-one for the client.
    assert.equal(page.nextSince, 2);

    const caughtUp = await get(harness, `/api/sessions/${session.storeId}/events?since=5`);
    assert.equal((caughtUp.body as { status: string }).status, "up-to-date");

    // A well-formed but impossible cursor is 200 with a status, never 404 or
    // 410: the session exists, and a 410 would invite a client to delete it.
    const impossible = await get(harness, `/api/sessions/${session.storeId}/events?since=9999`);
    assert.equal(impossible.status, 200);
    assert.equal((impossible.body as { status: string }).status, "cursor-invalid");

    // A malformed cursor is a 400, which is a different failure from the above.
    const malformed = await get(harness, `/api/sessions/${session.storeId}/events?since=abc`);
    assert.equal(malformed.status, 400);

    const negative = await get(harness, `/api/sessions/${session.storeId}/events?since=-1`);
    assert.equal(negative.status, 400);
  } finally {
    await harness.close();
  }
});

test("a path-traversal attempt in the session id never reaches the filesystem", async () => {
  const harness = await startHarness();
  try {
    // These reach the store as one literal segment, because the URL parser does
    // not decode %2F into a separator. The id then fails the UUID gate.
    for (const attempt of [
      "/api/sessions/..%2F..%2Fetc%2Fpasswd/events",
      "/api/sessions/not-a-uuid/events",
    ]) {
      const result = await send(harness.url, attempt);
      assert.equal(result.status, 400, `${attempt} should be refused as malformed`);
    }
    // These two are different and worth pinning: the URL parser decodes %2E and
    // then collapses the resulting "..", so the path is normalised away before
    // any route sees it. The refusal is a 404 rather than a 400, and no store
    // lookup happens at all.
    for (const attempt of ["/api/sessions/.%2E/events", "/api/sessions/%2E%2E/events"]) {
      const normalised = await send(harness.url, attempt);
      assert.equal(normalised.status, 404, `${attempt} is normalised away`);
    }

    const unknown = await send(
      harness.url,
      "/api/sessions/11111111-1111-4111-8111-111111111111/events",
    );
    assert.equal(unknown.status, 404);
  } finally {
    await harness.close();
  }
});

test("a session can be deleted over HTTP, and the list really empties", async () => {
  // Without a DELETE a durable store accumulates transcripts with no way out,
  // which is a one-way door. This asserts the response codes and the actual
  // list contents, not merely that a body came back.
  const harness = await startHarness();
  try {
    const session = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_1",
      projectId: "p",
      projectName: null,
      cwd: "/tmp/p",
      title: "Removable",
    });
    const before = await send(harness.url, "/api/sessions");
    assert.equal(before.status, 200);
    assert.equal((before.body as { sessions: unknown[] }).sessions.length, 1);

    const deleted = await send(harness.url, `/api/sessions/${session.storeId}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    const after = await send(harness.url, "/api/sessions");
    assert.equal(after.status, 200);
    assert.deepEqual((after.body as { sessions: unknown[] }).sessions, [], "the list is empty");

    // And the reverse state is itself idempotent rather than a confusing 500.
    const again = await send(harness.url, `/api/sessions/${session.storeId}`, { method: "DELETE" });
    assert.equal(again.status, 404);
    const summary = await send(harness.url, `/api/sessions/${session.storeId}/summary`);
    assert.equal(summary.status, 404);
  } finally {
    await harness.close();
  }
});

test("a wrong method is refused with an Allow header naming what is supported", async () => {
  const harness = await startHarness();
  try {
    // The list is read-only.
    const list = await send(harness.url, "/api/sessions", { method: "DELETE" });
    assert.equal(list.status, 405);
    assert.equal(list.allow, "GET", "and it says so");

    // A single session is readable and deletable, so the header must say both.
    const one = await send(harness.url, "/api/sessions/11111111-1111-4111-8111-111111111111", {
      method: "PATCH",
    });
    assert.equal(one.status, 405);
    assert.equal(one.allow, "GET, DELETE");

    // A sub-resource is read-only even though its parent is deletable.
    const sub = await send(harness.url, "/api/sessions/11111111-1111-4111-8111-111111111111/events", {
      method: "DELETE",
    });
    assert.equal(sub.status, 405);
  } finally {
    await harness.close();
  }
});

test("a malformed percent-encoding in the id is a client error, not a store fault", async () => {
  const harness = await startHarness();
  try {
    for (const attempt of [
      "/api/sessions/%zz/events",
      "/api/sessions/%/events",
      "/api/sessions/%E0%A4%A/events",
    ]) {
      const result = await send(harness.url, attempt);
      assert.equal(result.status, 400, `${attempt} should be a 400, not a 500`);
    }
  } finally {
    await harness.close();
  }
});

test("session history reports unavailable when no store is wired", async () => {
  await withApp({ store: false }, async (baseUrl) => {
    const result = await send(baseUrl, "/api/sessions");
    assert.equal(result.status, 503);
    // A route that is not a session route still 404s rather than 503-ing.
    const other = await send(baseUrl, "/api/nope");
    assert.equal(other.status, 404);
  });
});

test("an unknown Host is still refused before any session route runs", async () => {
  await withApp({ store: true, env: {} }, async (baseUrl) => {
    const result = await send(baseUrl, "/api/sessions", { host: "attacker.example" });
    assert.equal(result.status, 421, "DNS rebinding must not read the session list");
  });
});

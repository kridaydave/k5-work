import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_ATTACHMENT_BYTES } from "@k5-work/shared";
import { createApp, type K5App } from "./app.js";
import { loadServerConfig } from "./env.js";
import { SessionStoreError } from "./store/errors.js";
import { SessionStore } from "./store/session-store.js";
import type { DatabaseSync } from "node:sqlite";
import type { AcceptedConnection, ConnectionHandlers } from "./ws/gateway.js";

interface Harness {
  readonly url: string;
  readonly store: SessionStore;
  /** The store's root, so a test can remove a session behind the store's back. */
  readonly root: string;
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
 * A second connection to the store, for the tests that need a state the store
 * itself will not produce.
 *
 * The busy timeout matters: without it this connection fails with SQLITE_BUSY the
 * moment the store holds the write lock, which is a test failure that looks like a
 * bug in the thing under test.
 */
async function withSecondConnection(
  root: string,
  run: (db: DatabaseSync) => void,
): Promise<void> {
  const { DatabaseSync: Sqlite } = await import("node:sqlite");
  const db = new Sqlite(path.join(root, "k5.db"), { timeout: 5_000 });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    run(db);
  } finally {
    db.close();
  }
}

/**
 * Deletes a session row without telling the store, which is the case where a store
 * that recreated on demand would hand the user back a session they deleted.
 *
 * There is no cached row to mislead anything here: the store re-reads the session
 * on every call, so this models a deletion from another process, not a stale view.
 */
async function removeBehindStoresBack(root: string, storeId: string): Promise<void> {
  await withSecondConnection(root, (db) => {
    db.prepare("DELETE FROM sessions WHERE store_id = ?").run(storeId);
  });
}

/** Counts the rows a table holds, for asserting that a refused write left nothing. */
async function rowCount(
  root: string,
  table: "events" | "attachments" | "sessions",
): Promise<number> {
  let total = 0;
  await withSecondConnection(root, (db) => {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
    total = Number(row.total);
  });
  return total;
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
  options: { method?: string; host?: string; body?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown; allow: string | undefined; cacheControl: string | undefined }> {
  const target = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        agent: false,
        headers: {
          ...(options.host === undefined ? {} : { Host: options.host }),
          ...(options.headers ?? {}),
        },
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
            cacheControl: response.headers["cache-control"],
          });
        });
      },
    );
    outgoing.once("error", reject);
    if (options.body === undefined) {
      outgoing.end();
      return;
    }
    outgoing.end(options.body);
  });
}

/**
 * A body sent without a Content-Length, so the cap can only be enforced while
 * reading. Node frames it chunked, which is how most real clients upload.
 */
function sendChunked(
  baseUrl: string,
  pathname: string,
  total: number,
): Promise<{ status: number }> {
  const target = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        agent: false,
        headers: { "Transfer-Encoding": "chunked" },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    outgoing.once("error", reject);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    let sent = 0;
    const pump = (): void => {
      while (sent < total) {
        const piece = Math.min(chunk.length, total - sent);
        sent += piece;
        if (!outgoing.write(piece === chunk.length ? chunk : chunk.subarray(0, piece))) {
          outgoing.once("drain", pump);
          return;
        }
      }
      outgoing.end();
    };
    pump();
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
    root: config.storeRoot,
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
    assert.equal(sub.allow, "GET", "and it says so, rather than inheriting its parent's DELETE");
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

test("an upload is answered with a manifest the server derived, and the bytes are readable", async () => {
  const harness = await startHarness();
  try {
    const session = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_1",
      projectId: "p",
      projectName: null,
      cwd: "/tmp/p",
      title: "With a file",
    });
    // The client lies about the type on purpose: these four bytes are a PNG
    // header, and the manifest must describe what arrived.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const query = new URLSearchParams({ name: "shot.png", mime: "text/plain" });
    const uploaded = await send(
      harness.url,
      `/api/sessions/${session.storeId}/attachments?${query.toString()}`,
      { method: "POST", body: png, headers: { "Content-Type": "application/octet-stream" } },
    );
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.cacheControl, "no-store", "an upload is not a cacheable read");
    const manifest = uploaded.body as {
      attachmentId: string;
      name: string;
      mimeType: string;
      kind: string;
      size: number;
    };
    assert.equal(manifest.name, "shot.png");
    assert.equal(manifest.mimeType, "text/plain");
    assert.equal(manifest.kind, "binary", "kind comes from the bytes, not the declared mime");
    assert.equal(manifest.size, 4);
    assert.ok(manifest.attachmentId.length > 0, "the server mints the id, never the client");
    // And the id really addresses the bytes on disk, which is what a later prompt
    // depends on.
    assert.deepEqual(await harness.store.readAttachment(session.storeId, manifest.attachmentId), png);

    // The body is the file, not JSON: a text attachment round-trips exactly.
    const text = Buffer.from("héllo wörld\n", "utf8");
    const textQuery = new URLSearchParams({ name: "notes.txt", mime: "text/plain" });
    const textUpload = await send(
      harness.url,
      `/api/sessions/${session.storeId}/attachments?${textQuery.toString()}`,
      { method: "POST", body: text },
    );
    assert.equal(textUpload.status, 200);
    const textManifest = textUpload.body as { attachmentId: string; kind: string; size: number };
    assert.equal(textManifest.kind, "text");
    assert.equal(textManifest.size, text.length);
    assert.deepEqual(
      await harness.store.readAttachment(session.storeId, textManifest.attachmentId),
      text,
    );
  } finally {
    await harness.close();
  }
});

test("an upload over the byte cap is refused, and an unknown session is a 404", async () => {
  const harness = await startHarness();
  try {
    const session = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_1",
      projectId: "p",
      projectName: null,
      cwd: "/tmp/p",
      title: "Capped",
    });
    const query = new URLSearchParams({ name: "huge.bin", mime: "application/octet-stream" });
    const tooLarge = await send(
      harness.url,
      `/api/sessions/${session.storeId}/attachments?${query.toString()}`,
      { method: "POST", body: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) },
    );
    assert.equal(tooLarge.status, 413, "the cap is enforced before the bytes are stored");
    assert.equal(
      await rowCount(harness.root, "attachments"),
      0,
      "and nothing was written",
    );

    const unknownQuery = new URLSearchParams({ name: "a.txt", mime: "text/plain" });
    const unknown = await send(
      harness.url,
      `/api/sessions/11111111-1111-4111-8111-111111111111/attachments?${unknownQuery.toString()}`,
      { method: "POST", body: Buffer.from("x") },
    );
    assert.equal(unknown.status, 404);

    // The query is the client's name and type; without them the response could
    // only echo a guess.
    const noQuery = await send(harness.url, `/api/sessions/${session.storeId}/attachments`, {
      method: "POST",
      body: Buffer.from("x"),
    });
    assert.equal(noQuery.status, 400);

    const wrongMethod = await send(harness.url, `/api/sessions/${session.storeId}/attachments`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.allow, "POST");

    // Same cap, discovered while reading rather than from a header. The client
    // must still be told why: a reset would look like a network fault and the
    // browser would retry the same 26 MB forever.
    const chunked = await sendChunked(
      harness.url,
      `/api/sessions/${session.storeId}/attachments?${query.toString()}`,
      MAX_ATTACHMENT_BYTES + 1024,
    );
    assert.equal(chunked.status, 413);
  } finally {
    await harness.close();
  }
});

test("a session removed mid-flight does not come back through an upload", async () => {
  const harness = await startHarness();
  try {
    const session = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_1",
      projectId: "p",
      projectName: null,
      cwd: "/tmp/p",
      title: "Vanishing",
    });
    // Removed behind the store's back, so the store's handle still believes it
    // exists: a store that inserted on demand would hand the user back a session
    // they deleted.
    await removeBehindStoresBack(harness.root, session.storeId);

    const query = new URLSearchParams({ name: "a.txt", mime: "text/plain" });
    const refused = await send(
      harness.url,
      `/api/sessions/${session.storeId}/attachments?${query.toString()}`,
      { method: "POST", body: Buffer.from("x") },
    );
    assert.equal(refused.status, 404);
    assert.equal(
      await rowCount(harness.root, "sessions"),
      0,
      "and the session must stay gone",
    );

    // And the honest removal refuses the same way, without recreating anything.
    const second = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_2",
      projectId: "p",
      projectName: null,
      cwd: "/tmp/p",
      title: "Vanishing too",
    });
    assert.equal(await harness.store.remove(second.storeId), true);
    const afterRemove = await send(
      harness.url,
      `/api/sessions/${second.storeId}/attachments?${query.toString()}`,
      { method: "POST", body: Buffer.from("x") },
    );
    assert.equal(afterRemove.status, 404);
    assert.equal(await rowCount(harness.root, "sessions"), 0);
  } finally {
    await harness.close();
  }
});

test("an attachment can be dropped again, so an upload is not a one-way door", async () => {
  const harness = await startHarness();
  try {
    const session = await harness.store.create({
      harness: "opencode",
      harnessSessionId: "ses_1",
      projectId: "p",
      projectName: null,
      cwd: "/tmp/p",
      title: "Changeable mind",
    });
    const query = new URLSearchParams({ name: "a.txt", mime: "text/plain" });
    const uploaded = await send(
      harness.url,
      `/api/sessions/${session.storeId}/attachments?${query.toString()}`,
      { method: "POST", body: Buffer.from("x") },
    );
    const manifest = uploaded.body as { attachmentId: string };
    const target = `/api/sessions/${session.storeId}/attachments/${manifest.attachmentId}`;

    const wrongMethod = await send(harness.url, target, { method: "POST", body: Buffer.from("x") });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.allow, "DELETE");

    const hostile = await send(
      harness.url,
      `/api/sessions/${session.storeId}/attachments/${encodeURIComponent("../../etc")}`,
      { method: "DELETE" },
    );
    assert.equal(hostile.status, 400, "an unsafe id is a client error, not a store fault");

    const deleted = await send(harness.url, target, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.equal(deleted.cacheControl, "no-store");
    await assert.rejects(
      () => harness.store.readAttachment(session.storeId, manifest.attachmentId),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
    );
    // Idempotent, so a retried delete is not a confusing error.
    const again = await send(harness.url, target, { method: "DELETE" });
    assert.equal(again.status, 404);
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

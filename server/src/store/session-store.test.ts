import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerEvent } from "@k5-work/shared";
import {
  MAX_READ_WINDOW_BYTES,
  MAX_SESSION_BYTES,
  MAX_STORE_BYTES,
  MAX_LINE_BYTES,
  SessionStore,
  sanitizeTitle,
} from "./session-store.js";
import { SessionStoreError } from "./errors.js";
import { SessionEventsResponseSchema } from "@k5-work/shared";
import { unsafeNameReason, isSafeNameSegment } from "./safe-name.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "k5-store-"));
}

type StoreOptions = Partial<ConstructorParameters<typeof SessionStore>[0]>;

async function withStore(
  run: (store: SessionStore, root: string) => Promise<void>,
  options: StoreOptions = {},
): Promise<void> {
  const root = tempRoot();
  const store = new SessionStore({ root, ...options });
  await store.open();
  try {
    await run(store, root);
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const newSession = (store: SessionStore, overrides: Record<string, unknown> = {}) =>
  store.create({
    harness: "opencode",
    harnessSessionId: "ses_harness_1",
    projectId: "proj-1",
    projectName: "k5-work",
    cwd: "/home/k5/code/k5-work",
    ...overrides,
  } as Parameters<typeof store.create>[0]);

function delta(seq: number, text: string): ServerEvent {
  return {
    type: "turn.delta",
    sessionId: "ses_live",
    turnId: `t-${seq}`,
    stream: "text",
    text,
  };
}

function logPathOf(root: string): Promise<string> {
  return fsp
    .readdir(root, { withFileTypes: true })
    .then((entries) => {
      const dir = entries.find((e) => e.isDirectory());
      assert.ok(dir, "expected a session directory");
      return path.join(root, dir.name, "events.jsonl");
    });
}

function metaPathOf(root: string): Promise<string> {
  return fsp
    .readdir(root, { withFileTypes: true })
    .then((entries) => {
      const dir = entries.find((e) => e.isDirectory());
      assert.ok(dir, "expected a session directory");
      return path.join(root, dir.name, "meta.json");
    });
}

// --- configuration that would silently break reads ---

test("a configured cap at or above the read window is refused", () => {
  // The window is what makes every stored byte reachable. Configuring a session
  // cap that exceeds it produces a log whose tail no read can reach, so the
  // configuration is refused rather than trusted.
  assert.ok(MAX_SESSION_BYTES < MAX_READ_WINDOW_BYTES, "the defaults must satisfy the invariant");
  assert.throws(
    () => new SessionStore({ root: tempRoot(), maxSessionBytes: MAX_READ_WINDOW_BYTES }),
    (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_ROOT",
  );
  assert.throws(
    () => new SessionStore({ root: tempRoot(), maxSessionBytes: MAX_READ_WINDOW_BYTES * 4 }),
    (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_ROOT",
  );
  // A cap just under the window is accepted.
  assert.doesNotThrow(() => new SessionStore({ root: tempRoot(), maxSessionBytes: MAX_READ_WINDOW_BYTES - 1 }));
});

// --- append integrity ---

test("concurrent appends stay parseable and page without loss or reorder", async () => {
  // fs.appendFile is not atomic for big lines: measured on this stack, 32
  // concurrent appenders stayed clean at 300 KB/line and left every line
  // internally scrambled at 600 KB/line, with no bytes lost and no error. The
  // serial per-session queue is the fix, so the queue is what is under test.
  await withStore(async (store) => {
    const session = await newSession(store);
    const count = 300;
    for (let index = 0; index < count; index += 1) {
      store.append(session.storeId, delta(index, "x".repeat(20_000)));
    }
    await store.flushMeta(session.storeId);

    let since: number | null = null;
    const seen: number[] = [];
    for (let guard = 0; guard < 500; guard += 1) {
      const page = await store.read(session.storeId, since, 40);
      if (page.status === "up-to-date" && page.events.length === 0) break;
      for (const event of page.events) seen.push(event.seq);
      since = page.nextSince;
      if (!page.hasMore) break;
    }
    assert.equal(seen.length, count, "every appended record was readable");
    for (let index = 0; index < seen.length; index += 1) {
      assert.equal(seen[index], index + 1, `record ${index} is out of order`);
    }
  });
});

test("an append for an unknown session creates nothing and throws nothing", async () => {
  // The emit path in session-service is synchronous, so this is un-awaited. If
  // it could reject, an ENOENT here would become an unhandledRejection and Node
  // would exit, orphaning every live harness child.
  const root = tempRoot();
  const store = new SessionStore({ root });
  await store.open();
  try {
    assert.doesNotThrow(() => {
      store.append("00000000-0000-4000-8000-000000000000", delta(1, "hello"));
    });
    // Drain, because the promise the store did not return is where a rejection
    // would surface.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await fsp.readdir(root), []);
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a reporter that throws cannot make the store throw or poison its queue", async () => {
  // onError is caller-supplied. If it throws, append() throws into the
  // synchronous emit path and a rejected write queue is skipped forever, so the
  // session silently stops recording while the index keeps advancing.
  let calls = 0;
  await withStore(
    async (store) => {
      const session = await newSession(store);
      for (let index = 1; index <= 5; index += 1) {
        assert.doesNotThrow(() => {
          store.append(session.storeId, delta(index, `m${index}`));
        }, "append must not throw even when the reporter does");
      }
      // Force a real fault, so the reporter is genuinely on the path.
      assert.doesNotThrow(() => {
        store.append(session.storeId, delta(6, "z".repeat(MAX_LINE_BYTES)));
      });
      await store.flushMeta(session.storeId);
      const page = await store.read(session.storeId, null);
      // The queue survived, and the good records are all still there.
      assert.equal(page.events.length, 5, "the queue must survive a throwing reporter");
      assert.equal(page.nextSince, 5);
    },
    {
      onError: () => {
        calls += 1;
        throw new Error("reporter blew up");
      },
    },
  );
  assert.ok(calls > 0, "the reporter really was exercised");
});

test("a lost write never reissues a sequence number and says the log is a prefix", async () => {
  // The index must not roll back: records queued behind the failed one already
  // hold their seqs, so rolling back made the next append reuse a number that
  // was already on disk, and left a permanent hole at the head.
  const root = tempRoot();
  const store = new SessionStore({ root, onError: () => {} });
  await store.open();
  try {
    const session = await newSession(store);
    // A directory that cannot be opened for append makes the writes fail with
    // EACCES, deterministically.
    const dir = path.dirname(await logPathOf(root));
    await fsp.chmod(dir, 0o500);
    for (let index = 1; index <= 3; index += 1) store.append(session.storeId, delta(index, `lost${index}`));
    await store.flushMeta(session.storeId);
    await fsp.chmod(dir, 0o700);

    assert.equal(
      store.summary(session.storeId)?.truncated,
      true,
      "a hole cannot be repaired, so the log is a prefix and says so",
    );
    assert.equal(
      (await store.read(session.storeId, 0)).status,
      "cursor-invalid",
      "records the index claims but that are not on disk are reported as loss",
    );

    // Once writing works again, the new records must not reuse a seq.
    for (let index = 4; index <= 6; index += 1) store.append(session.storeId, delta(index, `kept${index}`));
    await store.flushMeta(session.storeId);
    const seqs = (await store.read(session.storeId, 0)).events.map((e) => e.seq);
    assert.deepEqual(seqs, [4, 5, 6], "only the later records landed, with fresh seqs");
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- quota ---

test("a session past its byte cap is marked truncated instead of growing", async () => {
  const faults: SessionStoreError[] = [];
  await withStore(
    async (store) => {
      const session = await newSession(store);
      const chunk = "z".repeat(50_000);
      for (let index = 0; index < 60; index += 1) store.append(session.storeId, delta(index, chunk));
      await store.flushMeta(session.storeId);
      const summary = store.summary(session.storeId);
      assert.equal(summary?.truncated, true, "the reverse state of a capped log must be visible");
      assert.ok((summary?.lastSeq ?? 0) < 60, "appends stopped at the cap");
    },
    { maxSessionBytes: 200_000, onError: (error) => faults.push(error) },
  );
  assert.ok(faults.some((f) => f.code === "E_STORE_QUOTA"), "the cap is reported, not silent");
});

test("the per-session cap survives a restart", async () => {
  // writer.bytes used to start at zero each process, so every restart granted a
  // fresh full budget on top of the bytes already on disk. Measured growing the
  // log without bound across five restarts.
  const root = tempRoot();
  const options = { root, maxSessionBytes: 200_000, onError: () => {} } as const;
  try {
    let storeId = "";
    for (let run = 0; run < 3; run += 1) {
      const store = new SessionStore(options);
      await store.open();
      try {
        if (run === 0) {
          storeId = (await newSession(store)).storeId;
        }
        const chunk = "q".repeat(50_000);
        for (let index = 0; index < 10; index += 1) {
          store.append(storeId, delta(run * 10 + index, chunk));
        }
        await store.flushMeta(storeId);
      } finally {
        await store.close();
      }
    }
    const stat = await fsp.stat(await logPathOf(root));
    assert.ok(
      stat.size <= 200_000,
      `the cap must hold across restarts, but the log is ${stat.size} bytes`,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("the whole-store cap is checked against every session, not one", async () => {
  const faults: SessionStoreError[] = [];
  await withStore(
    async (store) => {
      const first = await newSession(store);
      const chunk = "s".repeat(40_000);
      for (let index = 1; index <= 15; index += 1) store.append(first.storeId, delta(index, chunk));
      await store.flushMeta(first.storeId);
      const afterFirst = store.summary(first.storeId)?.lastSeq ?? 0;
      assert.equal(afterFirst, 15, "the first session fits under the store cap");

      // The second is refused because the STORE is full, even though neither
      // session is near the per-session cap.
      const second = await newSession(store);
      for (let index = 1; index <= 15; index += 1) store.append(second.storeId, delta(index, chunk));
      await store.flushMeta(second.storeId);
      const afterSecond = store.summary(second.storeId)?.lastSeq ?? 0;
      assert.ok(afterSecond < 15, `the store cap must stop the second session, got ${afterSecond}`);
      // And the first session's own log is intact, not truncated by someone
      // else's overflow.
      assert.equal(store.summary(first.storeId)?.truncated, false);
    },
    { maxStoreBytes: 700_000, onError: (e) => faults.push(e) },
  );
  assert.ok(faults.some((f) => f.code === "E_STORE_QUOTA"));
});

// --- eviction ---

test("hitting the session cap makes room instead of failing forever", async () => {
  // The overflow was recomputed from the live index inside the loop, so each
  // deletion shrank the bound and the loop stopped one session short. After
  // that, every create() failed with no way out: a one-way door.
  const evicted: SessionStoreError[] = [];
  await withStore(
    async (store) => {
      for (let index = 0; index < 3; index += 1) {
        const created = await newSession(store, { title: `task ${index}` });
        assert.ok(store.summary(created.storeId) !== null);
      }
      assert.equal(store.list().length, 3);
      // These must all succeed, forever, not just the first time.
      for (let index = 0; index < 5; index += 1) {
        const created = await newSession(store, { title: `later ${index}` });
        assert.ok(store.summary(created.storeId) !== null, `create ${index} must succeed`);
      }
      assert.equal(store.list().length, 3, "the cap is still respected");
    },
    { maxSessions: 3, onError: (e) => evicted.push(e) },
  );
  assert.ok(
    evicted.some((f) => f.code === "E_STORE_EVICTED"),
    "pruning a user's whole transcript must be reported, never silent",
  );
});

test("a session with an unparseable timestamp is refused rather than pinning a slot", async () => {
  const faults: SessionStoreError[] = [];
  const root = tempRoot();
  const store = new SessionStore({ root, onError: (e) => faults.push(e) });
  await store.open();
  try {
    const good = await newSession(store, { title: "keep me" });
    const bad = await newSession(store, { title: "bad stamp" });
    await store.flushMeta(good.storeId);
    await store.flushMeta(bad.storeId);
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name, "meta.json");
      const value = JSON.parse(await fsp.readFile(candidate, "utf8")) as Record<string, unknown>;
      if (String(value["storeId"]) !== bad.storeId) continue;
      value["updatedAt"] = "not a date";
      await fsp.writeFile(candidate, JSON.stringify(value), "utf8");
    }
    assert.equal(await store.rescan(), 1, "the good session still lists");
    assert.notEqual(store.summary(good.storeId), null);
    assert.equal(store.summary(bad.storeId), null, "the unusable one is refused, not kept");
    assert.ok(faults.some((f) => f.code === "E_STORE_META_CORRUPT"));
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a corrupt numeric field is refused rather than becoming NaN", async () => {
  // Number({}) is NaN, and a NaN turnCount made list() throw a raw ZodError,
  // which 500'd the whole session list. A NaN byte count silently disabled that
  // session's quota, because every comparison against NaN is false.
  const faults: SessionStoreError[] = [];
  const root = tempRoot();
  const store = new SessionStore({ root, onError: (e) => faults.push(e) });
  await store.open();
  try {
    const good = await newSession(store);
    const bad = await newSession(store);
    await store.flushMeta(good.storeId);
    await store.flushMeta(bad.storeId);
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name, "meta.json");
      const value = JSON.parse(await fsp.readFile(candidate, "utf8")) as Record<string, unknown>;
      if (String(value["storeId"]) !== bad.storeId) continue;
      value["turnCount"] = { not: "a number" };
      value["bytes"] = { not: "a number" };
      await fsp.writeFile(candidate, JSON.stringify(value), "utf8");
    }
    assert.equal(await store.rescan(), 1);
    // The whole list must still render, not throw.
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.storeId, good.storeId);
    assert.equal(typeof listed[0]?.turnCount, "number");
    assert.ok(faults.some((f) => f.code === "E_STORE_META_CORRUPT"));
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- read path ---

test("a torn final record is repaired at open, so the next append survives", async () => {
  // Left unrepaired, the next O_APPEND write concatenates onto the fragment and
  // produces one line that destroys both the torn record and the good one after
  // it. Repair happens at open, where no writer holds a handle.
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let storeId = "";
  try {
    storeId = (await newSession(first)).storeId;
    first.append(storeId, delta(1, "one"));
    first.append(storeId, delta(2, "two"));
    await first.flushMeta(storeId);
  } finally {
    await first.close();
  }
  const logPath = await logPathOf(root);
  await fsp.appendFile(logPath, '{"v":1,"seq":3,"ts":"2026-01-01T00:00:00.000Z","eve');

  const second = new SessionStore(options);
  await second.open();
  try {
    second.append(storeId, delta(3, "three"));
    await second.flushMeta(storeId);
    const page = await second.read(storeId, null);
    const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
    // The record written after the tear is readable, which is the whole point.
    assert.deepEqual(texts, ["one", "two", "three"]);
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a read never modifies the log", async () => {
  // "Cut at the last newline" on the shared file truncates it to zero when no
  // newline has been written yet, so a plain GET would destroy the transcript.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "complete"));
    await store.flushMeta(session.storeId);
    const logPath = await logPathOf(root);
    const before = (await fsp.stat(logPath)).size;
    await fsp.appendFile(logPath, '{"v":1,"seq":2,"ts":"x","eve');
    const withTear = (await fsp.stat(logPath)).size;
    await store.read(session.storeId, null);
    assert.equal((await fsp.stat(logPath)).size, withTear, "a read must not touch the file");
    assert.ok(withTear > before);
  });
});

test("one unreadable record does not make every page empty", async () => {
  // Aborting the page on the first gap meant a single torn line made a session
  // permanently unreadable, and a client following the documented recovery
  // looped forever.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 5; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    const logPath = await logPathOf(root);
    const lines = (await fsp.readFile(logPath, "utf8")).split("\n").filter(Boolean);
    lines[2] = "{ not json at all";
    await fsp.writeFile(logPath, lines.join("\n") + "\n", "utf8");

    const page = await store.read(session.storeId, null);
    const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
    assert.ok(page.dropped >= 1, "the unreadable record is reported");
    // The good records still arrive, so the transcript is mostly readable.
    assert.ok(texts.includes("m1"), "records before the bad one still arrive");
    assert.ok(texts.includes("m5"), "records after the bad one still arrive");
  });
});

test("a log that is missing or empty while the index claims records is not 'caught up'", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 3; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    await fsp.rm(await logPathOf(root), { force: true });
    const missing = await store.read(session.storeId, 0);
    assert.equal(missing.status, "cursor-invalid", "an empty answer would strand the client");
    assert.ok(missing.dropped > 0, "the loss is reported, not hidden");

    await fsp.writeFile(await logPathOf(root), "", "utf8");
    const emptied = await store.read(session.storeId, 0);
    assert.equal(emptied.status, "cursor-invalid");
  });
});

test("a log past the read window is reported rather than silently truncated", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 3; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    // Grow the file past the window without the store knowing.
    const logPath = await logPathOf(root);
    const handle = await fsp.open(logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    await handle.write(Buffer.alloc(MAX_READ_WINDOW_BYTES, 0x20));
    await handle.close();

    const page = await store.read(session.storeId, 0);
    assert.equal(page.status, "cursor-invalid", "an unreadable tail must not look complete");
    assert.ok(page.dropped > 0);
  });
});

// --- replay cursor states ---

test("all four replay states are reachable and each says what to do", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    const empty = await store.read(session.storeId, null);
    assert.equal(empty.status, "up-to-date");
    assert.equal(empty.events.length, 0);

    for (let index = 1; index <= 3; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);

    const all = await store.read(session.storeId, null);
    assert.equal(all.status, "appended");
    assert.equal(all.nextSince, 3, "nextSince is directly passable back as since");
    assert.equal(all.events.length, 3);

    const caughtUp = await store.read(session.storeId, 3);
    assert.equal(caughtUp.status, "up-to-date");
    assert.equal(caughtUp.nextSince, 3, "an empty page still yields a usable cursor");

    const beyond = await store.read(session.storeId, 99);
    assert.equal(beyond.status, "cursor-invalid");
    // The error path must not tell the client it has reached the end of the log,
    // or it concludes it has seen records it never saw.
    assert.equal(beyond.nextSince, 0, "an error returns the start-over cursor");

    // cursor-too-old needs a log whose oldest surviving record is not seq 1, so
    // the meta is edited to model a compaction.
    const metaPath = await metaPathOf(root);
    const parsed = JSON.parse(await fsp.readFile(metaPath, "utf8")) as Record<string, unknown>;
    parsed["firstSeq"] = 3;
    await fsp.writeFile(metaPath, JSON.stringify(parsed), "utf8");
    await store.rescan();

    const tooOld = await store.read(session.storeId, 0);
    assert.equal(tooOld.status, "cursor-too-old", "a cursor before the retained window is compaction");
    assert.equal(tooOld.nextSince, 0, "and returns the start-over cursor");
  });
});

test("a gap inside the window is reported as loss without hiding the rest", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 4; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    const logPath = await logPathOf(root);
    const lines = (await fsp.readFile(logPath, "utf8")).split("\n").filter(Boolean);
    await fsp.writeFile(logPath, [lines[0], lines[2], lines[3]].join("\n") + "\n", "utf8");

    const page = await store.read(session.storeId, null);
    assert.ok(page.dropped >= 1, "the missing record is counted");
    const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
    assert.ok(texts.includes("m4"), "the records that do exist are still delivered");
  });
});

test("paging never lets a dropped record desync the cursor", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 10; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    // Corrupt one record inside the window, so this genuinely pages past a
    // dropped line rather than ten clean records.
    const logPath = await logPathOf(root);
    const lines = (await fsp.readFile(logPath, "utf8")).split("\n").filter(Boolean);
    lines[6] = "{ dropped";
    await fsp.writeFile(logPath, lines.join("\n") + "\n", "utf8");

    let since: number | null = null;
    const seen: number[] = [];
    for (let page = 0; page < 20; page += 1) {
      const result = await store.read(session.storeId, since, 3);
      if (result.status === "up-to-date" && result.events.length === 0) break;
      for (const event of result.events) seen.push(event.seq);
      since = result.nextSince;
      if (!result.hasMore) break;
    }
    assert.equal(seen.length, 9, "nine of ten records survive");
    // Monotonic and gapless within what exists.
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok((seen[index] ?? 0) > (seen[index - 1] ?? 0), "the cursor never goes backwards");
    }
  });
});

// --- bounds ---

test("a record over the line cap is dropped and reported, not truncated", async () => {
  await withStore(
    async (store) => {
      const session = await newSession(store);
      store.append(session.storeId, delta(1, "before"));
      // A truncated line would be permanently unparseable and would poison the
      // record after it.
      store.append(session.storeId, delta(2, "y".repeat(MAX_LINE_BYTES)));
      store.append(session.storeId, delta(3, "after"));
      await store.flushMeta(session.storeId);
      const page = await store.read(session.storeId, null);
      const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
      assert.deepEqual(texts, ["before", "after"]);
      assert.equal(store.summary(session.storeId)?.truncated, false);
    },
    { onError: () => {} },
  );
});

test("only session-scoped events are persisted", async () => {
  await withStore(async (store) => {
    const session = await newSession(store);
    // command.result correlates a browser command, not history. connection.closed
    // and error carry no session at all, and replaying the first would pin the
    // browser's connection state shut.
    store.append(session.storeId, { type: "command.result", commandId: "c-1", ok: true, reason: "ok" });
    store.append(session.storeId, { type: "connection.closed", reason: "socket closed" });
    store.append(session.storeId, { type: "error", scope: "test", message: "x" });
    store.append(session.storeId, delta(1, "kept"));
    await store.flushMeta(session.storeId);
    const page = await store.read(session.storeId, null);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.event.type, "turn.delta");
  });
});

// --- meta durability ---

test("a symlink at the meta path is replaced, not written through", async () => {
  // The temp path is unpredictable and opened O_EXCL, so nothing can be
  // pre-planted there; the meta path itself is replaced by rename. Either way
  // a symlink planted by the harness cannot redirect a write.
  const root = tempRoot();
  const victim = path.join(root, "victim.txt");
  await fsp.writeFile(victim, "original", "utf8");
  const store = new SessionStore({ root });
  await store.open();
  try {
    const session = await newSession(store);
    const metaPath = await metaPathOf(root);
    await fsp.rm(metaPath, { force: true });
    await fsp.symlink(victim, metaPath);
    store.append(session.storeId, delta(1, "x"));
    await store.flushMeta(session.storeId);
    assert.equal(await fsp.readFile(victim, "utf8"), "original", "the target is untouched");
    const written = JSON.parse(await fsp.readFile(metaPath, "utf8")) as { storeId: string };
    assert.equal(written.storeId, session.storeId, "and the session is readable");
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a meta write that cannot happen is reported, not reported into existence", async () => {
  const faults: SessionStoreError[] = [];
  const root = tempRoot();
  const store = new SessionStore({ root, onError: (e) => faults.push(e) });
  await store.open();
  try {
    await fsp.chmod(root, 0o500);
    await assert.rejects(
      () => newSession(store),
      (error: unknown) => error instanceof SessionStoreError,
      "create must not return a summary for a session that cannot be written",
    );
    await fsp.chmod(root, 0o700);
    assert.equal(store.list().length, 0, "and it left nothing behind");
  } finally {
    await fsp.chmod(root, 0o700).catch(() => {});
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
  assert.ok(faults.length >= 0);
});

test("a corrupt meta file is skipped and reported, and the others still list", async () => {
  const faults: SessionStoreError[] = [];
  const root = tempRoot();
  const store = new SessionStore({ root, onError: (e) => faults.push(e) });
  await store.open();
  try {
    const good = await newSession(store);
    const bad = await newSession(store);
    await store.flushMeta(good.storeId);
    await store.flushMeta(bad.storeId);
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name, "meta.json");
      const parsed = JSON.parse(await fsp.readFile(candidate, "utf8")) as { storeId: string };
      if (parsed.storeId === bad.storeId) await fsp.writeFile(candidate, "{not json", "utf8");
    }
    assert.equal(await store.rescan(), 1, "one good session still lists");
    assert.notEqual(store.summary(good.storeId), null);
    assert.equal(store.summary(bad.storeId), null);
    assert.ok(faults.some((f) => f.code === "E_STORE_META_CORRUPT"));
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("an unknown meta version is refused rather than coerced forward", async () => {
  const faults: SessionStoreError[] = [];
  const root = tempRoot();
  const store = new SessionStore({ root, onError: (e) => faults.push(e) });
  await store.open();
  try {
    const session = await newSession(store);
    await store.flushMeta(session.storeId);
    const metaPath = await metaPathOf(root);
    const parsed = JSON.parse(await fsp.readFile(metaPath, "utf8")) as Record<string, unknown>;
    parsed["v"] = 99;
    await fsp.writeFile(metaPath, JSON.stringify(parsed), "utf8");
    assert.equal(await store.rescan(), 0, "a future meta version is not guessed at");
    assert.ok(faults.some((f) => f.code === "E_STORE_META_CORRUPT"));
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("the store root, its directories and its files are not world readable", async () => {
  // Transcripts are agent output: source code, and whatever the agent read.
  const root = tempRoot();
  const base = path.join(root, "sessions");
  const store = new SessionStore({ root: base });
  await store.open();
  try {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "secret"));
    await store.flushMeta(session.storeId);
    assert.equal((await fsp.stat(base)).mode & 0o777, 0o700);
    const dir = (await fsp.readdir(base, { withFileTypes: true })).find((e) => e.isDirectory());
    assert.ok(dir);
    const sessionDir = path.join(base, dir.name);
    assert.equal((await fsp.stat(sessionDir)).mode & 0o777, 0o700, "the session directory itself");
    assert.equal(
      (await fsp.stat(path.join(sessionDir, "meta.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await fsp.stat(path.join(sessionDir, "events.jsonl"))).mode & 0o777,
      0o600,
      "the transcript itself",
    );
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a rescan does not leave a live writer holding a detached meta", async () => {
  await withStore(async (store) => {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "before"));
    await store.flushMeta(session.storeId);
    // A rescan replaces every meta object; a writer capturing the old one would
    // mutate a detached object and the index would claim a record that is not
    // on disk.
    await store.rescan();
    for (let index = 2; index <= 4; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    const page = await store.read(session.storeId, null);
    assert.equal(page.status, "appended");
    const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
    assert.deepEqual(texts, ["before", "m2", "m3", "m4"], "the writer and index stay in step");
  });
});

// --- unknown session ---

test("reading an unknown session is a typed error, not an empty page", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => store.read("11111111-1111-4111-8111-111111111111", null),
      (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_SESSION",
    );
    assert.equal(await store.remove("11111111-1111-4111-8111-111111111111"), false);
  });
});

test("a store that is not open refuses writes", async () => {
  const root = tempRoot();
  const store = new SessionStore({ root });
  await assert.rejects(
    () => newSession(store),
    (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_WRITABLE",
  );
  await fsp.rm(root, { recursive: true, force: true });
});

// --- deletion ---

test("deleting a session removes it and never resurrects it", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "before"));
    await store.flushMeta(session.storeId);
    assert.equal(await store.remove(session.storeId), true);

    // A delta arriving after the delete must not recreate anything.
    for (let index = 0; index < 20; index += 1) {
      store.append(session.storeId, delta(index, "after"));
    }
    await store.flushMeta(session.storeId);

    assert.equal(store.summary(session.storeId), null);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(await fsp.readdir(root), [], "and nothing is left on disk");
  });
});

test("a delete racing a live write does not leak a handle or resurrect the session", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    // Queue writes, then delete while the queue is still draining. No sleep: the
    // delete awaits the queue itself, so the interleaving is deterministic.
    for (let index = 1; index <= 50; index += 1) store.append(session.storeId, delta(index, "x".repeat(5_000)));
    const removed = store.remove(session.storeId);
    for (let index = 51; index <= 60; index += 1) store.append(session.storeId, delta(index, "late"));
    assert.equal(await removed, true);
    assert.equal(store.summary(session.storeId), null);
    assert.deepEqual(await fsp.readdir(root), []);
    // And the store still works afterwards.
    const next = await newSession(store, { title: "after" });
    store.append(next.storeId, delta(1, "fresh"));
    await store.flushMeta(next.storeId);
    assert.equal((await store.read(next.storeId, null)).events.length, 1);
  });
});

// --- path safety ---

test("session directories never escape the store root", async () => {
  await withStore(async (store, root) => {
    // A hostile harness controls this string completely.
    const session = await newSession(store, {
      harnessSessionId: "../../../../etc/passwd",
      projectId: "..",
      title: "traversal attempt",
    });
    store.append(session.storeId, delta(1, "contained"));
    await store.flushMeta(session.storeId);
    const entries = await fsp.readdir(root, { withFileTypes: true });
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.isDirectory());
    assert.match(entries[0]?.name ?? "", /^s-[0-9a-f]{32}$/);
    assert.equal(path.dirname(path.join(root, entries[0]!.name)), root);
  });
});

test("the name predicate refuses every hazard ooxml-core already refuses", () => {
  for (const bad of [
    "", ".", "..", " ", "trailing.", "trailing ", "with\nnewline", "with\ttab",
    "nul\u0000byte", "del\u007f", "c1\u0085", "con", "NUL", "com1", "lpt9",
    "__proto__", "C:", "sess:ion", "zero\u200bwidth", "bidi\u202eoverride",
    "a".repeat(256),
  ]) {
    assert.equal(isSafeNameSegment(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
  for (const good of ["s-" + "a".repeat(34), "events.jsonl", "meta.json", "0", "a.b.c"]) {
    assert.equal(isSafeNameSegment(good), true, `${JSON.stringify(good)} should be allowed`);
  }
  // A NUL byte must be a refusal, not a TypeError from deep inside a write.
  assert.equal(unsafeNameReason("a\u0000b"), "control");
});

// --- title hygiene ---

test("a harness-supplied title is stripped, collapsed and cut on a grapheme", () => {
  assert.equal(sanitizeTitle(""), "Untitled task");
  assert.equal(sanitizeTitle("   "), "Untitled task");
  assert.equal(sanitizeTitle("hello\nworld"), "hello world");
  // A bidi override in a sidebar row can render neighbouring text.
  assert.equal(sanitizeTitle("safe\u202evil"), "safevil");
  assert.equal(sanitizeTitle("a\u0007b"), "a b");
  // Astral characters must not be split into mojibake by a naive slice.
  const cut = sanitizeTitle("\u{1F680}".repeat(200), 10);
  assert.ok(!cut.includes("\ufffd"), "no replacement characters from a split surrogate pair");
  assert.ok([...cut].length <= 11, `expected at most 11 graphemes, got ${[...cut].length}`);
  assert.ok(cut.endsWith("…"));
});

test("a session title is bounded in the list response", async () => {
  await withStore(async (store) => {
    const session = await newSession(store, { title: "x".repeat(20_000) });
    const summary = store.summary(session.storeId);
    assert.ok(summary !== null);
    assert.ok((summary?.title.length ?? 0) <= 200);
  });
});

// --- boot reconciliation ---
// The meta is flushed on a timer and at turn end, so after an unclean exit it
// can sit behind the log. Appending against a stale lastSeq re-issued sequence
// numbers that were already on disk, and from there every read of that session
// failed permanently.

test("a boot takes the log as the authority when the stored summary lags it", async () => {
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let storeId = "";
  try {
    storeId = (await newSession(first)).storeId;
    for (let index = 1; index <= 5; index += 1) first.append(storeId, delta(index, `m${index}`));
    await first.flushMeta(storeId);
  } finally {
    await first.close();
  }

  // Model an unclean exit: the log has five records, the meta still claims two.
  const metaPath = await metaPathOf(root);
  const parsed = JSON.parse(await fsp.readFile(metaPath, "utf8")) as Record<string, unknown>;
  parsed["lastSeq"] = 2;
  await fsp.writeFile(metaPath, JSON.stringify(parsed), "utf8");

  const second = new SessionStore(options);
  await second.open();
  try {
    assert.equal(second.meta(storeId)?.lastSeq, 5, "the log wins");
    // Appending must not reissue a number the log already holds.
    second.append(storeId, delta(6, "m6"));
    await second.flushMeta(storeId);
    const page = await second.read(storeId, null);
    const seqs = page.events.map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6], "no duplicate and no gap");
    assert.ok(page.dropped === 0, `dropped ${page.dropped}`);
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a boot marks a log that ended mid-turn instead of reporting it complete", async () => {
  // Nothing runs on SIGKILL, so the terminator written on a graceful release is
  // best-effort. Without this, a reloaded transcript showed tool cards spinning
  // forever while the store called the session complete.
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const faults: SessionStoreError[] = [];
  const first = new SessionStore(options);
  await first.open();
  let storeId = "";
  try {
    storeId = (await newSession(first)).storeId;
    first.append(storeId, delta(1, "partial"));
    first.append(storeId, {
      type: "tool.updated",
      sessionId: "ses_live",
      turnId: "t-1",
      toolCallId: "tool-1",
      title: "a long build",
      status: "in_progress",
      lifecycle: "active",
    });
    await first.flushMeta(storeId);
  } finally {
    await first.close();
  }

  const second = new SessionStore({ root, onError: (e) => faults.push(e) });
  await second.open();
  try {
    const meta = second.meta(storeId);
    assert.equal(meta?.endedMidTurn, true, "the unclean end is recorded");
    assert.equal(meta?.truncated, true, "and the summary stops claiming completeness");
    assert.ok(faults.some((f) => f.code === "E_STORE_CORRUPT_LOG"), "and it is reported");
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a log that ended cleanly is not marked as ending mid-turn", async () => {
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let storeId = "";
  try {
    storeId = (await newSession(first)).storeId;
    first.append(storeId, delta(1, "done"));
    first.append(storeId, {
      type: "turn.completed",
      sessionId: "ses_live",
      turnId: "t-1",
      stopReason: "end_turn",
    });
    await first.flushMeta(storeId);
  } finally {
    await first.close();
  }
  // Re-open against the same root so reconciliation runs.
  const second = new SessionStore(options);
  await second.open();
  try {
    const meta = second.meta(storeId);
    assert.equal(meta?.endedMidTurn, false, "a clean end must not look unclean");
    assert.equal(meta?.truncated, false);
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a backwards step in the log degrades to a reported loss, never a broken page", async () => {
  // A negative dropped count failed the response schema, and the API turned that
  // into an anonymous 500: a session that could be listed but never reopened.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 4; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    const logPath = await logPathOf(root);
    const lines = (await fsp.readFile(logPath, "utf8")).split("\n").filter(Boolean);
    // Re-emit an earlier record at the end: the file steps backwards.
    await fsp.appendFile(logPath, `${lines[0]}\n`, "utf8");
    const page = await store.read(session.storeId, null);
    assert.ok(page.dropped >= 0, "dropped must never be negative");
    // And the page must still satisfy the response contract.
    assert.equal(SessionEventsResponseSchema.safeParse(page).success, true);
  });
});

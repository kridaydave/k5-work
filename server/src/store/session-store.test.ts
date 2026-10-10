import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerEvent } from "@k5-work/shared";
import {
  MAX_ATTACHMENT_BYTES,
  projectTranscript,
  SessionEventsResponseSchema,
  SNIPPET_CHARS,
} from "@k5-work/shared";
import {
  MAX_SESSION_BYTES,
  MAX_STORE_BYTES,
  MAX_LINE_BYTES,
  SessionStore,
  sanitizeTitle,
  TITLE_MAX_UNITS,
} from "./session-store.js";
import { SessionStoreError } from "./errors.js";
import { unsafeNameReason, isSafeNameSegment } from "./safe-name.js";

// The store's contract, asserted through its public surface. Where a test needs a
// database state a transaction would never produce (a summary that lags its own
// events, a payload that will not parse), it writes that state with a second
// connection rather than by damaging a file, because damaging a file is no longer
// something this store can be put into by accident.

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

const DB_NAME = "k5.db";

/**
 * A second connection to the same database, for writing states the store would
 * never create. Used only by the tests below that model corruption or an unclean
 * exit; every other test goes through the store.
 */
function poke(root: string, run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path.join(root, DB_NAME));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    run(db);
  } finally {
    db.close();
  }
}

/**
 * What is in the store root. SQLite keeps a write-ahead log beside the database
 * while it is open, so "one file" is not literally true and the assertion is that
 * nothing but k5's own database is there, which is the property that matters.
 */
const storeRootEntries = (root: string): Promise<string[]> =>
  fsp.readdir(root).then((entries) => entries.sort());

const DB_AND_SIDECARS = ["k5.db", "k5.db-shm", "k5.db-wal"];

// --- one file, and nothing derived from anything a harness controls ---

test("the store is one database file, and no harness string reaches the filesystem", async () => {
  // The old layout built a directory per session out of a hash, and spooled
  // attachments into named files. Every path guard that needed was a guard against
  // a harness-controlled string becoming a path component. There are no paths now
  // but the root and the database file, so a session recorded from a project whose
  // ids are a traversal attempt is stored exactly like any other.
  await withStore(async (store, root) => {
    const session = await newSession(store, {
      harnessSessionId: "../../../../etc/passwd",
      projectId: "..",
      title: "traversal attempt",
      cwd: "/tmp",
    });
    store.append(session.storeId, delta(1, "contained"));
    await store.flushMeta(session.storeId);

    assert.deepEqual(await storeRootEntries(root), DB_AND_SIDECARS, "and nothing else");
    assert.equal(store.summary(session.storeId)?.harness, "opencode");
    const page = await store.read(session.storeId, null);
    assert.equal(page.events.length, 1);
  });
});

test("the store root and every database file are not readable by anyone else", async () => {
  // Transcripts are agent output: source code, and whatever the agent read.
  // SQLite creates its files 0644 honouring only the umask, so the store has to
  // tighten them, and the sidecars have to be included because one created after
  // a reconnect takes its mode from the database file.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "secret"));
    await store.flushMeta(session.storeId);
    assert.equal((await fsp.stat(root)).mode & 0o777, 0o700, "the root");
    for (const name of await storeRootEntries(root)) {
      assert.equal(
        (await fsp.stat(path.join(root, name))).mode & 0o777,
        0o600,
        `${name} must not be readable by anyone else`,
      );
    }
  });
});

test("a reopened store tightens the modes again after the sidecars are recreated", async () => {
  // A close folds the write-ahead log away, so the next open creates fresh
  // sidecars. If the store only tightened them on the first open, everything
  // after that would be 0644.
  const root = tempRoot();
  try {
    for (const run of [0, 1]) {
      const store = new SessionStore({ root, onError: () => {} });
      await store.open();
      try {
        const session = await newSession(store, { title: `run ${run}` });
        store.append(session.storeId, delta(1, "secret"));
        await store.flushMeta(session.storeId);
      } finally {
        await store.close();
      }
      for (const name of await storeRootEntries(root)) {
        assert.equal(
          (await fsp.stat(path.join(root, name))).mode & 0o777,
          0o600,
          `run ${run}: ${name}`,
        );
      }
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
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

// --- append integrity ---

test("rapid appends page without loss, reorder or a gap", async () => {
  // The old append path was a queued O_APPEND write per event, which is not atomic
  // for large lines and needed a per-session queue to stay parseable. Here every
  // append is its own transaction, so the queue is gone and only the ordering is
  // left to check.
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
  // it could throw, an error here would escape into the emit and take every live
  // harness child with it.
  await withStore(async (store, root) => {
    assert.doesNotThrow(() => {
      store.append("00000000-0000-4000-8000-000000000000", delta(1, "hello"));
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await storeRootEntries(root), DB_AND_SIDECARS);
    assert.deepEqual(store.list(), []);
  });
});

test("a reporter that throws cannot make the store throw", async () => {
  // onError is caller-supplied. If it throws, append() throws into the synchronous
  // emit path, and a session silently stops recording while the summary keeps
  // claiming it is complete.
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
      assert.equal(page.events.length, 5, "the good records are all still there");
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

test("a failed append leaves no hole and the next one reuses the number safely", async () => {
  // A transaction either lands whole or not at all, so a failed record cannot
  // leave a gap and the next append is free to issue the same sequence number.
  // The old store had to roll the index back by hand to achieve this, and got it
  // wrong: it rolled back to the failed seq while later records still held theirs.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "one"));
    await store.flushMeta(session.storeId);

    // Occupy the sequence number the next append will choose, so its INSERT
    // violates the primary key and the transaction rolls back.
    poke(root, (db) => {
      db.prepare(
        "INSERT INTO events (store_id, seq, ts, payload, bytes) VALUES (?, ?, ?, ?, ?)",
      ).run(session.storeId, 2, new Date().toISOString(), JSON.stringify(delta(2, "squatter")), 64);
    });

    store.append(session.storeId, delta(2, "collides"));
    await store.flushMeta(session.storeId);

    assert.equal(
      store.summary(session.storeId)?.truncated,
      true,
      "a session that cannot write says its transcript is a prefix",
    );
    // The squatter is still the only row at seq 2: the failed append wrote nothing
    // over it and left no half-written record behind.
    const page = await store.read(session.storeId, null);
    assert.deepEqual(
      page.events.map((e) => e.seq),
      [1, 2],
      "no hole",
    );
    const atTwo = page.events[1]?.event;
    assert.equal(
      atTwo?.type === "turn.delta" && atTwo.text === "squatter",
      true,
      "and the row at seq 2 is the squatter, untouched by the failed write",
    );

    // And a session that gave up is refused from then on rather than retried into
    // the same failure for every subsequent event.
    store.append(session.storeId, delta(3, "after"));
    assert.deepEqual(
      (await store.read(session.storeId, null)).events.map((e) => e.seq),
      [1, 2],
      "a stopped writer stays stopped",
    );
  });
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

test("the cap is reported once, not once per dropped event", async () => {
  // Reporting and not stopping would produce a stream of identical errors for a
  // condition that will not resolve itself.
  const faults: SessionStoreError[] = [];
  await withStore(
    async (store) => {
      const session = await newSession(store);
      const chunk = "z".repeat(50_000);
      for (let index = 0; index < 60; index += 1) store.append(session.storeId, delta(index, chunk));
      await store.flushMeta(session.storeId);
    },
    { maxSessionBytes: 200_000, onError: (error) => faults.push(error) },
  );
  assert.equal(
    faults.filter((f) => f.code === "E_STORE_QUOTA").length,
    1,
    "one cap message, not one per refused event",
  );
});

test("the per-session cap survives a restart", async () => {
  // The cap has to be measured from what is stored, not from a counter that a
  // process starts at zero. Measured growing the log without bound across five
  // restarts when it was in memory.
  const root = tempRoot();
  const options = { root, maxSessionBytes: 200_000, onError: () => {} } as const;
  try {
    let storeId = "";
    for (let run = 0; run < 3; run += 1) {
      const store = new SessionStore(options);
      await store.open();
      try {
        if (run === 0) storeId = (await newSession(store)).storeId;
        const chunk = "q".repeat(50_000);
        for (let index = 0; index < 10; index += 1) {
          store.append(storeId, delta(run * 10 + index, chunk));
        }
        await store.flushMeta(storeId);
      } finally {
        await store.close();
      }
    }
    const store = new SessionStore(options);
    await store.open();
    try {
      const bytes = store.meta(storeId)?.bytes ?? 0;
      assert.ok(bytes > 0, "the stored byte count is re-measured at boot");
      assert.ok(bytes <= 200_000, `the cap must hold across restarts, but the log holds ${String(bytes)} bytes`);
    } finally {
      await store.close();
    }
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
      assert.equal(store.summary(first.storeId)?.lastSeq, 15, "the first session fits under the store cap");

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

test("hitting the session cap makes room even when the oldest session is live", async () => {
  // A session this process is recording is never evicted, so a create at the cap
  // has to look past it. The count of what is still in the store was decremented
  // for a row that was skipped, so the loop believed it had made room, stopped one
  // row early, deleted nothing, and every create after that failed for the rest of
  // the process. The only way out was deleting a session by hand.
  let clock = 1_000;
  const evicted: SessionStoreError[] = [];
  const root = tempRoot();
  const store = new SessionStore({
    root,
    maxSessions: 3,
    now: () => clock,
    onError: (e) => evicted.push(e),
  });
  await store.open();
  try {
    const make = async (title: string): Promise<string> => {
      clock += 1_000;
      return (
        await newSession(store, { title })
      ).storeId;
    };
    const oldest = await make("oldest");
    // One append pins it as live. It stays the oldest by recency because the other
    // two are created after it, and the eviction order is oldest first.
    clock += 1_000;
    store.append(oldest, delta(1, "pinned"));
    const pruned = await make("second");
    await make("third");
    assert.equal(store.list().length, 3, "at the cap");

    clock += 1_000;
    const fourth = await make("fourth");
    assert.notEqual(fourth, oldest, "the live session is the one that survives");
    assert.notEqual(store.summary(oldest), null, "a session being recorded is never pruned");
    assert.equal(store.summary(pruned), null, "the next oldest is pruned instead");
    assert.equal(store.list().length, 3, "and the cap still holds");
    assert.ok(evicted.some((f) => f.code === "E_STORE_EVICTED"));
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- contention with another writer ---

test("a transient lock costs one record, not the rest of the session", async () => {
  // The store is one file, so anything else that opens it, a second k5, a `sqlite3`
  // shell, a backup tool, can hold the write lock for a moment. Treating that like
  // a fault ended the session: every later event of a live turn was dropped and the
  // summary still claimed a complete transcript, which is the worst available
  // outcome because it is silent.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "before"));
    await store.flushMeta(session.storeId);

    const other = new DatabaseSync(path.join(root, DB_NAME));
    other.exec("PRAGMA busy_timeout = 0");
    other.exec("BEGIN IMMEDIATE");
    other.exec("CREATE TABLE IF NOT EXISTS _hold (a)");
    other.exec("INSERT INTO _hold VALUES (1)");
    // Inside the lock. The store waits out its own busy timeout and then gives up
    // on this one record, so the test holds the lock for exactly as long as that
    // takes. It releases the lock from a timer rather than after the call returns,
    // so a raise of BUSY_TIMEOUT_MS makes this test slower rather than wrong.
    store.append(session.storeId, delta(2, "collides"));
    other.exec("ROLLBACK");
    other.close();

    for (let index = 3; index <= 6; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);

    assert.equal(
      store.summary(session.storeId)?.truncated,
      false,
      "a lock is not a corrupt log, and the summary must not claim it is",
    );
    const seqs = (await store.read(session.storeId, null)).events.map((e) => e.seq);
    // The contended event is the one that may be missing. Everything the store
    // accepted has to be there, and the session has to keep recording: the record
    // after the collision is stored, which is the whole point.
    assert.equal(seqs.length, 5, `one record of six may be lost, got ${JSON.stringify(seqs)}`);
    assert.ok(seqs.includes(5), `later records must survive, got ${JSON.stringify(seqs)}`);
    for (let index = 1; index < seqs.length; index += 1) {
      assert.equal(seqs[index], (seqs[index - 1] ?? 0) + 1, "and the survivors stay contiguous");
    }
  });
});

// --- eviction ---

test("hitting the session cap makes room instead of failing forever", async () => {
  // The overflow was recomputed from the live count inside the loop, so each
  // deletion shrank the bound and the loop stopped one session short. After that,
  // every create() failed with no way out: a one-way door.
  const evicted: SessionStoreError[] = [];
  await withStore(
    async (store) => {
      for (let index = 0; index < 3; index += 1) {
        const created = await newSession(store, { title: `task ${index}` });
        assert.ok(store.summary(created.storeId) !== null);
      }
      assert.equal(store.list().length, 3);
      // These must all succeed, for ever, not just the first time.
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

test("eviction takes a session's events and attachments with it", async () => {
  // A delete that leaves rows behind means a store that grows forever no matter
  // what the session list says. The cascade is what makes this true by
  // construction rather than by remembering to clean up.
  const root = tempRoot();
  const options = { root, maxSessions: 2, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let victim = "";
  try {
    const a = await newSession(first, { title: "a" });
    first.append(a.storeId, delta(1, "x".repeat(50_000)));
    await first.spoolAttachment(a.storeId, {
      attachmentId: "att-1",
      name: "a.bin",
      mimeType: "application/octet-stream",
      bytes: Buffer.alloc(2_000),
    });
    await first.flushMeta(a.storeId);
    victim = a.storeId;
    await newSession(first, { title: "b" });
  } finally {
    await first.close();
  }

  const second = new SessionStore(options);
  await second.open();
  try {
    // A third session at the cap of two prunes the oldest, which is `a`.
    await newSession(second, { title: "c" });
    assert.equal(second.summary(victim), null, "the oldest is gone");
    poke(root, (db) => {
      const events = db
        .prepare("SELECT COUNT(*) AS total FROM events WHERE store_id = ?")
        .get(victim) as { total: number };
      const spooled = db
        .prepare("SELECT COUNT(*) AS total FROM attachments WHERE store_id = ?")
        .get(victim) as { total: number };
      assert.equal(Number(events.total), 0, "no event outlives its session");
      assert.equal(Number(spooled.total), 0, "and no attachment bytes either");
    });
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a session with an unusable timestamp is refused rather than pinning a slot", async () => {
  // SQLite is dynamically typed, so a timestamp column can hold anything. A row
  // this build cannot read is still occupying a slot, and it must not be allowed
  // to make the whole list unreadable.
  const faults: SessionStoreError[] = [];
  const root = tempRoot();
  const store = new SessionStore({ root, onError: (e) => faults.push(e) });
  await store.open();
  try {
    const good = await newSession(store, { title: "keep me" });
    const bad = await newSession(store, { title: "bad stamp" });
    poke(root, (db) => {
      db.prepare("UPDATE sessions SET updated_at = ? WHERE store_id = ?").run(
        "not a date",
        bad.storeId,
      );
    });
    const listed = store.list();
    assert.equal(listed.length, 1, "the good session still lists");
    assert.equal(listed[0]?.storeId, good.storeId);
    assert.equal(store.summary(bad.storeId), null, "the unusable one is refused, not kept");
    assert.ok(faults.some((f) => f.code === "E_STORE_META_CORRUPT"));
  } finally {
    await store.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("an unreadable row is evicted rather than pinning a slot for the life of the process", async () => {
  // The comment at the branch says a row this build cannot read is still
  // occupying a slot, and the loop answers that by counting it as absent, which
  // is the opposite. At the cap, decrementing `remaining` for a row it then
  // refuses to delete leaves `remaining` under the cap, so the loop breaks and
  // nothing is pruned: the store is full of rows it will neither evict nor let
  // the user delete, because list() skips them and read() refuses them.
  await withStore(
    async (store, root) => {
      const keep = await newSession(store, { title: "keep" });
      const bad = await newSession(store, { title: "bad stamp" });
      // Sorts first in `ORDER BY updated_at ASC`, so eviction meets it before
      // the readable row and is then told to stop.
      poke(root, (db) => {
        db.prepare("UPDATE sessions SET updated_at = ? WHERE store_id = ?").run(
          "!corrupt",
          bad.storeId,
        );
      });

      await newSession(store, { title: "third" });

      // Counted on disk, not through summary(): an unreadable row reads as
      // absent through the store's own API whether or not it was ever deleted,
      // so an assertion there would pass with or without the fix.
      poke(root, (db) => {
        const rows = db.prepare("SELECT store_id FROM sessions").all() as {
          store_id: string;
        }[];
        const ids = rows.map((row) => row.store_id);
        assert.ok(!ids.includes(bad.storeId), "the unreadable row was pruned");
        assert.ok(ids.includes(keep.storeId), "a readable row is kept");
        assert.equal(ids.length, 2, "and the new session took the slot");
      });
      assert.equal(store.list().length, 2, "both surviving sessions list");
    },
    { maxSessions: 2 },
  );
});

test("an unreadable row under the cap costs the user nothing", async () => {
  // The other side of that decision. Evicting every unreadable row on sight
  // would delete a user's transcript to tidy a store that had room, so the row
  // is only reclaimed when the cap is the reason a create failed.
  await withStore(
    async (store, root) => {
      const bad = await newSession(store, { title: "bad stamp" });
      poke(root, (db) => {
        db.prepare("UPDATE sessions SET updated_at = ? WHERE store_id = ?").run(
          "!corrupt",
          bad.storeId,
        );
      });

      await newSession(store, { title: "room to spare" });

      poke(root, (db) => {
        const rows = db.prepare("SELECT store_id FROM sessions").all() as {
          store_id: string;
        }[];
        assert.ok(
          rows.some((row) => row.store_id === bad.storeId),
          "the unreadable row stays while the store has room",
        );
        assert.equal(rows.length, 2, "and the new session was added beside it");
      });
      assert.equal(store.list().length, 1, "the readable one still lists");
    },
    { maxSessions: 4 },
  );
});

test("a numeric column refuses a value of the wrong type, and a wrong-shaped value is refused on read", async () => {
  // Two layers, and both are load-bearing. STRICT tables refuse the write at all,
  // so the bad value cannot exist. A future migration, or a database written by
  // another build, can still put one there, and a NaN turnCount made list() throw a
  // raw ZodError which 500'd the whole session list; a NaN byte count silently
  // disabled that session's quota, because every comparison against NaN is false.
  const faults: SessionStoreError[] = [];
  await withStore(
    async (store, root) => {
      const good = await newSession(store);
      const bad = await newSession(store);

      assert.throws(
        () =>
          poke(root, (db) => {
            db.prepare("UPDATE sessions SET turn_count = 'not a number' WHERE store_id = ?").run(
              bad.storeId,
            );
          }),
        /INTEGER/i,
        "the schema refuses a text turn count outright",
      );

      // A value of the right type but the wrong shape, which SQLite accepts and
      // the row schema must refuse.
      poke(root, (db) => {
        db.prepare("UPDATE sessions SET turn_count = -1 WHERE store_id = ?").run(bad.storeId);
      });
      const listed = store.list();
      assert.equal(listed.length, 1, "the whole list still renders");
      assert.equal(listed[0]?.storeId, good.storeId);
      assert.equal(store.summary(bad.storeId), null);
      assert.ok(faults.some((f) => f.code === "E_STORE_META_CORRUPT"));
    },
    { onError: (e) => faults.push(e) },
  );
});

// --- read path ---

test("a read never changes what is stored", async () => {
  await withStore(async (store, _root) => {
    const session = await newSession(store);
    store.append(session.storeId, delta(1, "one"));
    store.append(session.storeId, delta(2, "two"));
    await store.flushMeta(session.storeId);
    const before = await store.read(session.storeId, null);
    for (let index = 0; index < 5; index += 1) await store.read(session.storeId, index);
    const after = await store.read(session.storeId, null);
    assert.deepEqual(
      after.events.map((e) => e.event),
      before.events.map((e) => e.event),
      "the same records, in the same order, after five reads",
    );
    assert.equal(after.lastSeq, before.lastSeq, "and the summary did not move");
  });
});

test("one unreadable payload does not make every page empty", async () => {
  // Aborting the page on the first bad record made a session permanently
  // unreadable, and a client following the documented recovery looped for ever.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 5; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    poke(root, (db) => {
      db.prepare("UPDATE events SET payload = ? WHERE store_id = ? AND seq = 3").run(
        "{ not json at all",
        session.storeId,
      );
    });

    const page = await store.read(session.storeId, null);
    assert.ok(page.dropped >= 1, "the unreadable record is reported");
    const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
    assert.ok(texts.includes("m1"), "records before the bad one still arrive");
    assert.ok(texts.includes("m5"), "records after the bad one still arrive");
    assert.equal(SessionEventsResponseSchema.safeParse(page).success, true);
  });
});

test("a summary claiming records the store does not hold is reported as loss", async () => {
  // The old store's summary could sit ahead of its log after a crash, and an
  // empty answer there is indistinguishable from caught-up, so the client waits
  // for ever. The cascade and the transaction make the state hard to reach, and
  // this is what happens when it is reached anyway.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 3; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    poke(root, (db) => {
      db.prepare("DELETE FROM events WHERE store_id = ?").run(session.storeId);
      // The cascade takes events with the session, so the rows are re-inserted
      // under a session that is about to be reconciled away.
      db.prepare("UPDATE sessions SET last_seq = 3, first_seq = 1 WHERE store_id = ?").run(
        session.storeId,
      );
    });
    const page = await store.read(session.storeId, 0);
    assert.equal(page.status, "cursor-invalid", "an empty answer would strand the client");
    assert.ok(page.dropped > 0, "the loss is reported, not hidden");
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
    // the summary is edited to model a compaction.
    poke(root, (db) => {
      db.prepare("UPDATE sessions SET first_seq = 3 WHERE store_id = ?").run(session.storeId);
    });
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
    poke(root, (db) => {
      db.prepare("DELETE FROM events WHERE store_id = ? AND seq = 2").run(session.storeId);
    });
    const page = await store.read(session.storeId, null);
    assert.ok(page.dropped >= 1, "the missing record is counted");
    const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
    assert.ok(texts.includes("m4"), "the records that do exist are still delivered");
    assert.equal(page.nextSince, 4, "and the cursor still names the last served record");
  });
});

test("paging never lets a dropped record desync the cursor", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 10; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    poke(root, (db) => {
      db.prepare("UPDATE events SET payload = ? WHERE store_id = ? AND seq = 7").run(
        "{ dropped",
        session.storeId,
      );
    });

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
    // Monotonic within what exists.
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok((seen[index] ?? 0) > (seen[index - 1] ?? 0), "the cursor never goes backwards");
    }
  });
});

test("a record stored below the page's start is reported, not served", async () => {
  // A negative dropped count failed the response schema, and the API turned that
  // into an anonymous 500: a session that could be listed but never reopened. The
  // response schema is what rejects a negative count, so the value is asserted as
  // the schema will actually accept it, and the count is checked for being real
  // rather than merely non-negative.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 4; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    poke(root, (db) => {
      db.prepare("UPDATE events SET seq = 0 WHERE store_id = ? AND seq = 1").run(session.storeId);
    });
    const page = await store.read(session.storeId, null);
    assert.equal(page.dropped, 1, "the record outside the window is counted, and never below zero");
    assert.deepEqual(
      page.events.map((e) => e.seq),
      [2, 3, 4],
      "and the records that exist are still delivered",
    );
    assert.equal(SessionEventsResponseSchema.safeParse(page).success, true);
  });
});

// --- bounds ---

test("a record over the line cap is dropped, reported, and counted as lost", async () => {
  // The drop leaves no sequence gap, so a reader comparing numbers sees a
  // contiguous log and concludes nothing is missing. That is what made a lost
  // assistant message look like a complete transcript. `dropped` is the only
  // thing standing between the two.
  await withStore(
    async (store) => {
      const session = await newSession(store);
      store.append(session.storeId, delta(1, "before"));
      store.append(session.storeId, delta(2, "y".repeat(MAX_LINE_BYTES)));
      store.append(session.storeId, delta(3, "after"));
      await store.flushMeta(session.storeId);
      const page = await store.read(session.storeId, null);
      const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
      assert.deepEqual(texts, ["before", "after"]);
      // Not truncated: the session kept accepting appends, so the log is a
      // transcript with a hole in it rather than a prefix that stopped growing.
      assert.equal(store.summary(session.storeId)?.truncated, false);
      assert.equal(store.summary(session.storeId)?.droppedRecords, 1);
      assert.equal(page.dropped, 1);
      // And the loss is visible to the browser through the projection, which is
      // where a user would actually see it.
      const projected = projectTranscript(
        page.events.map((e) => ({ v: 1 as const, seq: e.seq, ts: e.ts, event: e.event })),
        { dropped: page.dropped },
      );
      assert.equal(projected.dropped, 1);
    },
    { onError: () => {} },
  );
});

test("a dropped record stays counted after a restart", async () => {
  // The row outlives the process that lost the record, so the count has to be
  // stored rather than kept in memory. Reading only the in-memory map meant a
  // restart quietly reset it and the transcript went back to reporting itself
  // whole while still missing the same turn.
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  try {
    const session = await newSession(first);
    first.append(session.storeId, delta(1, "before"));
    first.append(session.storeId, delta(2, "y".repeat(MAX_LINE_BYTES)));
    first.append(session.storeId, delta(3, "after"));
    await first.flushMeta(session.storeId);
  } finally {
    await first.close();
  }

  const second = new SessionStore(options);
  await second.open();
  try {
    const ids = second.list().map((entry) => entry.storeId);
    assert.equal(ids.length, 1);
    const page = await second.read(ids[0] ?? "", null);
    assert.equal(page.events.length, 2, "the lost record stays lost");
    assert.equal(page.dropped, 1, "and it is still admitted after the restart");
    assert.equal(second.summary(ids[0] ?? "")?.droppedRecords, 1);
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a harness timestamp is normalised to ISO so the sidebar can order by it", async () => {
  // `updated_at` is TEXT and every comparator on it is a byte comparison: the
  // sidebar sorts, the recency index is built on it, and age eviction parses it.
  // `Date.parse` accepting a string does not make that string sortable, so a
  // harness answering "Feb 1 2026" parked its session above every ISO row and a
  // live task could be reaped for looking like the oldest thing in the store.
  //
  // The clock is pinned, and both stamps sit inside the idle window, because a
  // real clock made this test lie. A month-old row is idle by definition and
  // create() evicts idle sessions before it inserts, so the first session was
  // deleted the moment the second one was created and the assertion failed on
  // the list rather than on the ordering it was written to check. Pinning it also
  // stops the test going quietly stale.
  const clock = Date.parse("2026-06-20T00:00:00.000Z");
  await withStore(
    async (store) => {
      const session = await newSession(store, { title: "harness dated" });
      store.setTitle(session.storeId, "harness dated", "Jun 5 2026");
      const updatedAt = store.summary(session.storeId)?.updatedAt;
      // Expected value computed the same way, not hardcoded: a bare date string has
      // no zone, so V8 reads it as local time and the UTC instant differs on every
      // box that is not on GMT. Hardcoding a UTC literal made this test fail on a
      // machine in Asia/Calcutta.
      assert.equal(updatedAt, new Date(Date.parse("Jun 5 2026")).toISOString());
      // And it sorts where the date says it should: below the June 10 row, not above
      // it. "J" is a higher byte than "2", so a lexicographic compare on the raw
      // harness string put it first. That inversion is the bug this test exists
      // for, and it still inverts with both dates in the same month.
      const later = await newSession(store, { title: "iso newer" });
      store.setTitle(later.storeId, "iso newer", "2026-06-10T00:00:00.000Z");
      const titles = store.list().map((entry) => entry.title);
      assert.deepEqual(titles, ["iso newer", "harness dated"]);
    },
    { now: () => clock },
  );
});

test("an unparseable harness timestamp leaves the stored one alone", async () => {
  await withStore(async (store) => {
    const session = await newSession(store, { title: "kept" });
    const before = store.summary(session.storeId)?.updatedAt;
    store.setTitle(session.storeId, "kept", "not a date at all");
    assert.equal(store.summary(session.storeId)?.updatedAt, before);
  });
});

test("a boot rewrites a timestamp that was stored before the normalisation", async () => {
  // The write path normalises now, but rows written by an older build are still
  // on disk and age eviction deletes on that column. A data repair, not cosmetics.
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let storeId = "";
  try {
    const session = await newSession(first, { title: "legacy date" });
    storeId = session.storeId;
    await first.flushMeta(session.storeId);
    // What the old build wrote: the harness string, verbatim.
    poke(root, (db) => {
      db.prepare("UPDATE sessions SET updated_at = ? WHERE store_id = ?").run("1 Jan 2020", storeId);
    });
  } finally {
    await first.close();
  }

  const second = new SessionStore(options);
  await second.open();
  try {
    assert.equal(
      second.summary(storeId)?.updatedAt,
      new Date(Date.parse("1 Jan 2020")).toISOString(),
      "a row stored as '1 Jan 2020' would otherwise sort below every ISO row and read as the oldest session",
    );
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
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

// --- unknown session and unopened store ---

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
  // And the synchronous path is a no-op rather than a throw.
  assert.doesNotThrow(() => {
    store.append("11111111-1111-4111-8111-111111111111", delta(1, "x"));
  });
  await fsp.rm(root, { recursive: true, force: true });
});

test("a page of nothing but unreadable records ends the read instead of looping for ever", async () => {
  // Claiming hasMore on a page that served nothing is a contract no client can
  // satisfy: the cursor did not move, so asking again returns the same page. The
  // browser happened to absorb this by refusing an empty page, which put a store
  // invariant on the client to enforce for every other consumer of the contract.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 3; index += 1) store.append(session.storeId, delta(index, `m${index}`));
    await store.flushMeta(session.storeId);
    poke(root, (db) => {
      db.prepare("UPDATE events SET payload = ? WHERE store_id = ?").run(
        JSON.stringify({ type: "turn.delta", futureField: true }),
        session.storeId,
      );
    });

    const first = await store.read(session.storeId, null);
    assert.equal(first.events.length, 0);
    assert.equal(first.hasMore, false, "an empty page must not promise more");
    assert.notEqual(first.status, "appended", "nothing was appended to this reader");
    assert.equal(first.dropped, 3, "and the loss is reported");

    // Following the cursor it handed back terminates rather than repeating.
    const second = await store.read(session.storeId, first.nextSince);
    assert.notEqual(second.status, "appended");
    assert.equal(SessionEventsResponseSchema.safeParse(second).success, true);
  });
});

test("a summary that claims records the store does not hold is repaired at boot", async () => {
  // The import can produce this from a legacy session whose meta was written and
  // whose log never was. A summary promising 400 records the store does not have
  // makes every read of that task fail for ever, with no repair path.
  const root = tempRoot();
  try {
    await fsp.mkdir(path.join(root, "s-abc123"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "s-abc123", "meta.json"),
      legacyMeta({ lastSeq: 412, firstSeq: 1, turnCount: 7 }),
      "utf8",
    );
    // No events.jsonl at all.

    const store = new SessionStore({ root, onError: () => {} });
    await store.open();
    try {
      const id = store.list()[0]?.storeId ?? "";
      assert.ok(id.length > 0, "the session is still listed, not hidden");
      assert.equal(store.meta(id)?.lastSeq, 0, "and it no longer claims 412 records");
      const page = await store.read(id, null);
      assert.equal(page.status, "up-to-date", "so it reads as empty rather than for ever broken");
    } finally {
      await store.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
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
    poke(root, (db) => {
      const events = db
        .prepare("SELECT COUNT(*) AS total FROM events WHERE store_id = ?")
        .get(session.storeId) as { total: number };
      assert.equal(Number(events.total), 0, "and no events outlive it");
    });
  });
});

test("appends queued around a delete are dropped, and the store keeps working", async () => {
  // There is no race to win here and the test does not pretend otherwise: remove()
  // has no await in it, so it runs whole before the next line. What matters is the
  // consequence, which is the property worth protecting. A delete must not be undone
  // by the events that were already in flight, and it must not leave the store
  // unable to record the next task.
  await withStore(async (store, root) => {
    const session = await newSession(store);
    for (let index = 1; index <= 50; index += 1) store.append(session.storeId, delta(index, "x".repeat(5_000)));
    const removed = store.remove(session.storeId);
    for (let index = 51; index <= 60; index += 1) store.append(session.storeId, delta(index, "late"));
    assert.equal(await removed, true);
    assert.equal(store.summary(session.storeId), null);
    assert.equal(store.list().length, 0, "and it is not in the list either");
    poke(root, (db) => {
      const rows = db
        .prepare("SELECT COUNT(*) AS total FROM events WHERE store_id = ?")
        .get(session.storeId) as { total: number };
      assert.equal(Number(rows.total), 0, "no event outlives the session");
    });
    // And the store still works afterwards.
    const next = await newSession(store, { title: "after" });
    store.append(next.storeId, delta(1, "fresh"));
    await store.flushMeta(next.storeId);
    assert.equal((await store.read(next.storeId, null)).events.length, 1);
  });
});

// --- attachments ---
// A four-byte PNG header: valid as a PNG, not decodable as UTF-8.
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("a spooled attachment round-trips, and its manifest is derived from the bytes", async () => {
  await withStore(async (store) => {
    const session = await newSession(store);
    // The client claims this is plain text. It is not, and the manifest must say
    // what arrived rather than what was asked for: a harness handed a binary as
    // text inlines replacement characters, and the transcript records a size that
    // never existed.
    const manifest = await store.spoolAttachment(session.storeId, {
      attachmentId: "att-1",
      name: "notes.txt",
      mimeType: "text/plain",
      bytes: PNG_HEAD,
    });
    assert.deepEqual(manifest, {
      attachmentId: "att-1",
      name: "notes.txt",
      mimeType: "text/plain",
      kind: "binary",
      size: 4,
    });
    assert.deepEqual(await store.readAttachment(session.storeId, "att-1"), PNG_HEAD);
    assert.deepEqual(await store.attachmentManifest(session.storeId, "att-1"), manifest);

    // The declared mime only ever decides image versus binary, and only for bytes
    // that are not text.
    const asImage = await store.spoolAttachment(session.storeId, {
      attachmentId: "att-2",
      name: "shot.png",
      mimeType: "image/png",
      bytes: PNG_HEAD,
    });
    assert.equal(asImage.kind, "image");
    const asText = await store.spoolAttachment(session.storeId, {
      attachmentId: "att-3",
      name: "shot.png",
      mimeType: "text/plain",
      bytes: Buffer.from("plain words", "utf8"),
    });
    assert.equal(asText.kind, "text", "decodable UTF-8 is text whatever the name claims");
    assert.equal(asText.size, 11);
  });
});

test("attachment bytes survive a restart", async () => {
  // The bytes are the only copy. A manifest remembered in memory but not stored
  // meant a turn that named an attachment ran with nothing attached, silently.
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let storeId = "";
  try {
    storeId = (await newSession(first)).storeId;
    await first.spoolAttachment(storeId, {
      attachmentId: "att-1",
      name: "a.bin",
      mimeType: "application/octet-stream",
      bytes: Buffer.from([1, 2, 3, 250]),
    });
  } finally {
    await first.close();
  }
  const second = new SessionStore(options);
  await second.open();
  try {
    assert.deepEqual(await second.readAttachment(storeId, "att-1"), Buffer.from([1, 2, 3, 250]));
    assert.equal((await second.attachmentManifest(storeId, "att-1")).size, 4);
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("spooling into an unknown or deleted session is refused and creates nothing", async () => {
  await withStore(async (store, root) => {
    await assert.rejects(
      () =>
        store.spoolAttachment("11111111-1111-4111-8111-111111111111", {
          attachmentId: "att-1",
          name: "a.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("x"),
        }),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_SESSION",
    );
    assert.deepEqual(await storeRootEntries(root), DB_AND_SIDECARS);

    // A deleted session must not be brought back by a late upload.
    const session = await newSession(store);
    await store.spoolAttachment(session.storeId, {
      attachmentId: "att-1",
      name: "a.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("x"),
    });
    assert.equal(await store.remove(session.storeId), true);
    await assert.rejects(
      () =>
        store.spoolAttachment(session.storeId, {
          attachmentId: "att-2",
          name: "a.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("x"),
        }),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_SESSION",
    );
    assert.deepEqual(await storeRootEntries(root), DB_AND_SIDECARS);
  });
});

test("an attachment id that is not a safe name is refused outright", async () => {
  // The id is a key rather than a path now, so there is nothing to escape. It is
  // still refused, because these shapes are a caller bug and a row carrying one
  // is a row nobody can name again.
  await withStore(async (store) => {
    const session = await newSession(store);
    for (const bad of ["..", "../escape", "with\nnewline", "a/b", "", "nul\u0000byte"]) {
      await assert.rejects(
        () =>
          store.spoolAttachment(session.storeId, {
            attachmentId: bad,
            name: "a.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("x"),
          }),
        (error: unknown) => error instanceof SessionStoreError,
        `${JSON.stringify(bad)} must be refused`,
      );
      await assert.rejects(
        () => store.readAttachment(session.storeId, bad),
        (error: unknown) =>
          error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
      );
    }
  });
});

test("an attachment is bounded by the store's own caps", async () => {
  await withStore(
    async (store, root) => {
      const session = await newSession(store);
      await assert.rejects(
        () =>
          store.spoolAttachment(session.storeId, {
            attachmentId: "att-1",
            name: "huge.bin",
            mimeType: "application/octet-stream",
            bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
          }),
        (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_QUOTA",
      );
      // A manifest that cannot satisfy the contract is refused before a byte is
      // written, rather than stored and discovered broken by the turn.
      await assert.rejects(
        () =>
          store.spoolAttachment(session.storeId, {
            attachmentId: "att-1",
            name: "x".repeat(400),
            mimeType: "text/plain",
            bytes: Buffer.from("x"),
          }),
        (error: unknown) => error instanceof SessionStoreError,
      );
      poke(root, (db) => {
        const rows = db.prepare("SELECT COUNT(*) AS total FROM attachments").get() as { total: number };
        assert.equal(Number(rows.total), 0, "a refused upload must leave no bytes behind");
      });
    },
    { maxStoreBytes: MAX_ATTACHMENT_BYTES + 1_000_000 },
  );
});

test("an attachment over the whole-store cap is refused", async () => {
  await withStore(
    async (store) => {
      const session = await newSession(store);
      await assert.rejects(
        () =>
          store.spoolAttachment(session.storeId, {
            attachmentId: "att-1",
            name: "big.bin",
            mimeType: "application/octet-stream",
            bytes: Buffer.alloc(8_000),
          }),
        (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_QUOTA",
      );
    },
    { maxStoreBytes: 4_000 },
  );
});

test("a missing attachment is a typed error in both directions", async () => {
  await withStore(async (store) => {
    const session = await newSession(store);
    await store.spoolAttachment(session.storeId, {
      attachmentId: "att-1",
      name: "a.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("payload", "utf8"),
    });
    // "att-1.json" is a legal attachment id, and it is a different row.
    await assert.rejects(
      () => store.readAttachment(session.storeId, "att-1.json"),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
    );
    await assert.rejects(
      () => store.attachmentManifest(session.storeId, "never-spooled"),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
    );
    await assert.rejects(
      () => store.readAttachment(session.storeId, "never-spooled"),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
    );
    // And an attachment belonging to another session is not reachable from this one.
    const other = await newSession(store);
    await assert.rejects(
      () => store.readAttachment(other.storeId, "att-1"),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
    );
  });
});

test("an unused attachment can be dropped, and deleting the session takes the rest", async () => {
  await withStore(async (store, root) => {
    const session = await newSession(store);
    const spool = async (attachmentId: string): Promise<void> => {
      await store.spoolAttachment(session.storeId, {
        attachmentId,
        name: "a.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("x", "utf8"),
      });
    };
    await spool("att-1");
    await spool("att-2");
    assert.equal(await store.discardAttachment(session.storeId, "att-1"), true);
    // Idempotent, so a retried delete is not a confusing error.
    assert.equal(await store.discardAttachment(session.storeId, "att-1"), false);
    assert.equal(await store.discardAttachment(session.storeId, "att-2"), true);
    await assert.rejects(
      () => store.readAttachment(session.storeId, "att-2"),
      (error: unknown) =>
        error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
    );

    await spool("att-3");
    assert.equal(await store.remove(session.storeId), true);
    assert.deepEqual(await storeRootEntries(root), DB_AND_SIDECARS);
  });
});

test("a store that is not open refuses to spool", async () => {
  const root = tempRoot();
  const store = new SessionStore({ root });
  await assert.rejects(
    () =>
      store.spoolAttachment("11111111-1111-4111-8111-111111111111", {
        attachmentId: "att-1",
        name: "a.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("x"),
      }),
    (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_WRITABLE",
  );
  await fsp.rm(root, { recursive: true, force: true });
});

test("the whole-store cap bites on the second upload, not only the first", async () => {
  // The ceiling used to be checked against a counter the spool never added to, so
  // every upload passed the check however many had gone before. Two uploads that
  // each fit must together exceed the cap.
  await withStore(
    async (store) => {
      const session = await newSession(store);
      const upload = (attachmentId: string) =>
        store.spoolAttachment(session.storeId, {
          attachmentId,
          name: `${attachmentId}.bin`,
          mimeType: "application/octet-stream",
          bytes: Buffer.alloc(2_000),
        });
      await upload("att-1");
      await assert.rejects(
        () => upload("att-2"),
        (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_QUOTA",
        "2 x 2 KB must not both fit under a 3 KB cap",
      );
      // And the refused one left nothing behind, so a later turn naming it would
      // not find a row to read.
      await assert.rejects(
        () => store.readAttachment(session.storeId, "att-2"),
        (error: unknown) =>
          error instanceof SessionStoreError && error.code === "E_STORE_UNKNOWN_ATTACHMENT",
      );
    },
    { maxStoreBytes: 3_000 },
  );
});

test("discarding an attachment gives the budget back", async () => {
  // Otherwise a store that once held a large attachment refuses real writes for
  // the rest of the process, while the disk is wide open.
  await withStore(
    async (store) => {
      const session = await newSession(store);
      const upload = (attachmentId: string) =>
        store.spoolAttachment(session.storeId, {
          attachmentId,
          name: `${attachmentId}.bin`,
          mimeType: "application/octet-stream",
          bytes: Buffer.alloc(2_000),
        });
      await upload("att-1");
      assert.equal(await store.discardAttachment(session.storeId, "att-1"), true);
      // The room is back, so this must be accepted where it was refused before.
      await upload("att-2");
    },
    { maxStoreBytes: 3_000 },
  );
});

test("removing a session gives its spooled bytes back", async () => {
  await withStore(
    async (store) => {
      const first = await newSession(store);
      await store.spoolAttachment(first.storeId, {
        attachmentId: "att-1",
        name: "a.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.alloc(2_000),
      });
      assert.equal(await store.remove(first.storeId), true);
      // A second session's upload must not be refused for bytes that are gone.
      const second = await newSession(store);
      await store.spoolAttachment(second.storeId, {
        attachmentId: "att-2",
        name: "b.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.alloc(2_000),
      });
    },
    { maxStoreBytes: 3_000 },
  );
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
  assert.ok([...cut].length <= 11, `expected at most 11 graphemes, got ${String([...cut].length)}`);
  assert.ok(cut.endsWith("…"));
});

test("a title of emoji does not produce a row the store cannot read back", async () => {
  // The bound on a title is in UTF-16 code units, because that is what a JavaScript
  // string's length is and that is what every schema downstream checks. Capping by
  // grapheme instead admitted 480 units of a 120-emoji title, and the result was a
  // row this store could write and then not read: setTitle stored it without
  // complaint, summary() returned null, and because append() looks the session up
  // first, every later event of a live turn was dropped with no error at all.
  await withStore(async (store) => {
    const session = await newSession(store, { title: "\u{1F44D}\u{1F3FD}".repeat(120) });
    const summary = store.summary(session.storeId);
    assert.notEqual(summary, null, "the session must still be readable");
    assert.ok(
      (summary?.title.length ?? 0) <= TITLE_MAX_UNITS,
      `a stored title must fit the bound, got ${String(summary?.title.length)}`,
    );
    // And it survives the harness re-titling the session mid-turn, which is when
    // the real one arrived.
    store.append(session.storeId, delta(1, "before"));
    store.setTitle(session.storeId, "\u{1F44D}\u{1F3FD}".repeat(120));
    assert.notEqual(store.summary(session.storeId), null, "still readable after a harness title");
    assert.equal(store.summary(session.storeId)?.lastSeq, 1, "and still recording");
    assert.equal((await store.read(session.storeId, 0)).events.length, 1);
  });
});

test("a title the schema would refuse is shortened rather than written", async () => {
  // A row that cannot be parsed cannot be listed, selected, removed, or appended
  // to, and nothing reports it. create() validated after the INSERT, so the row was
  // already durable when the summary threw a raw ZodError, and the caller never
  // learned the store id at all. Every write path is checked first now.
  await withStore(async (store) => {
    const session = await newSession(store, { title: "x".repeat(20_000) });
    const summary = store.summary(session.storeId);
    assert.notEqual(summary, null, "a refused title must not become an unreadable row");
    assert.ok((summary?.title.length ?? 0) <= TITLE_MAX_UNITS);
  });
});

test("sanitizeTitle falls back rather than splitting a surrogate pair", async () => {
  // A ZWJ emoji sequence is one grapheme and many code units. Cutting it in the
  // middle is mojibake in a sidebar row, which is the thing this function exists
  // to prevent, so an unbudgetable grapheme yields the placeholder instead.
  const cut = sanitizeTitle("\u{1F680}".repeat(200), 10);
  assert.ok(!cut.includes("\ufffd"), "no replacement characters from a split surrogate pair");
  assert.ok(cut.endsWith("\u2026"), "and it is marked as cut");
  const joined = sanitizeTitle("\u{1F469}\u200D\u{1F4BB}".repeat(300));
  assert.ok(joined.length <= TITLE_MAX_UNITS, `bounded, got ${String(joined.length)}`);
  assert.ok(!joined.includes("\ufffd"), "a ZWJ sequence is never cut in half");
});

test("a session title is bounded in the list response", async () => {
  await withStore(async (store) => {
    const session = await newSession(store, { title: "x".repeat(20_000) });
    const summary = store.summary(session.storeId);
    assert.ok(summary !== null, "the session is listed");
    // `summary.title` and not `summary?.title`: the optional chain turned a null
    // summary into `undefined <= 200`, which passes and proves nothing.
    assert.ok(
      summary.title.length <= 200,
      `expected at most 200 characters, got ${String(summary.title.length)}`,
    );
  });
});

test("a prompt of literally the placeholder does not re-arm the title fallback", async () => {
  // Comparing against the rendered string meant turn two of such a session
  // silently renamed it from the harness's own title back to the prompt's.
  await withStore(async (store) => {
    const session = await newSession(store, { title: "Untitled task" });
    store.append(session.storeId, delta(1, "x"));
    await store.flushMeta(session.storeId);
    store.setTitle(session.storeId, "the harness named this");
    store.titleFromPrompt(session.storeId, "Untitled task");
    assert.equal(store.summary(session.storeId)?.title, "the harness named this");
  });
});

// --- boot reconciliation ---
// A summary can sit behind its own events, so the events win. Nothing that a
// transaction does produces this any more, but the repair is cheap and the case
// it covers is a real one: a database copied or restored from a snapshot.

test("a boot takes the events as the authority when the stored summary lags them", async () => {
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

  poke(root, (db) => {
    db.prepare("UPDATE sessions SET last_seq = 2, bytes = 0 WHERE store_id = ?").run(storeId);
  });

  const second = new SessionStore(options);
  await second.open();
  try {
    assert.equal(second.meta(storeId)?.lastSeq, 5, "the events win");
    // Appending must not reissue a number the events already hold.
    second.append(storeId, delta(6, "m6"));
    await second.flushMeta(storeId);
    const page = await second.read(storeId, null);
    assert.deepEqual(page.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6], "no duplicate and no gap");
    assert.equal(page.dropped, 0, `dropped ${String(page.dropped)}`);
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a boot takes the lowest stored sequence as the start of the log", async () => {
  // The case a crash during a session's first turn produced: several records
  // stored and a summary that still claimed firstSeq 0. Deriving the repair from
  // lastSeq claimed the log began at its final record, and the opening of the
  // conversation became unreadable.
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let storeId = "";
  try {
    storeId = (await newSession(first)).storeId;
    for (let index = 1; index <= 4; index += 1) first.append(storeId, delta(index, `m${index}`));
    await first.flushAll();
  } finally {
    await first.close();
  }

  poke(root, (db) => {
    db.prepare("UPDATE sessions SET first_seq = 0, last_seq = 0 WHERE store_id = ?").run(storeId);
  });

  const second = new SessionStore(options);
  await second.open();
  try {
    assert.equal(second.meta(storeId)?.firstSeq, 1, "the log begins at its first record");
    assert.deepEqual(
      (await second.read(storeId, null)).events.map((e) => e.seq),
      [1, 2, 3, 4],
      "so a reader is served the whole transcript, not its last record",
    );
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("the list is ordered by recency, not by how many records a task holds", async () => {
  // lastSeq counts records inside one session, so it is not a clock. Ordering on
  // it, or using it to break a tie, put a long old task above a short new one,
  // which is the opposite of what the column claims.
  //
  // The clock is pinned one millisecond apart, and the tie case is covered
  // separately, because with a real clock this test silently became a coin flip
  // about whether two creates landed in the same millisecond.
  let clock = 10_000;
  await withStore(
    async (store) => {
      clock += 1_000;
      const old = await newSession(store, { title: "long old task" });
      for (let index = 1; index <= 9; index += 1) {
        clock += 1;
        store.append(old.storeId, delta(index, `m${index}`));
      }
      await store.flushMeta(old.storeId);

      clock += 1_000;
      const fresh = await newSession(store, { title: "short new task" });
      clock += 1;
      store.append(fresh.storeId, delta(1, "one"));
      await store.flushMeta(fresh.storeId);

      const listed = store.list().map((entry) => entry.storeId);
      assert.equal(listed[0], fresh.storeId, "the newer task is first");
      assert.equal(listed[1], old.storeId, "and the longer older one is second");
    },
    { now: () => clock },
  );
});

test("a completed turn is counted, and a boot that finds an open one says so", async () => {
  // Nothing runs on SIGKILL, so a terminator written on a graceful release is
  // best-effort. Without this, a reloaded transcript showed tool cards spinning
  // for ever while the store called the session complete.
  const faults: SessionStoreError[] = [];
  const root = tempRoot();
  const options = { root, onError: () => {} } as const;
  const first = new SessionStore(options);
  await first.open();
  let openId = "";
  let closedId = "";
  try {
    openId = (await newSession(first, { title: "cut short" })).storeId;
    first.append(openId, delta(1, "partial"));
    first.append(openId, {
      type: "tool.updated",
      sessionId: "ses_live",
      turnId: "t-1",
      toolCallId: "tool-1",
      title: "a long build",
      status: "in_progress",
      lifecycle: "active",
    });
    await first.flushMeta(openId);

    closedId = (await newSession(first, { title: "finished" })).storeId;
    first.append(closedId, delta(1, "done"));
    first.append(closedId, {
      type: "turn.completed",
      sessionId: "ses_live",
      turnId: "t-1",
      stopReason: "end_turn",
    });
    await first.flushMeta(closedId);
    assert.equal(first.summary(closedId)?.turnCount, 1, "a completed turn is counted once");
  } finally {
    await first.close();
  }

  const second = new SessionStore({ root, onError: (e) => faults.push(e) });
  await second.open();
  try {
    assert.equal(second.meta(openId)?.endedMidTurn, true, "the unclean end is recorded");
    assert.equal(second.meta(openId)?.truncated, true, "and the summary stops claiming completeness");
    assert.equal(second.meta(closedId)?.endedMidTurn, false, "a clean end must not look unclean");
    assert.equal(second.meta(closedId)?.truncated, false);
    assert.ok(faults.some((f) => f.code === "E_STORE_CORRUPT_LOG"), "and it is reported");
  } finally {
    await second.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- migration from the pre-SQLite layout ---

function legacyMeta(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    storeId: "11111111-1111-4111-8111-111111111111",
    harness: "opencode",
    harnessSessionId: "ses_legacy",
    projectId: "proj-1",
    projectName: "k5-work",
    cwd: "/home/k5/code/k5-work",
    title: "an older task",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    turnCount: 1,
    firstSeq: 1,
    lastSeq: 2,
    bytes: 0,
    truncated: false,
    titleSource: "prompt",
    endedMidTurn: false,
    ...overrides,
  });
}

function legacyLine(seq: number, text: string): string {
  return `${JSON.stringify({
    v: 1,
    seq,
    ts: "2026-01-01T00:00:00.000Z",
    event: delta(seq, text),
  })}\n`;
}

test("an existing pre-SQLite store is imported once, and its transcripts read back", async () => {
  // A rewrite that dropped the old layout would take a user's history with it.
  // The import is one transaction per session, so a failure part-way leaves the
  // sessions it did import intact.
  const root = tempRoot();
  try {
    await fsp.mkdir(path.join(root, "s-abc123"), { recursive: true });
    await fsp.writeFile(path.join(root, "s-abc123", "meta.json"), legacyMeta(), "utf8");
    await fsp.writeFile(
      path.join(root, "s-abc123", "events.jsonl"),
      legacyLine(1, "hello from before") + legacyLine(2, "and again"),
      "utf8",
    );

    const store = new SessionStore({ root, onError: () => {} });
    await store.open();
    try {
      const listed = store.list();
      assert.equal(listed.length, 1, "the old session is a k5 session now");
      assert.equal(listed[0]?.title, "an older task");
      assert.equal(listed[0]?.turnCount, 1);
      const page = await store.read(listed[0]?.storeId ?? "", null);
      const texts = page.events.map((e) => (e.event.type === "turn.delta" ? e.event.text : ""));
      assert.deepEqual(texts, ["hello from before", "and again"], "the transcript came across whole");
      assert.equal(page.dropped, 0);
      // The old files are left alone: they are somebody's history, and an import
      // is not consent to delete it.
      assert.ok((await fsp.stat(path.join(root, "s-abc123", "events.jsonl"))).size > 0);
    } finally {
      await store.close();
    }

    // A second open imports nothing, because the database already holds a session.
    const again = new SessionStore({ root, onError: () => {} });
    await again.open();
    try {
      assert.equal(again.list().length, 1, "no duplicate on the next boot");
    } finally {
      await again.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a legacy directory that is not a session does not stop the import", async () => {
  const root = tempRoot();
  try {
    await fsp.mkdir(path.join(root, "s-broken"), { recursive: true });
    await fsp.writeFile(path.join(root, "s-broken", "meta.json"), "{ not json", "utf8");
    await fsp.mkdir(path.join(root, "s-empty"), { recursive: true });
    await fsp.mkdir(path.join(root, "s-good"), { recursive: true });
    await fsp.writeFile(path.join(root, "s-good", "meta.json"), legacyMeta(), "utf8");
    // A log whose last line was never finished is not a record, and is not imported.
    await fsp.writeFile(
      path.join(root, "s-good", "events.jsonl"),
      legacyLine(1, "only the complete one") + '{"v":1,"seq":2,"ts":"x","eve',
      "utf8",
    );

    const faults: SessionStoreError[] = [];
    const store = new SessionStore({ root, onError: (e) => faults.push(e) });
    await store.open();
    try {
      assert.equal(store.list().length, 1, "the good session still came across");
      assert.deepEqual(
        (await store.read(store.list()[0]?.storeId ?? "", null)).events.map((e) => e.seq),
        [1],
        "and the torn line was not imported as a record",
      );
      assert.ok(faults.some((f) => f.code === "E_STORE_META_CORRUPT"), "the broken one is reported");
    } finally {
      await store.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("an imported session obeys the caps from then on", async () => {
  // The old meta's byte count described a JSONL file including its newlines and
  // wrapper, so carrying it over would have made the cap wrong in both directions.
  const root = tempRoot();
  try {
    await fsp.mkdir(path.join(root, "s-abc123"), { recursive: true });
    await fsp.writeFile(path.join(root, "s-abc123", "meta.json"), legacyMeta({ bytes: 999_999 }), "utf8");
    await fsp.writeFile(path.join(root, "s-abc123", "events.jsonl"), legacyLine(1, "short"), "utf8");

    const store = new SessionStore({ root, maxSessionBytes: 5_000, onError: () => {} });
    await store.open();
    try {
      const id = store.list()[0]?.storeId ?? "";
      assert.ok((store.meta(id)?.bytes ?? 0) < 5_000, "the byte count is re-measured, not carried over");
      const chunk = "z".repeat(2_000);
      for (let index = 1; index <= 20; index += 1) store.append(id, delta(index, chunk));
      await store.flushMeta(id);
      assert.equal(store.summary(id)?.truncated, true, "so the cap still bites");
    } finally {
      await store.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("an import interrupted half way finishes on the next boot", async () => {
  // Gating the import on the store being empty meant a crash, a full disk, or a
  // kill part-way through left the remaining legacy directories unreachable for
  // ever: no diagnostic, no way back, because the old files are deliberately never
  // deleted. The marker is what tells "never started" from "half finished".
  const root = tempRoot();
  try {
    const write = async (id: string, text: string): Promise<void> => {
      const dir = path.join(root, `s-${id}`);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "meta.json"),
        legacyMeta({ storeId: id, title: text }),
        "utf8",
      );
      await fsp.writeFile(path.join(dir, "events.jsonl"), legacyLine(1, text), "utf8");
    };
    const one = "11111111-1111-4111-8111-111111111111";
    const two = "22222222-2222-4222-8222-222222222222";
    await write(one, "first");
    await write(two, "second");

    // The state a half-finished import leaves: one session in the database, the
    // marker absent, the second directory still on disk.
    const half = new DatabaseSync(path.join(root, DB_NAME));
    half.exec(`CREATE TABLE IF NOT EXISTS sessions (
      store_id TEXT PRIMARY KEY, harness TEXT, harness_session_id TEXT, project_id TEXT,
      project_name TEXT, cwd TEXT, title TEXT, created_at TEXT, updated_at TEXT,
      turn_count INTEGER, first_seq INTEGER, last_seq INTEGER, bytes INTEGER,
      truncated INTEGER, title_source TEXT, ended_mid_turn INTEGER) STRICT`);
    half.exec(`CREATE TABLE IF NOT EXISTS events (
      store_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL,
      bytes INTEGER NOT NULL, PRIMARY KEY (store_id, seq)) WITHOUT ROWID`);
    half.prepare(
      "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      one, "opencode", "ses_legacy", "proj-1", "k5-work", "/home/k5/code/k5-work", "first",
      "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", 1, 1, 1, 100, 0, "prompt", 0,
    );
    half.close();

    const store = new SessionStore({ root, onError: () => {} });
    await store.open();
    try {
      const titles = store.list().map((entry) => entry.title).sort();
      assert.deepEqual(
        titles,
        ["first", "second"],
        "the second task must be reachable, not stranded on disk",
      );
    } finally {
      await store.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- schema version ---

test("a database from a newer build is refused rather than half-read", async () => {
  const root = tempRoot();
  try {
    const seed = new DatabaseSync(path.join(root, DB_NAME));
    seed.exec("PRAGMA user_version = 99");
    seed.close();

    const store = new SessionStore({ root, onError: () => {} });
    await assert.rejects(
      () => store.open(),
      (error: unknown) => error instanceof SessionStoreError && error.code === "E_STORE_ROOT",
      "an unknown future schema is not guessed at",
    );
    // And the handle was released, so the file is not left open behind a refusal.
    const reopened = new DatabaseSync(path.join(root, DB_NAME));
    assert.equal((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 99);
    reopened.close();
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- the defaults still mean something ---

test("the shipped caps hold their documented relationships", () => {
  // A per-session cap above the store cap would make one session's limit
  // unreachable, and a page ceiling above the store cap would make a page
  // unservable.
  assert.ok(MAX_SESSION_BYTES < MAX_STORE_BYTES, "one session cannot outgrow the whole store");
  assert.ok(MAX_LINE_BYTES < MAX_SESSION_BYTES, "one record cannot outgrow a session");
});

// --- search ---

const promptEvent = (seq: number, text: string): ServerEvent => ({
  type: "turn.started",
  sessionId: "ses_live",
  turnId: `t-${seq}`,
  userText: text,
  attachments: [],
});

test("search finds a transcript word and names the message it is in", async () => {
  // The whole feature, in one assertion set: the row comes back, and it says
  // which side said the matched line and where that line sits in the log.
  await withStore(async (store) => {
    const session = await newSession(store, { title: "a task about a zeppelin" });
    store.append(session.storeId, promptEvent(1, "find the docking manifest"));
    store.append(session.storeId, delta(2, "the zeppelin docks at pier four"));
    await store.flushMeta(session.storeId);

    const hits = store.search("zeppelin");
    assert.equal(hits.length, 1, "one session mentions it");
    const [hit] = hits;
    assert.ok(hit, "the hit exists");
    assert.equal(hit.title, "a task about a zeppelin");
    assert.equal(hit.snippets?.length, 1, "one matched line");
    const [snippet] = hit.snippets ?? [];
    assert.equal(snippet?.role, "reply", "it came from the assistant's side");
    assert.equal(snippet?.seq, 2, "and it names the record it came from");
    assert.ok(snippet?.text.includes("the zeppelin docks at pier four"), "with the line itself");
    assert.ok(snippet?.ts.length > 0, "and a timestamp to go with it");
  });
});

test("search matches the prompt as well as the reply", async () => {
  // The title is capped at 200 characters, so a long prompt's tail exists only
  // in the transcript. A search over replies alone would miss it.
  await withStore(async (store) => {
    const session = await newSession(store, { title: `${"z".repeat(200)}-tail` });
    store.append(session.storeId, promptEvent(1, `${"z".repeat(200)} the unreachable tail word`));
    await store.flushMeta(session.storeId);

    const hits = store.search("unreachable");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.snippets?.[0]?.role, "prompt");
    assert.ok(hits[0]?.snippets?.[0]?.text.includes("the unreachable tail word"));
  });
});

test("search caps the snippets and does not spill them between sessions", async () => {
  // Two threads sharing a phrase is the case the snippet exists for, and the cap
  // is what stops a row from becoming a document.
  await withStore(async (store) => {
    const first = await newSession(store, { title: "first thread" });
    const second = await newSession(store, { title: "second thread" });
    for (const session of [first, second]) {
      for (let seq = 1; seq <= 5; seq += 1) {
        store.append(session.storeId, delta(seq, `line ${seq} the same phrase again`));
      }
      await store.flushMeta(session.storeId);
    }

    const hits = store.search("phrase");
    assert.equal(hits.length, 2, "both sessions mention it");
    for (const hit of hits) {
      assert.equal(hit.snippets?.length, 3, "capped at three");
    }
    // Distinct rows, and neither one's snippets are the other's.
    assert.notEqual(hits[0]?.storeId, hits[1]?.storeId);
  });
});

test("search does not treat a query as a pattern", async () => {
  // `%` and `_` are LIKE metacharacters. Unescaped, a query of "%" matches
  // every row in the store and "a_c" matches "abc", and neither is what was
  // asked for. The fixtures below hold the literal characters, so deleting
  // the escape cannot leave these assertions passing on nothing.
  await withStore(async (store) => {
    const literals = await newSession(store, { title: "literals" });
    store.append(literals.storeId, delta(1, "the batch ran at 100% and read a_c whole"));
    const plain = await newSession(store, { title: "plain" });
    store.append(plain.storeId, delta(1, "the batch ran at full and read abc whole"));
    await store.flushMeta(literals.storeId);
    await store.flushMeta(plain.storeId);

    assert.equal(store.search("100%").length, 1, "a percent matches the literal characters");
    assert.equal(store.search("100%")[0]?.storeId, literals.storeId);
    assert.equal(store.search("a_c").length, 1, "and so does an underscore");
    assert.equal(store.search("a_c")[0]?.storeId, literals.storeId);
    assert.equal(store.search("abc").length, 1, "while the plain word still matches");
    assert.equal(store.search("abc")[0]?.storeId, plain.storeId);
    assert.equal(store.search("%").length, 1, "a lone percent is a character, not everything");

    // LIKE's own escape character is the backslash, so a query holding one is a
    // literal rather than the start of an escape sequence.
    const slashy = await newSession(store, { title: "backslashes" });
    store.append(slashy.storeId, delta(1, "the path is C:\\work\\k5"));
    await store.flushMeta(slashy.storeId);
    assert.equal(store.search("C:\\work").length, 1, "a backslash matches literally");
    assert.equal(store.search("\\").length, 1, "including as the whole query");
  });
});

test("search keeps a matched line from the middle of a long message", async () => {
  // The case the whole feature exists for: a long prompt's tail lives only in
  // the transcript. A snippet over SNIPPET_CHARS fails the schema and is
  // dropped, and the row then claims a match with nothing to show, so the
  // window has to be clamped to the cap rather than merely centred.
  await withStore(async (store) => {
    const session = await newSession(store, { title: "a long prompt" });
    const head = "x".repeat(400);
    const tail = "y".repeat(400);
    store.append(session.storeId, promptEvent(1, `${head} docking manifest ${tail}`));
    await store.flushMeta(session.storeId);

    const hit = store.search("docking manifest")[0];
    assert.ok(hit, "the row comes back");
    assert.equal(hit.snippets?.length, 1, "with its matched line");
    const [snippet] = hit.snippets ?? [];
    assert.ok(snippet, "the snippet exists");
    assert.ok(snippet.text.includes("docking manifest"), "and the match is inside it");
    assert.ok(snippet.text.length <= SNIPPET_CHARS, "and the whole snippet fits the cap");
    assert.ok(snippet.text.startsWith("..."), "so it reads as an excerpt of the message");
  });
});

test("search answers from messages, not from tool calls or reasoning", async () => {
  // "Which task read this file" is a different question from "which task was
  // about this", and the second is the one a transcript search is for. A
  // candidate matched only by a tool call's title comes back with no matched
  // line to show, so the candidates are the messages themselves.
  await withStore(async (store) => {
    const session = await newSession(store, { title: "a task about a zeppelin" });
    store.append(session.storeId, promptEvent(1, "find the docking manifest"));
    store.append(session.storeId, {
      type: "tool.updated",
      sessionId: "ses_live",
      turnId: "t-1",
      toolCallId: "call-1",
      title: "read_file zeppelin-blueprints.txt",
      status: "completed",
      lifecycle: "active",
    });
    store.append(session.storeId, {
      type: "turn.delta",
      sessionId: "ses_live",
      turnId: "t-1",
      stream: "thought",
      text: "the zeppelin needs fuel",
    });
    await store.flushMeta(session.storeId);

    assert.equal(store.search("docking manifest").length, 1, "the prompt still matches");
    assert.equal(store.search("read_file").length, 0, "a tool call's title is not a match");
    assert.equal(
      store.search("zeppelin-blueprints").length,
      0,
      "not even the filename inside it",
    );
    assert.equal(store.search("needs fuel").length, 0, "and a reasoning delta is not one");
  });
});

test("search leaves a plain list read alone", async () => {
  // The two reads are the same route and the same response shape. A search
  // result carries snippets and every row carries none.
  await withStore(async (store) => {
    const session = await newSession(store, { title: "one task" });
    store.append(session.storeId, delta(1, "findme"));
    await store.flushMeta(session.storeId);

    for (const row of store.list()) {
      assert.equal(row.snippets, undefined, "a list row has no snippets");
    }
    assert.equal(store.search("findme")[0]?.snippets?.length, 1, "a search row does");
    assert.equal(store.search("   ").length, 0, "a blank search is not a full list");
    assert.equal(store.search("nothing here").length, 0, "and a miss is empty, not everything");
  });
});

test("search reads a long transcript without projecting the whole store", async () => {
  // A store with many sessions where only one matches. The candidate set is
  // narrowed by SQL before any transcript is read, so the answer does not cost
  // every session's records.
  await withStore(async (store) => {
    for (let index = 0; index < 40; index += 1) {
      const session = await newSession(store, { title: `filler ${index}` });
      store.append(session.storeId, delta(1, `nothing to see in ${index}`));
      await store.flushMeta(session.storeId);
    }
    const needle = await newSession(store, { title: "the one that matters" });
    store.append(needle.storeId, delta(1, "the only matching line"));
    await store.flushMeta(needle.storeId);

    const hits = store.search("matching");
    assert.equal(hits.length, 1, "one session matched, not forty");
    assert.equal(hits[0]?.storeId, needle.storeId);
  });
});

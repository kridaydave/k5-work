import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AttachmentManifestEntrySchema,
  MAX_ATTACHMENT_BYTES,
  RECORD_VERSION,
  SessionSummarySchema,
  StoredEventRecordSchema,
  isPersistedEventType,
  MAX_EVENTS_PER_PAGE,
  MAX_LISTED_SESSIONS,
  MAX_SNIPPETS_PER_SESSION,
  SNIPPET_CHARS,
  SessionSnippetSchema,
  type AttachmentKind,
  type AttachmentManifestEntry,
  type IsoTimestamp,
  type ReplayStatus,
  type ServerEvent,
  type SessionEventsResponse,
  type SessionSearchRow,
  type SessionSnippet,
  type SessionSummary,
  type StoredEventRecord,
} from "@k5-work/shared";
import { SessionStoreError, type SessionStoreErrorCode } from "./errors.js";
import { unsafeNameReason } from "./safe-name.js";

// Durable local session store, in one SQLite file.
//
// k5 is the store. The harness is asked to continue a session, never to re-read
// one, so this database is the record of what k5 sent and received and makes no
// claim to be the harness's own history.
//
//   <root>/k5.db   sessions, events and attachment bytes
//
// Three tables. `sessions` is one row per task and carries every field the
// sidebar and continuation need, so a listing is an indexed read rather than a
// directory walk. `events` is the transcript, keyed by (store_id, seq) so a page
// after a cursor is a range scan. `attachments` holds the bytes and the manifest
// that describes them in one row, which is what makes them atomic together.
//
// Why this replaced an append-only JSONL log per session: every hard part of that
// design existed only because a text file cannot be updated in place. A torn final
// record, a summary that lagged its own log, a file that had to be renamed into
// place, a symlink planted where a temp file goes, a whole log read into memory to
// find its last line. A transaction makes each of those unrepresentable rather
// than detected, so the code that repaired them is gone rather than kept.
// `docs/phase4-policy-persistence-decisions.md` records what the store promises;
// this file records only what it does.

/**
 * Tighter than the websocket's 1 MB outbound frame cap, and deliberately so:
 * the store is the last place a payload can be rejected before it is durable, so
 * it gets the tighter bound. A record here is the wire event plus a wrapper, and
 * JSON.stringify expands each control character to six bytes, so the wrapper
 * makes an event near the frame cap exceed this one.
 *
 * An event over the cap is dropped whole rather than truncated, because a
 * truncated payload is permanently unparseable and would poison the record after it.
 */
export const MAX_LINE_BYTES = 256 * 1024;

/** A generous long session. On breach the log stops growing and says so. */
export const MAX_SESSION_BYTES = 12 * 1024 * 1024;

/** Whole-store ceiling, so a runaway agent cannot fill the user's disk. */
export const MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024;

export const MAX_SESSIONS = 500;

/** Ceiling on one HTTP page, by serialised bytes rather than by event count. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

const DB_FILE = "k5.db";
const META_VERSION = 1;
const SESSION_IDLE_EVICT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bumped only by a migration that changes what a row means. `user_version` is
 * SQLite's own slot for this and is read before any table is touched, so an
 * unknown future version is refused instead of half-read.
 */
const SCHEMA_VERSION = 1;

/**
 * How long a write waits for a competing writer before giving up.
 *
 * Generous, because the only realistic competitor is a human running `sqlite3`
 * against the file or a second k5 on the same root, and losing a transcript to
 * one of those is not a trade worth making for a faster refusal.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * SQLite's codes for "someone else is using the file right now", as opposed to
 * something being wrong with the data.
 *
 * These are the two that must never end a session. The old store reopened its
 * file handle and wrote the next record at the same sequence number after a
 * transient failure; a busy store that gave up instead lost every later event of
 * a live turn and still reported the transcript as complete, which is the worst
 * outcome available: silent, unbounded data loss presented as success.
 */
const RETRYABLE_ERRCODES: ReadonlySet<number> = new Set([
  5, // SQLITE_BUSY
  6, // SQLITE_LOCKED
]);

function isRetryable(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    RETRYABLE_ERRCODES.has((cause as { errcode?: unknown }).errcode as number)
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  store_id            TEXT    PRIMARY KEY,
  harness             TEXT    NOT NULL,
  harness_session_id  TEXT    NOT NULL,
  project_id          TEXT    NOT NULL,
  project_name        TEXT,
  cwd                 TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  turn_count          INTEGER NOT NULL,
  first_seq           INTEGER NOT NULL,
  last_seq            INTEGER NOT NULL,
  bytes               INTEGER NOT NULL,
  truncated           INTEGER NOT NULL,
  title_source        TEXT    NOT NULL,
  ended_mid_turn      INTEGER NOT NULL,
  dropped_records     INTEGER NOT NULL DEFAULT 0
) STRICT;

-- The sidebar reads every session newest-first on every load, so the sort key is
-- an index rather than a full scan and a sort.
--
-- updated_at is compared as TEXT and never parsed by SQLite, so a row is only
-- correctly ordered if every stamp in the column has the same fixed width. Both
-- writers normalise through isoStamp, so a harness answering session_info_update
-- with "Feb 1 2026" cannot park a live task at the top of the sidebar forever. A
-- stamp written before that normalisation existed is still possible, which is what
-- normaliseStamps repairs at boot rather than leaving a session ordered wrongly
-- for the life of the file.
--
-- No backticks in this block. The whole schema is one template literal, so a
-- backtick in a SQL comment closes the string early and the file stops parsing.
--
-- store_id is the only tiebreak, and deliberately not the record count. Two tasks
-- written in the same millisecond are not ordered by anything we know; breaking
-- the tie on how many records a task happens to hold put a long old task above a
-- short new one, which is the opposite of what the column claims. An arbitrary but
-- stable order is honest here. A millisecond is not a tie in practice, and when it
-- is, nothing downstream depends on which of the two comes first.
CREATE INDEX IF NOT EXISTS sessions_by_recency
  ON sessions (updated_at DESC, store_id DESC);

-- The events table. Its bytes column is the record's own accounted size, written
-- once by the append that created the row. It exists so there is exactly one
-- number describing how much a session holds: the cap is checked against it on
-- every append, and re-measured from it at boot and during reconciliation.
-- Deriving it from LENGTH(payload) at read time instead meant the append path and
-- the boot path counted different things, so the total shrank by the difference on
-- every restart.
CREATE TABLE IF NOT EXISTS events (
  store_id  TEXT    NOT NULL REFERENCES sessions (store_id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  ts        TEXT    NOT NULL,
  payload   TEXT    NOT NULL,
  bytes     INTEGER NOT NULL,
  PRIMARY KEY (store_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS attachments (
  store_id       TEXT    NOT NULL REFERENCES sessions (store_id) ON DELETE CASCADE,
  attachment_id  TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  mime_type      TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  size           INTEGER NOT NULL,
  manifest_bytes INTEGER NOT NULL,
  body           BLOB    NOT NULL,
  PRIMARY KEY (store_id, attachment_id)
) WITHOUT ROWID;

-- One row per one-off thing this store has finished doing to itself. It exists so
-- a step that must not repeat, and must resume if it was interrupted, has
-- somewhere to say so. A step that derives its own state from the data cannot tell
-- "never started" from "half finished", and guessing wrong in one direction
-- repeats work that is not idempotent while guessing wrong in the other skips it
-- for ever.
CREATE TABLE IF NOT EXISTS store_flags (
  flag   TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT, WITHOUT ROWID;
`;

/**
 * Zod rather than a bag of `String()` and `Number()` coercions. SQLite is
 * dynamically typed, so `turn_count` can hold a string or a float, and a NaN
 * turnCount in one row made list() throw a raw ZodError, which 500'd the whole
 * session list for every session, while a NaN byte count silently disabled that
 * session's quota.
 */
const MetaFileSchema = z
  .object({
    v: z.literal(META_VERSION),
    storeId: z.string().min(1).max(64),
    harness: z.string().min(1).max(64),
    harnessSessionId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256),
    projectName: z.string().min(1).max(200).nullable(),
    cwd: z.string().min(1).max(4096),
    title: z.string().min(1).max(200),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
    turnCount: z.number().int().nonnegative(),
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    /**
     * Records this store refused to keep in a way that left no gap behind.
     * Persisted, because the loss is permanent. A row that quietly lost a turn
     * has to keep admitting it across restarts instead of reporting itself whole
     * again once the process that dropped the record is gone.
     */
    droppedRecords: z.number().int().nonnegative(),
    // A flag, not a sentinel value. Comparing against the placeholder string
    // meant a first prompt of literally "Untitled task", or any harness title
    // that sanitised to the placeholder, re-armed the fallback and let turn two
    // silently rename the session.
    titleSource: z.enum(["none", "prompt", "harness"]),
    /**
     * True when a boot found a transcript whose last turn never reached a
     * terminal event. Best-effort, not a guarantee: nothing runs on SIGKILL, so
     * a hard kill can still leave one that ends mid-turn.
     */
    endedMidTurn: z.boolean(),
  })
  .strict()
  .refine((meta) => Number.isFinite(Date.parse(meta.updatedAt)), {
    message: "updatedAt is not a parseable timestamp",
  })
  .refine((meta) => Number.isFinite(Date.parse(meta.createdAt)), {
    message: "createdAt is not a parseable timestamp",
  });

/**
 * The row as it comes out of SQLite, where every column is nullable-typed and
 * booleans are integers. Parsed through the same schema the file format used, so
 * a row that drifted is refused on read rather than rendered as a blank card.
 */
type MetaRow = Record<string, unknown>;
type MetaFile = z.infer<typeof MetaFileSchema>;

export interface CreateSessionInput {
  readonly harness: string;
  readonly harnessSessionId: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly cwd: string;
  readonly title?: string;
}

export interface SessionStoreOptions {
  readonly root: string;
  readonly now?: () => number;
  readonly maxSessions?: number;
  readonly maxSessionBytes?: number;
  readonly maxStoreBytes?: number;
  readonly idleEvictMs?: number;
  /** Reports a store fault without letting it become an unhandled rejection. */
  readonly onError?: (error: SessionStoreError) => void;
}

function nowIso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString();
}

/**
 * A harness-supplied timestamp as the one shape every comparator on it assumes,
 * or null when it is not a real time.
 *
 * This exists because `Date.parse` accepting a string does not make that string
 * sortable. `updated_at` is TEXT, the sidebar sorts on it, the recency index is
 * built on it, and age eviction parses it, so the value has to be a fixed-width
 * ISO stamp or the three of them disagree about which session is newest.
 */
function isoStamp(raw: string | null | undefined): IsoTimestamp | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The longest a title may be, in UTF-16 code units.
 *
 * This is the number the schemas enforce. `z.string().max(200)` counts code units,
 * because that is what a JavaScript string's length is, and every bound a title
 * has to satisfy downstream is written that way. It is deliberately not a count of
 * characters or of graphemes, because those are three different numbers and
 * picking the wrong one here produced a row the store could not read back.
 */
export const TITLE_MAX_UNITS = 200;

/** Kept in step with the bound above, with room for the ellipsis. */
const TITLE_MAX_GRAPHEMES = 120;

/**
 * The last line of defence for a title, and the reason `sanitizeTitle` is not
 * trusted on its own.
 *
 * A row that fails `MetaFileSchema` cannot be read back by this store at all, and
 * that is unrecoverable rather than merely ugly: `meta` returns null, so `append`
 * silently drops every later event of a live turn, and `read` refuses the session
 * outright while its events sit on disk unreachable. Validating here means a title
 * that would do that is shortened instead of stored.
 */
function titleWithinSchema(raw: string): string {
  const candidate = sanitizeTitle(raw);
  if (candidate.length <= TITLE_MAX_UNITS) return candidate;
  // Reached only if the segmenter took a grapheme the budget could not hold, which
  // `sanitizeTitle` already guards. Cut on a grapheme boundary rather than
  // mid-surrogate, and give up the placeholder if even one grapheme will not fit.
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  let out = "";
  for (const { segment } of segmenter.segment(candidate)) {
    if (out.length + segment.length > TITLE_MAX_UNITS) break;
    out += segment;
  }
  return out.length === 0 ? "Untitled task" : out;
}

/**
 * Strips control characters and bidi overrides, collapses whitespace, then cuts on
 * a grapheme boundary so a surrogate pair is never split into mojibake.
 *
 * The budget is in code units, not graphemes. Cutting at 120 graphemes admits 480
 * code units of emoji, which is past the 200 every title is validated against, and
 * the result was a row the store wrote and then could not read: `setTitle` stored
 * it without complaint, `summary` returned null, and every later append was
 * dropped because the session had become unreadable. One emoji in a prompt was
 * enough to lose a whole recorded transcript.
 */
export function sanitizeTitle(raw: string, maxGraphemes = TITLE_MAX_GRAPHEMES): string {
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (stripped.length === 0) return "Untitled task";
  if (stripped.length <= maxGraphemes) return stripped;
  // The shorter of the two budgets wins, so the result satisfies the schema
  // whichever one binds first. The grapheme count keeps a run of emoji from being
  // cut down to a handful of characters, and the unit count is what keeps the
  // result inside the contract. `out.length` is what is capped, not a count of
  // graphemes: a title is validated in code units everywhere downstream, so this
  // function must stay inside that budget or the row it lands in cannot be read
  // back.
  const budget = Math.min(maxGraphemes, TITLE_MAX_UNITS - 1);
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  let out = "";
  for (const { segment } of segmenter.segment(stripped)) {
    // Both budgets are checked before appending, so a segment is never half-taken.
    if (out.length + segment.length > budget) break;
    out += segment;
  }
  // A single grapheme can be longer than the whole budget in theory, so the loop
  // above can take nothing at all. Falling back to a hard cut here would be the
  // surrogate-splitting bug this function exists to prevent, so the placeholder
  // is used instead: short, valid, and honest about having nothing to show.
  if (out.length === 0) return "Untitled task";
  return `${out.replace(/[\s.]+$/u, "")}…`;
}

/**
 * Decides an attachment's kind from the bytes, not from the declared mime.
 *
 * A clean UTF-8 decode is text, because that is the only case where inlining the
 * content as text is lossless. Everything else is binary, and an image is called
 * an image so the browser can show it as one.
 */
function classifyAttachment(bytes: Buffer, mimeType: string): AttachmentKind {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return mimeType.trim().toLowerCase().startsWith("image/") ? "image" : "binary";
  }
  return "text";
}

/** SQLite hands back null-prototype objects; named getters read them field by field. */
function asText(row: MetaRow, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

/**
 * Escapes `%` and `_` so a `LIKE` pattern matches them literally.
 *
 * Without this, a query containing either character is a pattern rather than a
 * search, and "50%" matches every row in the store.
 */
function escapeLike(needle: string): string {
  return needle.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Cuts a matched line to at most `max` characters, centred on the match.
 *
 * An ellipsis at either cut, so a snippet never looks like the whole message.
 * A line short enough that the match is already inside the window is returned
 * unchanged, including when it is shorter than `max`.
 *
 * The window keeps six characters back for the two ellipses, so the result is
 * never over `max` no matter where the match sits. Getting this wrong was
 * silent: an over-long snippet failed the schema and was dropped, so the row
 * came back with no matched line at all, which is the exact case a long
 * prompt's tail lives in.
 */
function trimAround(text: string, wanted: string, max: number): string {
  const at = text.toLowerCase().indexOf(wanted);
  if (at < 0) return text.slice(0, max);
  if (text.length <= max) return text;
  const room = max - 6;
  const lead = Math.max(0, Math.floor((room - wanted.length) / 2));
  let start = at - lead;
  start = Math.max(0, Math.min(start, text.length - room));
  const end = start + room;
  const head = start > 0 ? "..." : "";
  const tail = end < text.length ? "..." : "";
  return `${head}${text.slice(start, end)}${tail}`;
}

function asInt(row: MetaRow, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" ? value : Number.NaN;
}

function asFlag(row: MetaRow, column: string): boolean {
  return asInt(row, column) !== 0;
}

const SESSION_COLUMNS =
  "store_id, harness, harness_session_id, project_id, project_name, cwd, title, " +
  "created_at, updated_at, turn_count, first_seq, last_seq, bytes, truncated, title_source, " +
  "ended_mid_turn, dropped_records";

/**
 * One row to the shape the rest of the server uses, or null when the row is not
 * usable. Refusing one bad row here is what keeps a single corrupt session from
 * taking down the whole list, which is what the old per-file parse did too.
 */
function rowToMeta(row: MetaRow): MetaFile | null {
  const storeId = asText(row, "store_id");
  if (storeId === null) return null;
  const result = MetaFileSchema.safeParse({
    v: META_VERSION,
    storeId,
    harness: asText(row, "harness") ?? "",
    harnessSessionId: asText(row, "harness_session_id") ?? "",
    projectId: asText(row, "project_id") ?? "",
    projectName: asText(row, "project_name"),
    cwd: asText(row, "cwd") ?? "",
    title: asText(row, "title") ?? "",
    createdAt: asText(row, "created_at") ?? "",
    updatedAt: asText(row, "updated_at") ?? "",
    turnCount: asInt(row, "turn_count"),
    firstSeq: asInt(row, "first_seq"),
    lastSeq: asInt(row, "last_seq"),
    bytes: asInt(row, "bytes"),
    truncated: asFlag(row, "truncated"),
    titleSource: asText(row, "title_source") ?? "none",
    endedMidTurn: asFlag(row, "ended_mid_turn"),
    droppedRecords: asInt(row, "dropped_records"),
  });
  return result.success ? result.data : null;
}

export class SessionStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxSessionBytes: number;
  private readonly maxStoreBytes: number;
  private readonly idleEvictMs: number;
  private readonly onError: (error: SessionStoreError) => void;
  private db: DatabaseSync | null = null;
  private ready = false;
  /**
   * Sessions whose writer has stopped. A stop is permanent, because a hole in
   * the sequence can never be filled in place, so this is the whole per-session
   * write state the old log needed a file handle and a queue to hold.
   */
  private readonly stopped = new Set<string>();
  /**
   * Records the store failed to keep, per session, for records that left no other
   * trace. A rolled-back write leaves no gap, so a reader comparing sequences sees
   * a contiguous log and concludes nothing is missing. This is the only place that
   * loss is counted.
   */
  private readonly storeDrifted = new Map<string, number>();
  /**
   * Sessions this process has appended to recently, and eviction therefore skips.
   *
   * Bounded, and that is the whole point. The old store got this for free from an
   * open file handle, which was released with the seat. Here nothing releases it, so
   * an unbounded set pins every session the process has ever written to: at the cap
   * eviction walks the list, skips everything as live, deletes nothing, and every
   * later create fails for the rest of the process. Keyed by last write, oldest
   * first, so the pin is a recency window rather than a permanent mark.
   *
   * Sized to the session cap, which is far more pins than there can be live seats.
   */
  private readonly live = new Map<string, number>();
  private storeBytes = 0;

  constructor(options: SessionStoreOptions) {
    this.root = path.resolve(options.root);
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.maxSessionBytes = options.maxSessionBytes ?? MAX_SESSION_BYTES;
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_STORE_BYTES;
    this.idleEvictMs = options.idleEvictMs ?? SESSION_IDLE_EVICT_MS;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * The single reporting path. A caller-supplied reporter that throws would
   * otherwise turn the store's central safety claim into its opposite: append()
   * would throw synchronously into the synchronous emit path, taking every live
   * harness child down with it.
   */
  private report(code: SessionStoreErrorCode, message: string): void {
    try {
      this.onError(new SessionStoreError(code, message));
    } catch {
      // A broken reporter is not allowed to become a store failure.
    }
  }

  private handle(): DatabaseSync {
    const db = this.db;
    if (db === null) {
      throw new SessionStoreError("E_STORE_WRITABLE", "the session store is not open");
    }
    return db;
  }

  private assertOpen(): void {
    if (this.db === null) {
      throw new SessionStoreError("E_STORE_WRITABLE", "the session store is not open");
    }
  }

  /**
   * Opens the database, migrates a pre-SQLite store if one is sitting there, and
   * reconciles each session against its own events.
   *
   * Called from the server entry point, never at module scope, because
   * module-graph.test.ts imports every compiled module and a database opened at
   * import time is a side effect in a test.
   */
  async open(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    // mkdir honours the umask, so an already-wider directory stays readable by
    // other local users. Transcripts are agent output: source, and whatever the
    // agent read. Tighten it explicitly.
    await fsp.chmod(this.root, 0o700).catch(() => {});
    // A second process, or a `sqlite3` shell, or a backup tool, can hold the
    // write lock. Without a timeout SQLite's busy handler is off, so the very
    // first collision is an instant SQLITE_BUSY rather than a wait, and a
    // one-millisecond lock is enough to lose a record.
    const db = new DatabaseSync(path.join(this.root, DB_FILE), { timeout: BUSY_TIMEOUT_MS });
    this.db = db;
    try {
      // WAL so a reader never blocks the writer, which matters because /api/sessions
      // reads on every sidebar load while turns are being appended.
      db.exec("PRAGMA journal_mode = WAL");
      // NORMAL, not FULL. In WAL mode this still fsyncs at checkpoints and on a
      // clean close, and a power loss can lose only the last commits, never the
      // database. FULL fsyncs every commit, which buys durability the append path
      // never had (the old log was not fsynced per record either) at roughly a
      // third of the throughput on a page fault.
      db.exec("PRAGMA synchronous = NORMAL");
      // Off by default in SQLite. The cascade is what makes remove() and evict()
      // take a session's events and attachments with it in one statement, rather
      // than leaving rows that outlive the session they describe.
      db.exec("PRAGMA foreign_keys = ON");
      // SQLite creates its files 0644, honouring only the umask, and it creates
      // the -wal and -shm sidecars with the same mode as the database when they do
      // not exist yet. Transcripts are agent output: source, and whatever the
      // agent read. The 0700 root is the real boundary; this is the second one,
      // and it has to be applied to all three files because a sidecar created
      // later takes its mode from the database file.
      for (const name of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
        await fsp.chmod(path.join(this.root, name), 0o600).catch(() => {});
      }
      const version = db.prepare("PRAGMA user_version").get() as MetaRow | undefined;
      const found = version === undefined ? 0 : asInt(version, "user_version");
      if (found > SCHEMA_VERSION) {
        throw new SessionStoreError(
          "E_STORE_ROOT",
          `k5.db is at schema version ${found}, which this build does not understand`,
        );
      }
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
      this.addMissingColumns();
    } catch (cause) {
      this.db = null;
      db.close();
      throw cause instanceof SessionStoreError
        ? cause
        : new SessionStoreError("E_STORE_ROOT", `could not open the session store: ${String(cause)}`);
    }
    try {
      await this.importLegacyJsonl();
      // Reconcile first, then measure. Reconcile rewrites `sessions.bytes` from the
      // events, so measuring first left the counter holding the pre-repair totals for
      // the rest of the process. The same drift in the other direction is a store
      // that refuses every write while sitting nearly empty.
      this.reconcile();
      // After the import, not before: a legacy row carries whatever timestamp the old
      // file held, and it lands in the table unsorted. Repairing first would leave
      // every imported session mis-ordered until the next boot.
      this.normaliseStamps();
      this.chargeStoreBytes();
    } catch (cause) {
      this.db = null;
      db.close();
      throw cause instanceof SessionStoreError
        ? cause
        : new SessionStoreError("E_STORE_ROOT", `could not open the session store: ${String(cause)}`);
    }
    this.ready = true;
  }

  /**
   * The store's byte total, measured from the rows rather than from a counter a
   * crash could leave behind.
   *
   * One full scan of the events table, which is linear in the size of the store.
   * It runs at boot only, never on a request, and the alternative, subtracting
   * each session's own `bytes` as it is deleted, is what the delete path does.
   */
  private chargeStoreBytes(): void {
    const db = this.handle();
    // The same two numbers the append path accumulates, taken from the rows that
    // hold them. Measuring the events table directly instead would count the
    // stored payload while the append path counts the payload plus its wrapper,
    // so the store total would shrink by the difference on every restart and the
    // cap would mean a different thing depending on when you asked.
    const events = db
      .prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM sessions")
      .get() as MetaRow;
    const spooled = db
      .prepare(
        "SELECT COALESCE(SUM(size + manifest_bytes), 0) AS total FROM attachments",
      )
      .get() as MetaRow;
    this.storeBytes = asInt(events, "total") + asInt(spooled, "total");
  }

  /**
   * Adds any column this build needs to a table that an older one created without
   * it.
   *
   * `SCHEMA` is all `CREATE TABLE IF NOT EXISTS`, which creates a missing table but
   * never adds a column to one that already exists. So a `k5.db` written by the
   * previous build keeps its old shape, and every query naming the new column
   * throws `no such column` inside `list()`, `append()` and `evict()`. The throw
   * matters most in `append`, which is documented as never throwing and runs on a
   * synchronous emit path: it becomes an unhandled rejection that takes the
   * harness children down with it. That is a worse outcome than an old file being
   * slightly behind.
   *
   * Idempotent, because a column that is already there is skipped, which is what
   * lets `SCHEMA_VERSION` stay put: the version guards what a row *means*, and an
   * additive defaulted column does not change that. The rule at its declaration
   * assumed a migration path existed, and this is it.
   */
  private addMissingColumns(): void {
    const db = this.handle();
    const present = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as MetaRow[]).flatMap((row) => {
        const name = asText(row, "name");
        return name === null ? [] : [name];
      }),
    );
    if (present.size === 0) return;
    if (!present.has("dropped_records")) {
      db.exec("ALTER TABLE sessions ADD COLUMN dropped_records INTEGER NOT NULL DEFAULT 0");
    }
  }

  /**
   * Rewrites any `updated_at` that is not already a fixed-width ISO stamp.
   *
   * `create` and `setTitle` both normalise, so new rows are fine. This is for the
   * rows written before that was true: the harness's date string was stored as it
   * arrived, and the sidebar orders on it as TEXT, so one session carrying
   * "Feb 1 2026" sat above every ISO row forever and one carrying "1 Jan 2020"
   * read as the oldest task in the store. Age eviction deletes on that order, so
   * this is a data repair and not cosmetics.
   *
   * Never fatal to boot: the read and each row are guarded separately, and a row
   * that cannot be rewritten is reported and skipped, exactly as a session that
   * cannot be reconciled is.
   */
  private normaliseStamps(): void {
    let rows: MetaRow[];
    try {
      rows = this.handle()
        .prepare("SELECT store_id AS store_id, updated_at AS updated_at FROM sessions")
        .all() as MetaRow[];
    } catch (cause) {
      // Never fatal to boot, as the comment above promises. A store whose rows
      // cannot be listed is a store whose timestamps cannot be repaired, which is
      // strictly less bad than refusing to start at all.
      this.report("E_STORE_ROOT", `could not read timestamps to normalise: ${String(cause)}`);
      return;
    }
    for (const row of rows) {
      const storeId = asText(row, "store_id");
      if (storeId === null) continue;
      const current = asText(row, "updated_at");
      if (current === null) continue;
      const stamp = isoStamp(current);
      // Already fixed-width ISO, so there is nothing to gain from rewriting the
      // row on every boot. Skipping it also keeps an unparseable stamp out of the
      // log: it is not this repair's job to decide what it meant.
      if (stamp === null || stamp === current) continue;
      try {
        this.handle()
          .prepare("UPDATE sessions SET updated_at = ? WHERE store_id = ?")
          .run(stamp, storeId);
        this.report(
          "E_STORE_WRITABLE",
          `normalised the timestamp of ${storeId} from ${JSON.stringify(current)} to ${stamp}`,
        );
      } catch (cause) {
        this.report(
          "E_STORE_WRITABLE",
          `could not normalise the timestamp of ${storeId}: ${String(cause)}`,
        );
      }
    }
  }

  /**
   * Brings every session row back into agreement with its own events.
   *
   * This is the one repair the database still needs, and it survives here for a
   * reason that has nothing to do with text files: `endedMidTurn` is a fact about
   * the last event, and nothing recomputes it as turns are appended. A summary
   * that lags its events is not trusted; the events win.
   */
  private reconcile(): void {
    const db = this.handle();
    const rows = db
      .prepare(
        `SELECT s.store_id AS store_id, s.first_seq AS first_seq, s.last_seq AS last_seq,
                (SELECT MIN(seq) FROM events e WHERE e.store_id = s.store_id) AS min_seq,
                (SELECT MAX(seq) FROM events e WHERE e.store_id = s.store_id) AS max_seq,
                (SELECT payload FROM events e WHERE e.store_id = s.store_id
                  ORDER BY seq DESC LIMIT 1) AS tail
           FROM sessions s`,
      )
      .all() as MetaRow[];
    for (const row of rows) {
      const storeId = asText(row, "store_id");
      if (storeId === null) continue;
      try {
        this.reconcileOne(row, storeId);
      } catch (cause) {
        // Per session, not per store. One row that cannot be repaired costs that
        // session its repair, never the process its boot: the old store caught
        // here too, and a single unwritable row turning into `exit(1)` is how a
        // read-only disk became a server that would not start.
        this.report(
          "E_STORE_WRITABLE",
          `could not reconcile ${storeId}: ${String(cause)}`,
        );
      }
    }
  }

  /** Brings one session row back into agreement with its own events. */
  private reconcileOne(row: MetaRow, storeId: string): void {
    const db = this.handle();
    const claimedLast = asInt(row, "last_seq");
    const claimedFirst = asInt(row, "first_seq");
    const minSeq = row["min_seq"] === null ? null : asInt(row, "min_seq");
    const maxSeq = row["max_seq"] === null ? null : asInt(row, "max_seq");
    // A row that claims records and holds none is repaired to hold none, not left
    // claiming them. The import can produce exactly this from a legacy session
    // whose meta was written and whose log never was, and a summary that promises
    // 400 records the store does not have makes every read of that task fail for
    // ever with no repair path.
    if ((maxSeq === null && claimedLast > 0) || (minSeq === null && claimedFirst > 0)) {
      this.report(
        "E_STORE_CORRUPT_LOG",
        `session ${storeId} claims ${String(claimedLast)} record(s) and holds none`,
      );
      // Truncated, because the repair makes the row honest about holding nothing
      // and "honest about nothing" is not the same as "complete". Left false, a
      // task that lost 400 records reads as a caught-up, empty, undamaged
      // transcript, which is the one answer a user cannot act on.
      this.writeReconciled(storeId, 0, 0, false, true);
      return;
    }
    let changed = false;
    if (maxSeq !== null && maxSeq !== claimedLast) {
      this.report(
        "E_STORE_CORRUPT_LOG",
        `stored meta for ${storeId} claimed ${String(claimedLast)} records but the log holds ${String(maxSeq)}`,
      );
      changed = true;
    }
    if (minSeq !== null && minSeq !== claimedFirst) {
      // The lowest sequence actually stored, not the highest. `firstSeq` is what
      // a reader starts from, so a stale value here silently hides the opening
      // of the conversation.
      this.report(
        "E_STORE_CORRUPT_LOG",
        `stored meta for ${storeId} claimed records from ${String(claimedFirst)} but the log begins at ${String(minSeq)}`,
      );
      changed = true;
    }
    const openTurn = endsMidTurn(asText(row, "tail"));
    if (openTurn) {
      this.report(
        "E_STORE_CORRUPT_LOG",
        `session ${storeId} ended mid-turn, most likely an unclean shutdown; its transcript is a prefix`,
      );
      changed = true;
    }
    if (!changed) return;
    this.writeReconciled(
      storeId,
      minSeq ?? claimedFirst,
      maxSeq ?? claimedLast,
      openTurn,
    );
  }

  /**
   * Writes back a reconciled summary, with the byte total re-measured from the
   * events rather than trusted: the old meta carried the size of a JSONL file and
   * this row carries the size of the events alone, so the two cannot be added.
   */
  private writeReconciled(
    storeId: string,
    firstSeq: number,
    lastSeq: number,
    openTurn: boolean,
    /** Force the prefix flag, for the repair that discards records the row claimed. */
    forceTruncated = false,
  ): void {
    this.handle()
      .prepare(
        `UPDATE sessions
            SET first_seq = ?, last_seq = ?,
                bytes = (SELECT COALESCE(SUM(bytes), 0) FROM events WHERE store_id = ?),
                truncated = CASE WHEN ? = 1 THEN 1 ELSE truncated END,
                ended_mid_turn = ?
          WHERE store_id = ?`,
      )
      // Placeholders, in order: firstSeq, lastSeq, the subquery's store id, the
      // prefix flag, the mid-turn flag, and the row being written.
      .run(firstSeq, lastSeq, storeId, forceTruncated || openTurn ? 1 : 0, openTurn ? 1 : 0, storeId);
  }

  /**
   * Retention, not just a cap. A cap with no eviction is a one-way door: the
   * user hits the ceiling and can only recover by editing ~/.local/share by
   * hand, which is not a reverse state.
   *
   * The overflow is computed once, before the loop. Reading the live count inside
   * the loop meant each deletion shrank the bound and the loop stopped one
   * session short, after which every create() failed with no way out.
   *
   * Age is checked first and the cap second, so a workspace that is merely large
   * keeps its recent work: nothing is pruned for being old until it is also
   * something the cap can do without. Once the cap is reached the oldest goes
   * regardless, because refusing every new session for ever is the same dead end
   * from the other direction.
   *
   * The age rule is the one part of this that a boot used to run on its own. It no
   * longer does, so a workspace nobody starts new work in keeps its transcripts
   * indefinitely. That is deliberate: pruning somebody's history during a boot
   * they did not ask for is a worse surprise than a store that has to be used
   * before it tidies up, and the cap still bounds the disk either way.
   */
  private evict(): number {
    const db = this.handle();
    const nowMs = this.now();
    const rows = db
      .prepare("SELECT store_id FROM sessions ORDER BY updated_at ASC, store_id ASC")
      .all() as MetaRow[];
    let removed = 0;
    let remaining = rows.length;
    for (const row of rows) {
      const storeId = asText(row, "store_id");
      if (storeId === null) continue;
      const meta = this.meta(storeId);
      // A row this build cannot read is still occupying a slot, so it is never
      // counted as absent. It is also the only row nothing else can reclaim:
      // list() skips it, read() refuses it, and append() drops every event for
      // it, so no user path deletes it either.
      //
      // Decrementing `remaining` and skipping it was the opposite of what it
      // claimed. The loop believed it had made room, stopped, and pruned
      // nothing, so the store sat at its cap refusing every create for the rest
      // of the process with a full row no user action could free.
      const unreadable = meta === null;
      const idle = unreadable ? Number.POSITIVE_INFINITY : nowMs - Date.parse(meta.updatedAt);
      const needRoom = remaining >= this.maxSessions;
      // Under the cap it is kept, so an unreadable row never costs the user a
      // readable session. At the cap it is the first thing that goes.
      if (unreadable && !needRoom) continue;
      if (!needRoom && idle <= this.idleEvictMs) break;
      // A live seat is never evicted out from under itself: the appends it is
      // still making would land in a session that no longer exists.
      //
      // Before the count, not after. A skipped row still occupies a slot, so
      // decrementing for one made the loop believe it had made room when it had
      // deleted nothing, and it stopped one row early. A store at its cap whose
      // oldest session was the live one then refused every create for the rest of
      // the process, with no way out but deleting a session by hand.
      if (this.live.has(storeId)) continue;
      remaining -= 1;
      const reason = needRoom
        ? "session-cap"
        : `idle for ${String(Math.round(idle / 86_400_000))}d`;
      this.deleteRows(storeId);
      removed += 1;
      // Reported, because this deletes a user's whole transcript. Silently
      // pruning a session list looks identical to losing work.
      this.report("E_STORE_EVICTED", `pruned stored session ${storeId} (${reason})`);
    }
    return removed;
  }

  /**
   * Marks a session as being written to, dropping the least recently written pin
   * once there are more than the cap could ever need.
   */
  private pinLive(storeId: string): void {
    this.live.delete(storeId);
    this.live.set(storeId, this.now());
    while (this.live.size > this.maxSessions) {
      const oldest = this.live.keys().next();
      if (oldest.done === true) break;
      this.live.delete(oldest.value);
    }
  }

  /**
   * Deletes a session and everything the cascade hangs off it, in one statement.
   *
   * The budget is adjusted by what this session actually held, for the same reason
   * remove() does it that way: re-measuring the whole store on every eviction is a
   * full scan, and a cap that only ever grows is a cap that eventually refuses
   * every write in a store that is mostly empty.
   */
  private deleteRows(storeId: string): void {
    const held = this.handle()
      .prepare(
        `SELECT s.bytes AS bytes,
                COALESCE((SELECT SUM(a.size + a.manifest_bytes) FROM attachments a
                           WHERE a.store_id = s.store_id), 0) AS spooled
           FROM sessions s WHERE s.store_id = ?`,
      )
      .get(storeId) as MetaRow | undefined;
    this.handle().prepare("DELETE FROM sessions WHERE store_id = ?").run(storeId);
    if (held !== undefined) {
      this.storeBytes = Math.max(0, this.storeBytes - asInt(held, "bytes") - asInt(held, "spooled"));
    }
    this.stopped.delete(storeId);
    this.live.delete(storeId);
  }

  /**
   * Async because the caller is told the session exists only once the row is
   * durable. A fire-and-forget create lost the session to an immediate rescan, a
   * crash, or a second process, leaving a record the store had forgotten.
   */
  async create(input: CreateSessionInput): Promise<SessionSummary> {
    this.assertOpen();
    this.evict();
    const count = this.count();
    if (count >= this.maxSessions) {
      throw new SessionStoreError(
        "E_STORE_QUOTA",
        `the session store holds its maximum of ${this.maxSessions} sessions, and every one of them is being written to`,
      );
    }
    const nowMs = this.now();
    const meta: MetaFile = {
      v: META_VERSION,
      storeId: randomUUID(),
      harness: input.harness,
      harnessSessionId: input.harnessSessionId,
      projectId: input.projectId,
      projectName: input.projectName,
      cwd: input.cwd,
      title: titleWithinSchema(input.title ?? ""),
      createdAt: nowIso(nowMs),
      updatedAt: nowIso(nowMs),
      turnCount: 0,
      firstSeq: 0,
      lastSeq: 0,
      bytes: 0,
      truncated: false,
      titleSource: input.title === undefined ? "none" : "prompt",
      endedMidTurn: false,
      droppedRecords: 0,
    };
    // Validated before the write, not after. Building the row by assertion and
    // letting the INSERT land meant a value the schema refused was already durable
    // by the time `toSummary` threw: the caller got a raw ZodError instead of a
    // typed one, and never learned the store id, so the row was an orphan nothing
    // could list, select or remove.
    const row = MetaFileSchema.safeParse(meta);
    if (!row.success) {
      throw new SessionStoreError(
        "E_STORE_WRITABLE",
        `refusing a session row that could not be read back: ${row.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    const db = this.handle();
    try {
      db.prepare(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        meta.storeId,
        meta.harness,
        meta.harnessSessionId,
        meta.projectId,
        meta.projectName,
        meta.cwd,
        meta.title,
        meta.createdAt,
        meta.updatedAt,
        meta.turnCount,
        meta.firstSeq,
        meta.lastSeq,
        meta.bytes,
        0,
        meta.titleSource,
        0,
        0,
      );
    } catch (cause) {
      // Refused rather than reported into existence: a summary for a session
      // that cannot be written is a session the user will never find again.
      throw new SessionStoreError("E_STORE_WRITABLE", `could not create the session: ${String(cause)}`);
    }
    return this.toSummary(meta);
  }

  private count(): number {
    const row = this.handle().prepare("SELECT COUNT(*) AS total FROM sessions").get() as MetaRow;
    return asInt(row, "total");
  }

  /**
   * Appends one event. Never throws: the emit path in session-service.ts is
   * synchronous, so an exception here becomes an unhandled error and takes every
   * live harness child with it.
   *
   * The event and the session row move in one transaction, so the sequence
   * counter cannot advance past a record that was not written, and a reader
   * between two appends sees a consistent cursor. The old log needed a queued
   * writer and a rollback for exactly this.
   */
  append(storeId: string, event: ServerEvent): void {
    if (!this.ready || this.db === null) return;
    if (!isPersistedEventType(event.type)) return;
    // A write for an unknown id is dropped, never re-created: a defensive
    // recreate would resurrect a session the user just deleted.
    const meta = this.meta(storeId);
    if (meta === undefined || meta === null) return;
    if (this.stopped.has(storeId)) return;
    this.pinLive(storeId);

    let payload: string;
    let line: string;
    try {
      const validated = StoredEventRecordSchema.parse({
        v: RECORD_VERSION,
        seq: meta.lastSeq + 1,
        ts: nowIso(this.now()),
        event,
      });
      line = JSON.stringify(validated);
      payload = JSON.stringify(validated.event);
    } catch (cause) {
      this.noteDropped(
        storeId,
        `refused an unrecordable event for ${storeId}: ${String(cause)}`,
      );
      return;
    }

    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_LINE_BYTES) {
      this.noteDropped(
        storeId,
        `dropped a ${String(bytes)}-byte record of ${storeId} over the ${String(MAX_LINE_BYTES)}-byte cap`,
      );
      return;
    }
    if (meta.bytes + bytes > this.maxSessionBytes) {
      this.markTruncated(
        storeId,
        `session ${storeId} reached its ${String(this.maxSessionBytes)}-byte cap; the transcript is now a prefix`,
      );
      return;
    }
    if (this.storeBytes + bytes > this.maxStoreBytes) {
      // Mirrors the per-session branch: the log is a prefix from here, and the
      // summary must say so. Silently dropping events while reporting a complete
      // transcript is how a user loses work without being told.
      this.markTruncated(
        storeId,
        `the session store reached its ${String(this.maxStoreBytes)}-byte cap; session ${storeId} is now a prefix`,
      );
      return;
    }

    const db = this.handle();
    const seq = meta.lastSeq + 1;
    const ts = nowIso(this.now());
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        "INSERT INTO events (store_id, seq, ts, payload, bytes) VALUES (?, ?, ?, ?, ?)",
      ).run(storeId, seq, ts, payload, bytes);
      db.prepare(
        `UPDATE sessions
            SET last_seq = ?, first_seq = CASE WHEN first_seq = 0 THEN ? ELSE first_seq END,
                bytes = bytes + ?, updated_at = ?,
                turn_count = turn_count + ?
          WHERE store_id = ?`,
      ).run(seq, seq, bytes, ts, event.type === "turn.completed" ? 1 : 0, storeId);
      db.exec("COMMIT");
    } catch (cause) {
      // The transaction rolled back, so no hole exists and the next append is
      // still free to issue the same sequence number. The one thing that is not
      // recoverable in place is a write that keeps failing, so the session is
      // marked a prefix and refused from here on.
      try {
        db.exec("ROLLBACK");
      } catch {
        // No transaction was open, which is itself fine.
      }
      if (isRetryable(cause)) {
        // Someone else has the file. Nothing about the session is wrong and no
        // hole exists, because the transaction rolled back whole. Recording stops
        // here for this one event and resumes on the next, and the turn itself is
        // untouched: the browser is still streaming, only this record is not kept.
        //
        // The old store behaved this way, reopening its handle and writing the
        // next record at the same sequence number. Stopping instead is what turned
        // a one-millisecond lock into the permanent, silent loss of a live turn
        // that still reported itself complete.
        // Counted, not just reported. The transaction rolled back, so there is no
        // gap for a reader to notice, and without a count the transcript reads as
        // whole while quietly missing events. The summary is left untruncated
        // because the log is not a prefix: a later turn appends normally and the
        // only consequence is this one event, which is what `dropped` reports.
        // The same loss `noteDropped` records, reached for a different reason: the
        // transaction rolled back rather than the record being refused. Persisted
        // for the same reason too, since a restart must not quietly forget it.
        this.noteDropped(
          storeId,
          `the session store was busy, so one record of ${storeId} was not kept: ${String(cause)}`,
          "E_STORE_WRITABLE",
        );
        return;
      }
      this.stopped.add(storeId);
      this.setTruncated(storeId);
      this.report("E_STORE_WRITABLE", `lost the next record of ${storeId}: ${String(cause)}`);
      return;
    }
    this.storeBytes += bytes;
  }

  /**
   * Stops a session's writer and says so in the summary.
   *
   * Used for both quota branches. A refusal that reported itself without stopping
   * would retry the same write on the next event and produce a stream of
   * identical errors for a condition that will not resolve itself.
   */
  private markTruncated(storeId: string, message: string): void {
    this.stopped.add(storeId);
    this.setTruncated(storeId);
    this.report("E_STORE_QUOTA", message);
  }

  /**
   * Records that one event could not be kept, and says so where a reader can see
   * it.
   *
   * The two callers above drop a record without writing one, and without taking
   * the sequence number, so the log stays contiguous and a reader comparing
   * sequences concludes nothing is missing. That is what made a lost assistant
   * message look like a complete transcript. Counting it is the only way to be
   * honest about it, and the count is persisted because the hole outlives the
   * process that made it.
   *
   * Deliberately does not set `truncated`. That flag means the log is a prefix and
   * stops accepting appends, which is a different failure with a different repair.
   * A session that drops one oversized event keeps going, so it belongs under
   * "Incomplete" with an explicit count rather than claiming to be a prefix.
   */
  private noteDropped(
    storeId: string,
    message: string,
    code: SessionStoreErrorCode = "E_STORE_LINE_TOO_LONG",
  ): void {
    this.storeDrifted.set(storeId, (this.storeDrifted.get(storeId) ?? 0) + 1);
    try {
      this.handle()
        .prepare("UPDATE sessions SET dropped_records = dropped_records + 1 WHERE store_id = ?")
        .run(storeId);
    } catch (cause) {
      this.report(
        "E_STORE_WRITABLE",
        `could not record the dropped event of ${storeId}: ${String(cause)}`,
      );
    }
    this.report(code, message);
  }

  private setTruncated(storeId: string): void {
    try {
      this.handle()
        .prepare("UPDATE sessions SET truncated = 1 WHERE store_id = ?")
        .run(storeId);
    } catch (cause) {
      this.report("E_STORE_WRITABLE", `could not mark ${storeId} truncated: ${String(cause)}`);
    }
  }

  /**
   * Applies a harness-supplied title to an already-recorded session.
   *
   * ACP agents auto-generate a title after the first exchange, and a stored
   * session with no title is a blank row in the sidebar forever. The value is
   * harness-influenced text, so it goes through the same sanitizer as a create.
   */
  setTitle(storeId: string, title: string, updatedAt?: string | null): void {
    const meta = this.meta(storeId);
    if (meta === null || meta === undefined) return;
    const sanitized = titleWithinSchema(title);
    // The harness knows better than we do when it was last active, and the
    // sidebar orders by this. Only accepted when parseable, so a malformed value
    // cannot make the row un-evictable by age.
    //
    // Normalised to ISO, because parseable is not the same as sortable. This
    // column is TEXT and every comparator on it is a byte comparison: SQLite
    // never parses it, and neither does the recency index. "Feb 1 2026" parses
    // fine and sorts above every ISO stamp, so the row pinned itself to the top
    // of the sidebar and could never be age-evicted. "1 Jan 2020" sorts below
    // everything and read as the oldest session k5 owns, which is how a live
    // task got reaped for being idle. One shape in, one shape stored.
    const stamp = isoStamp(updatedAt) ?? meta.updatedAt;
    try {
      this.handle()
        .prepare(
          "UPDATE sessions SET title = ?, title_source = ?, updated_at = ? WHERE store_id = ?",
        )
        .run(sanitized, sanitized === meta.title ? meta.titleSource : "harness", stamp, storeId);
    } catch (cause) {
      this.report("E_STORE_WRITABLE", `could not record a session title: ${String(cause)}`);
    }
  }

  /**
   * Falls back to the opening prompt when the harness never names the session.
   * Only the first prompt is used, so a long conversation does not rewrite its
   * own title on every turn.
   */
  titleFromPrompt(storeId: string, prompt: string): void {
    const meta = this.meta(storeId);
    if (meta === null || meta === undefined) return;
    // Gated on the flag rather than on the rendered string: comparing against the
    // placeholder meant a prompt of literally "Untitled task" re-armed this, and
    // turn two silently renamed the session.
    if (meta.titleSource !== "none") return;
    const sanitized = titleWithinSchema(prompt);
    if (sanitized === meta.title) return;
    try {
      this.handle()
        .prepare("UPDATE sessions SET title = ?, title_source = 'prompt' WHERE store_id = ?")
        .run(sanitized, storeId);
    } catch (cause) {
      this.report("E_STORE_WRITABLE", `could not record a session title: ${String(cause)}`);
    }
  }

  /**
   * Kept because the recorder interface promises a durable summary before the
   * browser is told a session exists, and because a WAL checkpoint is the only
   * way to ask for durability without paying for it on every record.
   *
   * In WAL mode with synchronous=NORMAL a committed transaction is already
   * visible to every reader in the process; this makes it survive a power loss
   * too, which is the only thing a caller asking for a flush actually wants.
   *
   * The checkpoint covers the whole database, so the store id a caller holds is
   * accepted for the recorder interface but never read.
   */
  async flushMeta(_storeId: string): Promise<void> {
    if (this.db === null) return;
    try {
      this.handle().exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (cause) {
      this.report("E_STORE_WRITABLE", `could not flush the session store: ${String(cause)}`);
    }
  }

  async flushAll(): Promise<void> {
    if (this.db === null) return;
    try {
      // TRUNCATE, not PASSIVE: this runs at shutdown, where the point is to leave
      // one self-contained file behind rather than a log beside it.
      this.handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (cause) {
      this.report("E_STORE_WRITABLE", `could not flush the session store: ${String(cause)}`);
    }
  }

  list(): SessionSearchRow[] {
    const rows = this.handle()
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC, store_id DESC`,
      )
      .all() as MetaRow[];
    const summaries: SessionSearchRow[] = [];
    for (const row of rows) {
      const meta = rowToMeta(row);
      if (meta === null) {
        this.report(
          "E_STORE_META_CORRUPT",
          `unusable stored session ${asText(row, "store_id") ?? "unknown"}`,
        );
        continue;
      }
      summaries.push(this.toSummary(meta));
      if (summaries.length >= MAX_LISTED_SESSIONS) break;
    }
    return summaries;
  }

  /**
   * Sessions whose title or transcript mentions the query, newest first.
   *
   * Two steps, because projecting every transcript in the store to answer one
   * query is work no one asked for. A `LIKE` over the message payloads narrows
   * the candidates, then only those sessions are projected, and the projection
   * is what decides which line matched and what the snippet says.
   *
   * `%` and `_` in the query are escaped, so a search for "50%" is a search for
   * the literal three characters rather than a pattern that matches everything.
   * An empty result is a normal answer, not an error, and it is what a query
   * nothing matches gets.
   */
  search(query: string): SessionSearchRow[] {
    const needle = query.trim();
    if (needle.length === 0) return [];
    const like = `%${escapeLike(needle)}%`;
    // The candidates come from message payloads only: the prompt on
    // `turn.started` and the text stream of `turn.delta`, which is exactly the
    // set a snippet can be cut from. A LIKE over the whole payload would also
    // match a tool call's title or a reasoning delta, and the row would come
    // back matcher-and-all with nothing on it to show. `json_valid` first,
    // because json_extract throws on a payload that is not JSON at all.
    const rows = this.handle()
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         WHERE title LIKE ? ESCAPE '\\'
            OR store_id IN (
              SELECT store_id FROM events
              WHERE json_valid(payload)
                AND (
                  (json_extract(payload, '$.type') = 'turn.started'
                   AND json_extract(payload, '$.userText') LIKE ? ESCAPE '\\')
                  OR (json_extract(payload, '$.type') = 'turn.delta'
                      AND json_extract(payload, '$.stream') = 'text'
                      AND json_extract(payload, '$.text') LIKE ? ESCAPE '\\')
                )
            )
         ORDER BY updated_at DESC, store_id DESC`,
      )
      .all(like, like, like) as MetaRow[];

    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      if (summaries.length >= MAX_LISTED_SESSIONS) break;
      const meta = rowToMeta(row);
      if (meta === null) {
        this.report(
          "E_STORE_META_CORRUPT",
          `unusable stored session ${asText(row, "store_id") ?? "unknown"}`,
        );
        continue;
      }
      summaries.push(this.toSummary(meta, this.snippetsFor(meta.storeId, needle)));
    }
    return summaries;
  }

  /**
   * Up to `MAX_SNIPPETS_PER_SESSION` matched lines from one session's messages.
   *
   * Matched per record, not per projected turn, because a snippet names the
   * record it came from and a turn is assembled from several. `turn.started`
   * carries the prompt and each `turn.delta` on the text stream carries a piece
   * of the reply, so those two are what a snippet is cut from.
   *
   * Driven by `SessionSnippetSchema.parse`, so a record whose payload no longer
   * matches the contract cannot put an over-long or malformed snippet on the
   * wire.
   */
  private snippetsFor(storeId: string, needle: string): SessionSnippet[] {
    const wanted = needle.toLowerCase();
    const found: SessionSnippet[] = [];
    for (const record of this.allRecords(storeId)) {
      const candidates: { text: string; role: "prompt" | "reply" }[] = [];
      if (record.event.type === "turn.started") {
        candidates.push({ text: record.event.userText, role: "prompt" });
      } else if (record.event.type === "turn.delta" && record.event.stream === "text") {
        candidates.push({ text: record.event.text, role: "reply" });
      }
      for (const { text, role } of candidates) {
        if (!text.toLowerCase().includes(wanted)) continue;
        const snippet = SessionSnippetSchema.safeParse({
          seq: record.seq,
          ts: record.ts,
          role,
          text: trimAround(text, wanted, SNIPPET_CHARS),
        });
        // Reported, not dropped quietly. A matched session whose only matched
        // line fails the contract has to be visible somewhere, or the row
        // reaches the browser claiming a match with nothing to show for it.
        if (!snippet.success) {
          this.report(
            "E_STORE_SNIPPET_UNREADABLE",
            `dropped a matched line in ${storeId}: ${snippet.error.message}`,
          );
          continue;
        }
        found.push(snippet.data);
        if (found.length >= MAX_SNIPPETS_PER_SESSION) return found;
      }
    }
    return found;
  }

  /** Every record the store still holds for a session, oldest first. */
  private allRecords(storeId: string): StoredEventRecord[] {
    const meta = this.meta(storeId);
    if (meta === null || meta.lastSeq === 0) return [];
    const rows = this.handle()
      .prepare("SELECT seq, ts, payload FROM events WHERE store_id = ? ORDER BY seq ASC")
      .all(storeId) as MetaRow[];
    const records: StoredEventRecord[] = [];
    for (const row of rows) {
      const payload = asText(row, "payload");
      if (payload === null) continue;
      const parsed = StoredEventRecordSchema.safeParse({
        v: RECORD_VERSION,
        seq: asInt(row, "seq"),
        ts: asText(row, "ts") ?? "",
        event: JSON.parse(payload) as unknown,
      });
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  summary(storeId: string): SessionSummary | null {
    const meta = this.meta(storeId);
    return meta === null ? null : this.toSummary(meta);
  }

  /**
   * The raw stored record, for callers that need more than the browser-facing
   * summary — the title's source, or whether a boot found an unclean end.
   */
  meta(storeId: string): MetaFile | null {
    if (this.db === null) return null;
    const row = this.handle()
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE store_id = ?`)
      .get(storeId) as MetaRow | undefined;
    if (row === undefined) return null;
    const meta = rowToMeta(row);
    if (meta === null) {
      this.report("E_STORE_META_CORRUPT", `unusable stored session ${storeId}`);
    }
    return meta;
  }

  /** Just the fields continuation needs, and nothing about storage. */
  stored(
    storeId: string,
  ): { projectId: string; cwd: string; harnessSessionId: string } | null {
    const meta = this.meta(storeId);
    if (meta === null) return null;
    return {
      projectId: meta.projectId,
      cwd: meta.cwd,
      harnessSessionId: meta.harnessSessionId,
    };
  }

  private toSummary(
    meta: MetaFile,
    snippets?: readonly SessionSnippet[],
  ): SessionSearchRow {
    const parsed = SessionSummarySchema.safeParse({
      storeId: meta.storeId,
      title: meta.title,
      projectId: meta.projectId,
      projectName: meta.projectName,
      cwd: meta.cwd,
      harness: meta.harness,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      turnCount: meta.turnCount,
      firstSeq: meta.firstSeq,
      lastSeq: meta.lastSeq,
      truncated: meta.truncated,
      droppedRecords: meta.droppedRecords,
    });
    if (!parsed.success) {
      throw new SessionStoreError("E_STORE_META_CORRUPT", `unusable stored session ${meta.storeId}`);
    }
    // Absent rather than empty on a plain list read: an empty array would read
    // as "searched and found nothing", which is not what happened.
    return { ...parsed.data, snippets: snippets === undefined ? undefined : [...snippets] };
  }

  /**
   * Reads a page of records after `since`.
   *
   * Four replay states, each with its own repair, and the cursor arithmetic that
   * produces them: `cursor-too-old` means the client's position predates the
   * oldest retained record, `cursor-invalid` means the cursor is past the end or
   * a hole was found, and both send the reader back to the start rather than
   * returning partial history that looks complete.
   */
  async read(
    storeId: string,
    since: number | null,
    limit: number = MAX_EVENTS_PER_PAGE,
  ): Promise<SessionEventsResponse> {
    const meta = this.meta(storeId);
    if (meta === null || meta === undefined) {
      throw new SessionStoreError("E_STORE_UNKNOWN_SESSION", `no stored session ${storeId}`);
    }
    const cappedLimit = Math.max(1, Math.min(limit, MAX_EVENTS_PER_PAGE));
    const { firstSeq, lastSeq } = meta;
    // Records the store itself failed to keep. Reported on every page rather than
    // folded into the gap count, because these are not holes in the sequence and a
    // reader comparing numbers would never find them.
    //
    // The persisted column is the floor, not the whole answer: it carries the
    // losses made by earlier processes, while `storeDrifted` carries this one's.
    // Reading only the map meant a restart quietly reset the count to zero and the
    // transcript went back to reporting itself whole.
    const drift = Math.max(this.storeDrifted.get(storeId) ?? 0, meta.droppedRecords);
    // 0 is the "start over" cursor: it means everything after seq 0, which is the
    // whole log for any firstSeq. Every path that cannot serve the request returns
    // it, so a client following nextSince rehydrates from the start rather than
    // concluding it has caught up with a log it never read.
    const startOver = 0;
    const base = {
      storeId,
      firstSeq,
      lastSeq,
      nextSince: startOver,
      dropped: 0,
      events: [],
    } as const;

    if (lastSeq === 0) {
      return { ...base, status: "up-to-date", hasMore: false, events: [] };
    }
    if (since !== null && since < firstSeq - 1) {
      return { ...base, status: "cursor-too-old", hasMore: false, events: [] };
    }
    if (since !== null && since > lastSeq) {
      // A cursor past the end is a reset or a foreign cursor. An empty page here
      // would be indistinguishable from caught-up, and the client would wait for
      // ever.
      return { ...base, status: "cursor-invalid", hasMore: false, events: [] };
    }
    const from = since === null ? firstSeq : since + 1;
    if (from > lastSeq) {
      return {
        ...base,
        status: "up-to-date",
        hasMore: false,
        nextSince: since ?? startOver,
        events: [],
      };
    }
    // The summary claims records the events table does not hold. The transaction
    // cannot produce this, but a database restored from a snapshot can, and an
    // empty page here is indistinguishable from caught-up, so a client would wait
    // for ever for records that are not coming. Measured against the highest
    // sequence actually stored rather than the page, so the loss is reported even
    // when the missing records are past the page boundary.
    const highest = this.handle()
      .prepare("SELECT MAX(seq) AS top FROM events WHERE store_id = ?")
      .get(storeId) as MetaRow;
    const top = highest["top"] === null ? null : asInt(highest, "top");
    if (top === null || top < lastSeq) {
      const missing = lastSeq - (top ?? firstSeq - 1);
      return {
        ...base,
        status: "cursor-invalid",
        nextSince: startOver,
        hasMore: false,
        dropped: Math.max(1, missing),
        events: [],
      };
    }

    // Two rows past the cap, because the byte budget and not the row count is
    // usually what ends a page, and the loop needs to see the row that broke it.
    const rows = this.handle()
      .prepare(
        "SELECT seq, ts, payload FROM events WHERE store_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?",
      )
      .all(storeId, from, cappedLimit + 2) as MetaRow[];

    const events: SessionEventsResponse["events"] = [];
    let dropped = 0;
    let bytes = 0;
    let expected = from;
    let hasMore = false;
    let nextSince = since ?? startOver;
    for (const row of rows) {
      if (events.length >= cappedLimit) {
        hasMore = true;
        break;
      }
      const seq = asInt(row, "seq");
      if (seq < expected) {
        // A log that steps backwards. The clamp keeps `dropped` non-negative: a
        // negative count failed the response schema and turned a readable session
        // into a permanent 500 from the API.
        dropped += 1;
        continue;
      }
      if (seq > expected) {
        // A gap is data loss. It is reported and stepped over rather than aborting
        // the page: one unreadable record must not make every page empty, which
        // left a client permanently unable to read its transcript.
        dropped += seq - expected;
        expected = seq;
      }
      const ts = asText(row, "ts") ?? "";
      const payload = asText(row, "payload");
      if (payload === null) {
        dropped += 1;
        expected = seq + 1;
        continue;
      }
      const event = looseEvent(payload);
      if (event === null) {
        // Unreadable and unparseable: reported and stepped over, never fatal. One
        // bad record must not make every page empty, which left a client
        // permanently unable to read its transcript.
        dropped += 1;
        expected = seq + 1;
        continue;
      }
      const size = Buffer.byteLength(payload, "utf8");
      if (events.length > 0 && bytes + size > MAX_PAGE_BYTES) {
        hasMore = true;
        break;
      }
      events.push({ seq, ts, event });
      bytes += size;
      nextSince = seq;
      expected = seq + 1;
    }
    if (events.length === 0 && rows.length > 0) {
      // Every row on this page was unreadable, and the cursor cannot advance past
      // one. Refusing to say there is more strands everything after it, and the
      // browser stops with a transcript that ends where the first bad record
      // begins. Saying there is more with an unchanged cursor is the mirror image:
      // a client that follows it asks the same question and gets the same answer.
      //
      // So the unreadable page is terminal, and says so in the only way the
      // contract can express: no more pages, and every record that could not be
      // rendered counted as lost. A transcript that stops at an unreadable record
      // is visibly shorter than one that lies about being complete.
      hasMore = false;
    } else if (rows.length > events.length && !hasMore) {
      hasMore = nextSince > (since ?? startOver);
    }
    const totalDropped = dropped + drift;
    return {
      storeId,
      // "appended" with no events is a lie: nothing was appended to this reader.
      // A page that served nothing is either caught up or entirely unreadable, and
      // those have different repairs, which is what the two statuses say.
      status:
        events.length === 0
          ? totalDropped > 0
            ? "cursor-invalid"
            : "up-to-date"
          : "appended",
      firstSeq,
      lastSeq,
      nextSince,
      hasMore,
      dropped: totalDropped,
      events,
    };
  }

  // --- attachments ---
  // k5 holds the bytes; the harness is handed a prompt block. Nothing here ever
  // lets a stored path reach the wire, because the manifest is the only thing the
  // turn carries and it names no file. There are no paths at all now: the bytes
  // and the manifest that describes them are one row, so they cannot disagree.

  /**
   * Writes one attachment and returns the manifest k5 will believe about it.
   *
   * `kind` and `size` are derived from the bytes the server just received, never
   * from what the client claimed in `?mime=`: a client that says "text/plain"
   * about a binary would otherwise make the harness inline garbage as text, and
   * the durable transcript would record a size that never arrived. Only `name` is
   * the client's, because only the client knows it.
   */
  async spoolAttachment(
    storeId: string,
    input: {
      readonly attachmentId: string;
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Buffer;
    },
  ): Promise<AttachmentManifestEntry> {
    this.assertOpen();
    if (this.meta(storeId) === null) {
      throw new SessionStoreError("E_STORE_UNKNOWN_SESSION", `no stored session ${storeId}`);
    }
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new SessionStoreError(
        "E_STORE_QUOTA",
        `an attachment of ${String(input.bytes.length)} bytes is over the ${String(MAX_ATTACHMENT_BYTES)}-byte cap`,
      );
    }
    // Checked against the whole-store ceiling rather than only the per-file cap:
    // spooled bytes are not events, so they never reach the log's own accounting
    // and would otherwise be the only thing in the store nothing bounds.
    if (this.storeBytes + input.bytes.length > this.maxStoreBytes) {
      throw new SessionStoreError(
        "E_STORE_QUOTA",
        `the session store reached its ${String(this.maxStoreBytes)}-byte cap; ${storeId} has no room for an attachment`,
      );
    }
    const manifest = AttachmentManifestEntrySchema.safeParse({
      attachmentId: input.attachmentId,
      name: input.name,
      mimeType: input.mimeType,
      kind: classifyAttachment(input.bytes, input.mimeType),
      size: input.bytes.length,
    });
    // Refused before a byte is written: a manifest that cannot satisfy the
    // contract is not a manifest, and a half-stored attachment is invisible to
    // the prompt that names it.
    if (!manifest.success) {
      throw new SessionStoreError(
        "E_STORE_WRITABLE",
        `unusable attachment manifest: ${manifest.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    // The id is no longer a path component, so there is nothing for it to escape.
    // It is still a caller-named key, and it is still the thing a URL segment
    // names, so the shapes that would make a stored row impossible to address
    // again are refused here rather than relied on upstream. The separator check
    // is explicit because the predicate judges one segment by design and cannot
    // see one.
    if (input.attachmentId.includes("/") || input.attachmentId.includes("\\")) {
      throw new SessionStoreError("E_STORE_PATH_ESCAPE", "unsafe attachment id (separator)");
    }
    const reason = unsafeNameReason(input.attachmentId);
    if (reason !== null) {
      throw new SessionStoreError("E_STORE_PATH_ESCAPE", `unsafe attachment id (${reason})`);
    }
    const charged = manifest.data.size + Buffer.byteLength(JSON.stringify(manifest.data), "utf8");
    try {
      this.handle()
        .prepare(
          `INSERT INTO attachments
             (store_id, attachment_id, name, mime_type, kind, size, manifest_bytes, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storeId,
          input.attachmentId,
          input.name,
          input.mimeType,
          manifest.data.kind,
          manifest.data.size,
          Buffer.byteLength(JSON.stringify(manifest.data), "utf8"),
          input.bytes,
        );
    } catch (cause) {
      throw new SessionStoreError(
        "E_STORE_WRITABLE",
        `could not spool an attachment for ${storeId}: ${String(cause)}`,
      );
    }
    // Accrued only after the row is written, so a failed write charges nothing.
    this.storeBytes += charged;
    return manifest.data;
  }

  /**
   * The manifest a spooled attachment was stored under, keyed by the id alone.
   *
   * The browser names an attachment by id, so this is the only way the name and
   * mime it was given at upload can reach the turn that uses it. Re-read from the
   * row rather than remembered: an in-memory table would lose every attachment
   * across a restart, and the turn would then silently run without the bytes the
   * user attached.
   */
  async attachmentManifest(
    storeId: string,
    attachmentId: string,
  ): Promise<AttachmentManifestEntry> {
    const row = this.attachmentRow(storeId, attachmentId);
    if (row === null) {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_ATTACHMENT",
        `no attachment ${attachmentId} in session ${storeId}`,
      );
    }
    const manifest = AttachmentManifestEntrySchema.safeParse({
      attachmentId: asText(row, "attachment_id") ?? attachmentId,
      name: asText(row, "name") ?? "",
      mimeType: asText(row, "mime_type") ?? "",
      kind: asText(row, "kind") ?? "binary",
      size: asInt(row, "size"),
    });
    if (!manifest.success) {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_ATTACHMENT",
        `the manifest for ${attachmentId} is not in the expected shape`,
      );
    }
    return manifest.data;
  }

  async readAttachment(storeId: string, attachmentId: string): Promise<Buffer> {
    const row = this.attachmentRow(storeId, attachmentId);
    if (row === null) {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_ATTACHMENT",
        `no attachment ${attachmentId} in session ${storeId}`,
      );
    }
    const body = row["body"];
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
    throw new SessionStoreError(
      "E_STORE_UNKNOWN_ATTACHMENT",
      `the bytes for ${attachmentId} are not in the expected shape`,
    );
  }

  /** The reverse state for an upload that was never used. */
  async discardAttachment(storeId: string, attachmentId: string): Promise<boolean> {
    if (this.db === null) return false;
    const row = this.attachmentRow(storeId, attachmentId);
    if (row === null) return false;
    // The charge is read before the delete, because afterwards there is nothing
    // left to measure and the store would keep charging for bytes it no longer has.
    const charged = asInt(row, "size") + asInt(row, "manifest_bytes");
    this.handle()
      .prepare("DELETE FROM attachments WHERE store_id = ? AND attachment_id = ?")
      .run(storeId, attachmentId);
    this.storeBytes = Math.max(0, this.storeBytes - charged);
    return true;
  }

  private attachmentRow(storeId: string, attachmentId: string): MetaRow | null {
    if (this.db === null) return null;
    // Resolved through a query rather than a path, so there is no path to escape
    // and a hostile id is a missing row rather than a file read.
    const row = this.handle()
      .prepare(
        "SELECT attachment_id, name, mime_type, kind, size, manifest_bytes, body FROM attachments WHERE store_id = ? AND attachment_id = ?",
      )
      .get(storeId, attachmentId) as MetaRow | undefined;
    return row === undefined ? null : row;
  }

  /** Removes k5's own record. Never touches the harness's session. */
  async remove(storeId: string): Promise<boolean> {
    if (this.db === null) return false;
    // The session's own contribution is read first, and the budget is adjusted by
    // that. Re-measuring the whole store instead means a full scan of every
    // payload's length on every delete, which is linear in the size of the store
    // and runs on the event loop: one DELETE of a small task blocked the server
    // for the better part of a second on a store holding a gigabyte.
    const before = this.handle()
      .prepare(
        `SELECT s.bytes AS bytes,
                COALESCE((SELECT SUM(a.size + a.manifest_bytes) FROM attachments a
                           WHERE a.store_id = s.store_id), 0) AS spooled
           FROM sessions s WHERE s.store_id = ?`,
      )
      .get(storeId) as MetaRow | undefined;
    if (before === undefined) return false;
    // The delete itself is a single statement, so the cascade cannot leave events
    // behind. The read above is for the budget only.
    const result = this.handle().prepare("DELETE FROM sessions WHERE store_id = ?").run(storeId);
    if (Number(result.changes) === 0) return false;
    // The cascade took the events and the attachment bytes with the session.
    this.storeBytes = Math.max(0, this.storeBytes - asInt(before, "bytes") - asInt(before, "spooled"));
    this.stopped.delete(storeId);
    this.live.delete(storeId);
    this.storeDrifted.delete(storeId);
    return true;
  }

  // --- migration from the pre-SQLite store ---
  //
  // One import, at open, guarded by the presence of a legacy directory. The old
  // layout is left in place afterwards: it is a user's transcripts, and deleting
  // somebody's history because an import succeeded is not a trade this makes on
  // their behalf. A second open finds nothing to import and pays only a readdir.

  /**
   * Imports every pre-SQLite session directory it finds.
   *
   * Skipped entirely when k5.db already holds sessions, so the import is a
   * first-open migration and not something that runs against a live store. A
   * session that is already present is left alone, which makes a re-import after
   * a partial failure a no-op rather than a duplicate.
   */
  private async importLegacyJsonl(): Promise<void> {
    // Gated on a marker, not on the store being empty.
    //
    // "Empty" is the wrong test: a crash, a full disk, or a kill part-way through
    // an import leaves a database holding one session and the remaining legacy
    // directories untouched. Gating on emptiness meant the next boot imported
    // nothing at all, so the rest of a user's transcripts became unreachable with
    // no diagnostic and no way back, because the legacy files are deliberately
    // never deleted.
    //
    // The marker is written only after every directory has been walked, so it
    // means "this root has been fully imported", and the per-session existence
    // check is what makes re-running idempotent.
    if (this.importDone()) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const candidates = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    // Nothing to import means the marker is not written. Writing it on an empty root
    // is a one-way door: a user who later restores a backup of their old session
    // directories into this root gets a store that reports no tasks while the
    // transcripts sit right there, unreadable, with nothing to say so.
    if (candidates.length === 0) return;
    let sessions = 0;
    let records = 0;
    let unreadable = 0;
    for (const entry of candidates) {
      const imported = await this.importLegacySession(path.join(this.root, entry.name), entry.name);
      if (imported === null) continue;
      sessions += 1;
      records += imported.records;
      unreadable += imported.unreadable;
    }
    this.markImportDone();
    if (sessions > 0) {
      this.report(
        "E_STORE_WRITABLE",
        `imported ${String(sessions)} pre-SQLite session(s) and ${String(records)} record(s) from ${this.root}`,
      );
    }
    if (unreadable > 0) {
      this.report(
        "E_STORE_CORRUPT_RECORD",
        `${String(unreadable)} record(s) in ${this.root} did not survive the import; the old files are still there`,
      );
    }
  }

  /** True once this root has been walked in full, whether or not it held anything. */
  private importDone(): boolean {
    const row = this.handle()
      .prepare("SELECT value FROM store_flags WHERE flag = 'legacy-import-done'")
      .get() as MetaRow | undefined;
    return row !== undefined;
  }

  private markImportDone(): void {
    this.handle()
      .prepare("INSERT OR REPLACE INTO store_flags (flag, value) VALUES ('legacy-import-done', '1')")
      .run();
  }

  /** One legacy directory. Returns what was imported, or null if it was not a session. */
  private async importLegacySession(
    dir: string,
    label: string,
  ): Promise<{ records: number; unreadable: number } | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(dir, "meta.json"), "utf8");
    } catch {
      // A directory with no readable meta is not a session. Skipping it keeps one
      // bad file from hiding every other session, here as it did before.
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.report("E_STORE_META_CORRUPT", `unreadable legacy meta in ${label}`);
      return null;
    }
    const meta = LegacyMetaSchema.safeParse(parsed);
    if (!meta.success) {
      // An unknown shape is refused, never coerced forward: a silently defaulted
      // field renders a session list full of empty cards.
      this.report(
        "E_STORE_META_CORRUPT",
        `unusable legacy meta in ${label}: ${meta.error.issues[0]?.message ?? "unknown"}`,
      );
      return null;
    }
    if (this.meta(meta.data.storeId) !== null) return null;

    const legacy = await readLegacyEvents(path.join(dir, "events.jsonl"));
    const db = this.handle();
    let imported = 0;
    // A line the record schema refuses is dropped, because a transcript carrying a
    // record no browser can render is worse than one missing it. It is counted
    // rather than discarded quietly: the whole reason to import at all is that
    // this is somebody's history, and a silent drop reads as a successful move.
    if (legacy.skipped > 0) {
      this.report(
        "E_STORE_CORRUPT_RECORD",
        `skipped ${String(legacy.skipped)} unreadable record(s) while importing ${label}`,
      );
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        meta.data.storeId,
        meta.data.harness,
        meta.data.harnessSessionId,
        meta.data.projectId,
        meta.data.projectName,
        meta.data.cwd,
        meta.data.title,
        meta.data.createdAt,
        meta.data.updatedAt,
        meta.data.turnCount,
        meta.data.firstSeq,
        meta.data.lastSeq,
        meta.data.bytes,
        meta.data.truncated ? 1 : 0,
        meta.data.titleSource,
        meta.data.endedMidTurn ? 1 : 0,
        // The unreadable records this import skipped are loss the same shape as a
        // record a live append refused to keep: gone, with no gap left behind.
        // Counting them here is what stops an imported transcript claiming to be
        // whole while missing the turns that did not parse.
        legacy.skipped,
      );
      const insert = db.prepare(
        "INSERT OR REPLACE INTO events (store_id, seq, ts, payload, bytes) VALUES (?, ?, ?, ?, ?)",
      );
      for (const record of legacy.records) {
        insert.run(
          meta.data.storeId,
          record.seq,
          record.ts,
          record.payload,
          record.bytes,
        );
        imported += 1;
      }
      db.exec("COMMIT");
    } catch (cause) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // No transaction was open, which is itself fine.
      }
      this.report("E_STORE_WRITABLE", `could not import ${label}: ${String(cause)}`);
      return null;
    }
    return { records: imported, unreadable: legacy.skipped };
  }

  /** Every row is committed by the time this returns; only the WAL is left to fold in. */
  async close(): Promise<void> {
    const db = this.db;
    if (db === null) return;
    this.ready = false;
    this.db = null;
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // The rows are already durable; a checkpoint that will not run is not a
      // reason to refuse to close.
    }
    db.close();
  }
}

/**
 * Whether a session's last event left a turn open.
 *
 * A turn-scoped record with nothing terminal after it means the turn never
 * finished, which is exactly the state a hard kill leaves behind. Checking
 * whether `turn.started` was seen is not enough: a transcript that begins
 * mid-stream has turn content and no opening event, so the last record decides.
 */
function endsMidTurn(tail: string | null): boolean {
  if (tail === null) return false;
  const event = looseEvent(tail);
  if (event === null) {
    // An unreadable tail is not evidence of anything, and the row it came from
    // is already refused by rowToMeta on the next read.
    return false;
  }
  return (
    event.type === "turn.started" ||
    event.type === "turn.delta" ||
    event.type === "tool.updated"
  );
}

/**
 * The last resort for a payload that no longer satisfies the stored record
 * schema: a forward-compatible read of a `type`/`sessionId` pair. Anything else
 * is refused, because rendering half an event is worse than reporting it lost.
 */
function looseEvent(payload: string): ServerEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const type = (parsed as { type?: unknown }).type;
    const sessionId = (parsed as { sessionId?: unknown }).sessionId;
    if (typeof type !== "string" || typeof sessionId !== "string") return null;
    const candidate = { ...(parsed as Record<string, unknown>), type, sessionId };
    const result = StoredEventRecordSchema.shape.event.safeParse(candidate);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// --- migration from the pre-SQLite store ---
//
// One import, at open, guarded by the presence of a legacy directory. The old
// layout is left in place afterwards: it is a user's transcripts, and deleting
// somebody's history because an import succeeded is not a trade this makes on
// their behalf. A second open finds nothing to import and pays only a readdir.

interface LegacyMeta {
  readonly storeId: string;
  readonly harness: string;
  readonly harnessSessionId: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly titleSource: "none" | "prompt" | "harness";
  readonly endedMidTurn: boolean;
}

const LegacyMetaSchema = z
  .object({
    // The old meta carried a version, and refusing it as an unknown key is what
    // made this refuse every real legacy file rather than the two that happen to
    // parse.
    v: z.literal(META_VERSION),
    storeId: z.string().min(1).max(64),
    harness: z.string().min(1).max(64),
    harnessSessionId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256),
    projectName: z.string().min(1).max(200).nullable(),
    cwd: z.string().min(1).max(4096),
    title: z.string().min(1).max(200),
    createdAt: z.string().min(1).max(64),
    updatedAt: z.string().min(1).max(64),
    turnCount: z.number().int().nonnegative(),
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    titleSource: z.enum(["none", "prompt", "harness"]),
    endedMidTurn: z.boolean(),
  })
  .strict();

/**
 * Reads a legacy log whole, dropping a torn final line exactly as a reader did.
 *
 * The line is stored verbatim as the event payload, so an imported record
 * re-serialises byte for byte and the byte accounting the old meta carried stays
 * true.
 */
async function readLegacyEvents(
  file: string,
): Promise<{ records: { seq: number; ts: string; payload: string; bytes: number }[]; skipped: number }> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return { records: [], skipped: 0 };
  }
  // Everything after the final newline is an in-flight append and was never a
  // record, so it is not imported.
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline);
  const out: { seq: number; ts: string; payload: string; bytes: number }[] = [];
  let skipped = 0;
  for (const line of complete.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const record = StoredEventRecordSchema.safeParse(parsed);
    if (!record.success) {
      skipped += 1;
      continue;
    }
    out.push({
      seq: record.data.seq,
      ts: record.data.ts,
      // The event on its own: `payload` is the event, because that is what every
      // row written by append() holds.
      payload: JSON.stringify(record.data.event),
      // The line as it stood on disk, newline included. The old accounting
      // measured the file, so importing the old numbers keeps the session's byte
      // count true to what it was before the move.
      bytes: Buffer.byteLength(line, "utf8") + 1,
    });
  }
  return { records: out, skipped };
}

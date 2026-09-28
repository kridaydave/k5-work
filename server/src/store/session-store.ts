import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  type AttachmentKind,
  type AttachmentManifestEntry,
  type IsoTimestamp,
  type ReplayStatus,
  type SessionEventsResponse,
  type SessionSummary,
  type StoredEventRecord,
} from "@k5-work/shared";
import type { ServerEvent } from "@k5-work/shared";
import { SessionStoreError, type SessionStoreErrorCode } from "./errors.js";
import { unsafeNameReason } from "./safe-name.js";

// Durable local session log.
//
// k5 is the store. The harness is asked to continue a session, never to re-read
// one, so this file is the record of what k5 sent and received and makes no
// claim to be the harness's own history.
//
// Shape per session:
//   <root>/<hash of a k5-minted id>/meta.json     small mutable summary, replaced atomically
//   <root>/<hash of a k5-minted id>/events.jsonl  append-only, one record per line
//
// The failure modes below were each reproduced against this code before being
// fixed; the comment on each says what breaks without it.

/**
 * Tighter than the websocket's 1 MB outbound frame cap, and deliberately so:
 * the store is the last place a payload can be rejected before it is durable, so
 * it gets the tighter bound. A record here is the wire event plus a wrapper, and
 * JSON.stringify expands each control character to six bytes, so the wrapper
 * makes an event near the frame cap exceed this one.
 *
 * A line over the cap is dropped whole rather than truncated, because a
 * truncated line is permanently unparseable and would poison the record after it.
 */
export const MAX_LINE_BYTES = 256 * 1024;

/** A generous long session. On breach the log stops growing and says so. */
export const MAX_SESSION_BYTES = 12 * 1024 * 1024;

/** Whole-store ceiling, so a runaway agent cannot fill the user's disk. */
export const MAX_STORE_BYTES = 2 * 1024 * 1024 * 1024;

export const MAX_SESSIONS = 500;

/** Ceiling on one HTTP page, by serialised bytes rather than by event count. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * How much of a log a single read may scan. Reads start at the beginning of the
 * file, so this must exceed MAX_SESSION_BYTES or the tail of a long session
 * becomes unreachable. The constructor refuses a maxSessionBytes that breaks the
 * invariant, so it cannot rot silently.
 */
export const MAX_READ_WINDOW_BYTES = 16 * 1024 * 1024;

const META_FILE = "meta.json";
const EVENTS_FILE = "events.jsonl";
const META_VERSION = 1;
const TITLE_MAX_GRAPHEMES = 120;
const SESSION_IDLE_EVICT_MS = 30 * 24 * 60 * 60 * 1000;
// Both live inside the session directory, so remove() and evict() already take
// them with them and no retention rule has to be written a second time. They are
// separate directories rather than two extensions in one, because an id is
// validated as a safe name and not as a UUID: "x.json" is a legal name, and in a
// shared directory it would be both bytes for one attachment and the manifest of
// another.
const ATTACHMENT_BYTES_DIR = "attachments";
const ATTACHMENT_MANIFEST_DIR = "manifests";

/**
 * Zod rather than a bag of `String()` and `Number()` coercions. `Number({})` is
 * NaN, and a NaN turnCount in one meta file made list() throw a raw ZodError,
 * which 500'd the whole session list for every session, while a NaN byte count
 * silently disabled that session's quota.
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
    // A flag, not a sentinel value. Comparing against the placeholder string
    // meant a first prompt of literally "Untitled task", or any harness title
    // that sanitised to the placeholder, re-armed the fallback and let turn two
    // silently rename the session.
    titleSource: z.enum(["none", "prompt", "harness"]),
    /**
     * True when a boot found a log whose last turn never reached a terminal
     * event. Best-effort, not a guarantee: nothing runs on SIGKILL, so a hard
     * kill can still leave a log ending mid-turn.
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

// The index holds these live and the writer mutates them in place, so they are
// deliberately not readonly. Every mutation is followed by a serialised meta
// write, and readMeta re-parses them from disk on rescan.
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

interface Writer {
  /** Never rejects, so one failed write cannot poison every later append. */
  queue: Promise<void>;
  handle: fsp.FileHandle | null;
  bytes: number;
  truncated: boolean;
  stopped: boolean;
}

function nowIso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString();
}

/**
 * Strips control characters and bidi overrides, collapses whitespace, then cuts
 * on a grapheme boundary. String.slice would split a surrogate pair and produce
 * mojibake, and a title is harness-influenced text rendered in a sidebar row.
 */
export function sanitizeTitle(raw: string, maxGraphemes = TITLE_MAX_GRAPHEMES): string {
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (stripped.length === 0) return "Untitled task";
  if (stripped.length <= maxGraphemes) return stripped;
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  let out = "";
  let count = 0;
  for (const { segment } of segmenter.segment(stripped)) {
    if (count >= maxGraphemes) break;
    out += segment;
    count += 1;
  }
  return `${out.replace(/[\s.]+$/u, "")}…`;
}

function sessionDirName(storeId: string): string {
  // The harness session id is never a path component: it is opaque, up to 256
  // chars, and two harnesses can return the same one. Hashing it would also
  // collide, since truncate-then-hash maps "a"*40 and "a"*41 to one directory.
  // storeId is k5-minted, so the name is fixed width and case-independent.
  return `s-${createHash("sha256").update(storeId, "utf8").digest("hex").slice(0, 32)}`;
}

function assertInside(root: string, target: string): void {
  if (path.dirname(target) !== root) {
    throw new SessionStoreError(
      "E_STORE_PATH_ESCAPE",
      `refusing a store path outside the root: ${target}`,
    );
  }
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

export class SessionStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxSessionBytes: number;
  private readonly maxStoreBytes: number;
  private readonly idleEvictMs: number;
  private readonly onError: (error: SessionStoreError) => void;
  private readonly index = new Map<string, MetaFile>();
  private readonly writers = new Map<string, Writer>();
  private storeBytes = 0;
  /**
   * Bytes spooled per session, tracked apart from the log.
   *
   * The log carries its own size in meta.json, so it can be re-measured after a
   * restart. The spool has no such file, so without this the whole-store ceiling
   * is checked on every upload and never accumulated: a loop of 25 MB uploads
   * passes the check every time and fills the disk. Deleting bytes has to give
   * the budget back, or a store that once held a large attachment refuses real
   * writes for the rest of the process.
   */
  private readonly spoolBytes = new Map<string, number>();
  private ready = false;

  constructor(options: SessionStoreOptions) {
    this.root = path.resolve(options.root);
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.maxSessionBytes = options.maxSessionBytes ?? MAX_SESSION_BYTES;
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_STORE_BYTES;
    this.idleEvictMs = options.idleEvictMs ?? SESSION_IDLE_EVICT_MS;
    this.onError = options.onError ?? (() => {});
    // A configured cap at or above the read window would produce a log whose
    // tail no read can reach, with no error anywhere. Refuse the configuration
    // rather than relying on a test that compares two constants.
    if (this.maxSessionBytes >= MAX_READ_WINDOW_BYTES) {
      throw new SessionStoreError(
        "E_STORE_ROOT",
        `maxSessionBytes ${this.maxSessionBytes} must be below the read window ${MAX_READ_WINDOW_BYTES}`,
      );
    }
  }

  /**
   * The single reporting path. A caller-supplied reporter that throws would
   * otherwise turn the store's central safety claim into its opposite: append()
   * would throw synchronously into the synchronous emit path, and a rejected
   * write queue would be permanently poisoned.
   */
  private report(code: SessionStoreErrorCode, message: string): void {
    try {
      this.onError(new SessionStoreError(code, message));
    } catch {
      // A broken reporter is not allowed to become a store failure.
    }
  }

  /**
   * Creates the root, repairs any torn tail, and loads the index. Called from
   * the server entry point, never at module scope, because module-graph.test.ts
   * imports every compiled module and a directory created at import time is a
   * side effect in a test.
   */
  async open(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    // mkdir honours the umask, so an already-wider directory stays readable by
    // other local users. Transcripts are agent output: source, and whatever the
    // agent read. Tighten it explicitly.
    await fsp.chmod(this.root, 0o700).catch(() => {});
    await this.repairTornTails();
    await this.rescan();
    await this.reconcileLogs();
    this.ready = true;
  }

  /**
   * Brings each index entry back into agreement with its log.
   *
   * The meta is flushed on a timer and at turn end, so after an unclean exit it
   * can sit behind the log. Appending against a stale lastSeq re-issued sequence
   * numbers that were already on disk, and from there every read of that session
   * failed permanently. Taking the larger of the two is safe: a number is only
   * ever issued once, and the log is the authority on what exists.
   *
   * Also marks a log that ends mid-turn. Nothing runs on SIGKILL, so the
   * terminator written on a graceful release is best-effort, not a guarantee —
   * without this, a reloaded transcript showed tool cards that spin forever
   * while the store reported the session as complete.
   */
  private async reconcileLogs(): Promise<void> {
    for (const [storeId, meta] of [...this.index]) {
      let onDisk: { lastSeq: number; bytes: number; openTurn: boolean } | null = null;
      try {
        onDisk = await this.scanTail(storeId);
      } catch (cause) {
        this.report("E_STORE_WRITABLE", `could not reconcile ${storeId}: ${String(cause)}`);
        continue;
      }
      if (onDisk === null) continue;
      if (onDisk.lastSeq > meta.lastSeq) {
        this.report(
          "E_STORE_CORRUPT_LOG",
          `stored meta for ${storeId} claimed ${meta.lastSeq} records but the log holds ${onDisk.lastSeq}`,
        );
        meta.lastSeq = onDisk.lastSeq;
        if (meta.firstSeq === 0 || meta.firstSeq > onDisk.lastSeq) meta.firstSeq = onDisk.lastSeq;
      }
      if (onDisk.bytes > 0 && onDisk.bytes !== meta.bytes) {
        // The log is the authority for how full it is, which is what keeps the
        // per-session cap honest across restarts.
        this.storeBytes = Math.max(0, this.storeBytes - meta.bytes);
        meta.bytes = onDisk.bytes;
        this.storeBytes += onDisk.bytes;
      }
      if (onDisk.openTurn && !meta.endedMidTurn) {
        meta.endedMidTurn = true;
        meta.truncated = true;
        this.report(
          "E_STORE_CORRUPT_LOG",
          `session ${storeId} ended mid-turn, most likely an unclean shutdown; its transcript is a prefix`,
        );
      }
      void this.writeMeta(meta).catch((cause: unknown) => {
        this.report("E_STORE_WRITABLE", `could not persist reconciliation: ${String(cause)}`);
      });
    }
  }

  /** Reads a log's last sequence, byte count, and whether a turn is still open. */
  private async scanTail(
    storeId: string,
  ): Promise<{ lastSeq: number; bytes: number; openTurn: boolean } | null> {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(this.eventsPath(storeId), fs.constants.O_RDONLY);
    } catch {
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0) return { lastSeq: 0, bytes: 0, openTurn: false };
      const buffer = Buffer.allocUnsafe(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n").filter((line) => line.length > 0);
      let lastSeq = 0;
      // The last record decides. A turn-scoped record with nothing terminal
      // after it means the turn never finished, which is exactly the state a hard
      // kill leaves behind. Tracking whether turn.started was seen was not enough:
      // a log that began mid-stream has turn content and no opening event.
      let lastType: string | null = null;
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const record = StoredEventRecordSchema.safeParse(parsed);
        if (!record.success) continue;
        if (record.data.seq > lastSeq) lastSeq = record.data.seq;
        lastType = record.data.event.type;
      }
      const openTurn =
        lastType === "turn.started" || lastType === "turn.delta" || lastType === "tool.updated";
      return { lastSeq, bytes: stat.size, openTurn };
    } finally {
      await handle.close();
    }
  }

  /**
   * Truncates a log that does not end in a newline. Without this, the next
   * append concatenates onto the fragment and produces one line that destroys
   * both the torn record and the good one after it, permanently.
   *
   * Safe here and only here: no writer holds a handle yet, because this runs
   * before `ready`.
   */
  private async repairTornTails(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const logPath = path.join(this.root, entry.name, EVENTS_FILE);
      let handle: fsp.FileHandle | null = null;
      try {
        handle = await fsp.open(logPath, fs.constants.O_RDWR);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0) continue;
        const buffer = Buffer.allocUnsafe(stat.size);
        const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
        if (bytesRead === 0 || buffer[bytesRead - 1] === 0x0a) continue;
        const cut = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (cut === -1) {
          // Nothing complete at all: the log is one torn record.
          await handle.truncate(0);
          this.report("E_STORE_WRITABLE", `discarded an entirely torn log in ${entry.name}`);
          continue;
        }
        await handle.truncate(cut + 1);
        this.report(
          "E_STORE_WRITABLE",
          `repaired a torn final record in ${entry.name}, dropping ${bytesRead - (cut + 1)} bytes`,
        );
      } catch (cause) {
        this.report("E_STORE_WRITABLE", `could not inspect ${entry.name}: ${String(cause)}`);
      } finally {
        await handle?.close().catch(() => {});
      }
    }
  }

  private assertOpen(): void {
    if (!this.ready) {
      throw new SessionStoreError("E_STORE_WRITABLE", "the session store is not open");
    }
  }

  private dirFor(storeId: string): string {
    const name = sessionDirName(storeId);
    const reason = unsafeNameReason(name);
    if (reason !== null) {
      throw new SessionStoreError("E_STORE_PATH_ESCAPE", `unsafe session directory name (${reason})`);
    }
    const dir = path.join(this.root, name);
    assertInside(this.root, dir);
    return dir;
  }

  private eventsPath(storeId: string): string {
    const dir = this.dirFor(storeId);
    const target = path.join(dir, EVENTS_FILE);
    assertInside(dir, target);
    return target;
  }

  private metaPath(storeId: string): string {
    const dir = this.dirFor(storeId);
    const target = path.join(dir, META_FILE);
    assertInside(dir, target);
    return target;
  }

  /**
   * A path two levels below the root. The spool needs its own containment check
   * because `assertInside` judges a direct child, and an attachment is a grandchild.
   */
  private subPath(storeId: string, dirName: string, fileName: string): string {
    const sessionDir = this.dirFor(storeId);
    const dir = path.join(sessionDir, dirName);
    assertInside(sessionDir, dir);
    const target = path.join(dir, fileName);
    assertInside(dir, target);
    return target;
  }

  private attachmentPath(storeId: string, attachmentId: string): string {
    return this.subPath(storeId, ATTACHMENT_BYTES_DIR, this.safeAttachmentName(attachmentId));
  }

  private attachmentManifestPath(storeId: string, attachmentId: string): string {
    return this.subPath(
      storeId,
      ATTACHMENT_MANIFEST_DIR,
      `${this.safeAttachmentName(attachmentId)}.json`,
    );
  }

  /**
   * The one place an attachment id becomes a path component. It is caller-named
   * in every direction, so it goes through the same predicate as a session
   * directory: a rejected id is never a path, only a 400-shaped error.
   */
  private safeAttachmentName(attachmentId: string): string {
    const reason = unsafeNameReason(attachmentId);
    if (reason !== null) {
      throw new SessionStoreError(
        "E_STORE_PATH_ESCAPE",
        `unsafe attachment id (${reason})`,
      );
    }
    return attachmentId;
  }

  /** Rebuilds the whole index from disk. The only thing that keeps it honest. */
  async rescan(): Promise<number> {
    this.index.clear();
    this.storeBytes = 0;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const meta = await this.readMeta(path.join(this.root, entry.name));
      if (meta !== null) {
        this.index.set(meta.storeId, meta);
        this.storeBytes += meta.bytes;
      }
    }
    this.evict(false);
    return this.index.size;
  }

  private async readMeta(dir: string): Promise<MetaFile | null> {
    let text: string;
    try {
      text = await fsp.readFile(path.join(dir, META_FILE), "utf8");
    } catch {
      // A session directory with no readable meta is not a session. Skipping
      // it keeps one corrupt file from hiding every other session.
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.report("E_STORE_META_CORRUPT", `unreadable meta in ${path.basename(dir)}`);
      return null;
    }
    const result = MetaFileSchema.safeParse(parsed);
    if (!result.success) {
      // An unknown version is refused, never coerced forward: a silently
      // defaulted field renders a session list full of empty cards.
      this.report(
        "E_STORE_META_CORRUPT",
        `unusable meta in ${path.basename(dir)}: ${result.error.issues[0]?.message ?? "unknown"}`,
      );
      return null;
    }
    return result.data;
  }

  private async writeMeta(meta: MetaFile): Promise<void> {
    const dir = this.dirFor(meta.storeId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = this.metaPath(meta.storeId);
    // O_EXCL defeats a pre-planted symlink at the temp path: a harness running
    // agent-supplied code shares this uid, so a predictable temp name is an
    // arbitrary-file-overwrite primitive. O_NOFOLLOW is undefined on win32.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const tmp = path.join(dir, `.${META_FILE}.${randomUUID()}.tmp`);
    const handle = await fsp.open(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(meta)}\n`, "utf8");
      // Data durable before the rename, or the rename can publish a name whose
      // contents are not on disk.
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(tmp, target);
    } catch (cause) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw cause;
    }
    // The rename itself must be durable, or a crash can leave meta.json absent
    // even though the rename reported success. Directory fsync is POSIX-only.
    if (process.platform !== "win32") {
      const dirHandle = await fsp.open(dir, fs.constants.O_RDONLY);
      try {
        await dirHandle.sync();
      } catch {
        // Not every filesystem supports it; the rename already happened.
      } finally {
        await dirHandle.close();
      }
    }
  }

  private writerFor(storeId: string): Writer {
    const existing = this.writers.get(storeId);
    if (existing !== undefined) return existing;
    const meta = this.index.get(storeId);
    // Seeded from the durable byte count, not from zero. Otherwise every process
    // restart grants the session a fresh full budget on top of what is already
    // on disk, which was measured growing the log without bound across restarts.
    const created: Writer = {
      queue: Promise.resolve(),
      handle: null,
      bytes: meta?.bytes ?? 0,
      truncated: meta?.truncated === true,
      stopped: false,
    };
    this.writers.set(storeId, created);
    return created;
  }

  /**
   * Retention, not just a cap. A cap with no eviction is a one-way door: the
   * user hits the ceiling and can only recover by editing ~/.local/share by
   * hand, which is not a reverse state.
   *
   * The overflow is computed once, before the loop. Reading the live index size
   * inside the loop meant each deletion shrank the bound and the loop stopped
   * one session short, after which every create() failed with no way out.
   *
   * `makeRoom` is what separates the two callers. A boot prunes only by age, so
   * a workspace that is simply large keeps its recent work. A create that is
   * already at the cap prunes the oldest regardless of age, because refusing
   * every new session forever is the same dead end from the other direction.
   */
  private evict(makeRoom: boolean): number {
    let removed = 0;
    const nowMs = this.now();
    const live = new Set(this.writers.keys());
    const byAge = [...this.index.values()].sort(
      (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
    );
    // `remaining` is the count still in the index, decremented as we go. Reading
    // the live index size inside the loop meant each deletion shrank the bound
    // and the loop stopped one session short, after which every create() failed
    // with no way out.
    let remaining = this.index.size;
    for (const meta of byAge) {
      const idle = nowMs - Date.parse(meta.updatedAt);
      const overCap = remaining > this.maxSessions;
      // A create that is already at the cap prunes the oldest regardless of age:
      // refusing every new session forever is the same dead end from the other
      // direction.
      const needRoom = makeRoom && remaining >= this.maxSessions;
      if (!overCap && !needRoom && idle <= this.idleEvictMs) break;
      if (live.has(meta.storeId)) continue;
      const reason = overCap || needRoom ? "session-cap" : `idle for ${Math.round(idle / 86_400_000)}d`;
      this.index.delete(meta.storeId);
      this.storeBytes = Math.max(0, this.storeBytes - meta.bytes);
      this.releaseSpool(meta.storeId);
      remaining -= 1;
      removed += 1;
      // Reported, because this deletes a user's whole transcript. Silently
      // pruning a session list looks identical to losing work.
      this.report("E_STORE_EVICTED", `pruned stored session ${meta.storeId} (${reason})`);
      void fsp
        .rm(this.dirFor(meta.storeId), { recursive: true, force: true })
        .catch(() => {});
    }
    return removed;
  }

  /**
   * Async because the meta write must be durable before the caller is told the
   * session exists. A fire-and-forget create lost the session to an immediate
   * rescan, a crash, or a second process, leaving an orphan directory that
   * rescan then skipped forever.
   */
  async create(input: CreateSessionInput): Promise<SessionSummary> {
    this.assertOpen();
    this.evict(true);
    if (this.index.size >= this.maxSessions) {
      throw new SessionStoreError(
        "E_STORE_QUOTA",
        `the session store holds its maximum of ${this.maxSessions} sessions`,
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
      title: sanitizeTitle(input.title ?? ""),
      createdAt: nowIso(nowMs),
      updatedAt: nowIso(nowMs),
      turnCount: 0,
      firstSeq: 0,
      lastSeq: 0,
      bytes: 0,
      truncated: false,
      titleSource: input.title === undefined ? "none" : "prompt",
      endedMidTurn: false,
    };
    try {
      await this.writeMeta(meta);
    } catch (cause) {
      // Refused rather than reported into existence: a summary for a session
      // that cannot be written is a session the user will never find again.
      throw cause instanceof SessionStoreError
        ? cause
        : new SessionStoreError("E_STORE_WRITABLE", `could not create the session: ${String(cause)}`);
    }
    this.index.set(meta.storeId, meta);
    return this.toSummary(meta);
  }

  /**
   * Appends one event. Never throws and never rejects into a caller: the emit
   * path in session-service.ts is synchronous, so an un-awaited fs rejection
   * here becomes an unhandledRejection and Node exits — measured exit code 1 on
   * ENOENT — taking every live harness child with it.
   *
   * The index is advanced synchronously and only the I/O is queued. A reader
   * that lands between two appends must see a consistent cursor, and a seq
   * derived from an asynchronously-updated counter would hand two rapid appends
   * the same number and leave a permanent gap after them.
   */
  append(storeId: string, event: ServerEvent): void {
    if (!this.ready) return;
    if (!isPersistedEventType(event.type)) return;
    const meta = this.index.get(storeId);
    // A write for an unknown id is dropped, never mkdir -p'd: a defensive
    // recreate would resurrect a session the user just deleted.
    if (meta === undefined) return;
    const writer = this.writerFor(storeId);
    if (writer.stopped) return;

    let line: string;
    let record: StoredEventRecord;
    try {
      record = {
        v: RECORD_VERSION,
        seq: meta.lastSeq + 1,
        ts: nowIso(this.now()),
        event,
      };
      const validated = StoredEventRecordSchema.parse(record);
      line = `${JSON.stringify(validated)}\n`;
    } catch (cause) {
      this.report("E_STORE_LINE_TOO_LONG", `refusing an unrecordable event: ${String(cause)}`);
      return;
    }

    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_LINE_BYTES) {
      this.report(
        "E_STORE_LINE_TOO_LONG",
        `dropped a ${bytes}-byte record over the ${MAX_LINE_BYTES}-byte cap`,
      );
      return;
    }
    if (meta.bytes + bytes > this.maxSessionBytes) {
      if (!writer.truncated) {
        writer.truncated = true;
        writer.stopped = true;
        meta.truncated = true;
        this.report(
          "E_STORE_QUOTA",
          `session ${storeId} reached its ${this.maxSessionBytes}-byte cap; the transcript is now a prefix`,
        );
        void this.flushMeta(storeId).catch(() => {});
      }
      return;
    }
    if (this.storeBytes + bytes > this.maxStoreBytes) {
      // Mirrors the per-session branch: the log is a prefix from here, and the
      // summary must say so. Silently dropping events while reporting a complete
      // transcript is how a user loses work without being told.
      if (!meta.truncated) {
        meta.truncated = true;
        void this.flushMeta(storeId).catch(() => {});
      }
      writer.stopped = true;
      this.report(
        "E_STORE_QUOTA",
        `the session store reached its ${this.maxStoreBytes}-byte cap; session ${storeId} is now a prefix`,
      );
      return;
    }

    writer.bytes += bytes;
    meta.bytes += bytes;
    this.storeBytes += bytes;
    meta.lastSeq = record.seq;
    if (meta.firstSeq === 0) meta.firstSeq = record.seq;
    meta.updatedAt = record.ts;
    if (event.type === "turn.completed") meta.turnCount += 1;

    const failedSeq = record.seq;
    // The queue body resolves the writer and the index at write time rather than
    // capturing them, so a rescan that replaces the index cannot leave a writer
    // mutating a detached object. It also never rejects, so one failure cannot
    // poison every append queued behind it.
    const run = async (): Promise<void> => {
      try {
        const live = this.writers.get(storeId);
        if (live === undefined) return;
        if (live.handle === null) {
          live.handle = await fsp.open(
            this.eventsPath(storeId),
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
            0o600,
          );
        }
        await live.handle.writeFile(line, "utf8");
      } catch (cause) {
        this.failWrite(storeId, failedSeq, cause);
      }
    };
    writer.queue = writer.queue.then(run, run);
  }

  /**
   * A write that failed leaves a hole that can never be repaired in place, so
   * the honest response is to stop the writer and say the log is a prefix.
   *
   * Rolling the index back to the seq of the record that actually failed — not
   * to the live lastSeq, which by then has already been handed to records still
   * queued behind it — is what stops the next append from reissuing a seq that
   * is already on disk.
   */
  private failWrite(storeId: string, failedSeq: number, cause: unknown): void {
    const writer = this.writers.get(storeId);
    if (writer !== undefined) {
      writer.handle = null;
      writer.truncated = true;
    }
    const meta = this.index.get(storeId);
    if (meta !== undefined) meta.truncated = true;
    this.report(
      "E_STORE_WRITABLE",
      `lost record ${failedSeq} of ${storeId}: ${String(cause)}`,
    );
  }

  /**
   * Applies a harness-supplied title to an already-recorded session.
   *
   * ACP agents auto-generate a title after the first exchange, and a stored
   * session with no title is a blank row in the sidebar forever. The value is
   * harness-influenced text, so it goes through the same sanitizer as a create.
   */
  setTitle(storeId: string, title: string, updatedAt?: string | null): void {
    const meta = this.index.get(storeId);
    if (meta === undefined) return;
    const sanitized = sanitizeTitle(title);
    if (sanitized !== meta.title) {
      meta.title = sanitized;
      meta.titleSource = "harness";
    }
    // The harness knows better than we do when it was last active, and the
    // sidebar orders by this. Only accepted when parseable, so a malformed
    // value cannot make the row un-evictable by age.
    if (typeof updatedAt === "string" && Number.isFinite(Date.parse(updatedAt))) {
      meta.updatedAt = updatedAt;
    }
    void this.flushMeta(storeId).catch(() => {});
  }

  /**
   * Falls back to the opening prompt when the harness never names the session.
   * Only the first prompt is used, so a long conversation does not rewrite its
   * own title on every turn.
   */
  titleFromPrompt(storeId: string, prompt: string): void {
    const meta = this.index.get(storeId);
    if (meta === undefined) return;
    // Gated on the flag rather than on the rendered string: comparing against the
    // placeholder meant a prompt of literally "Untitled task" re-armed this, and
    // turn two silently renamed the session.
    if (meta.titleSource !== "none") return;
    const sanitized = sanitizeTitle(prompt);
    if (sanitized === meta.title) return;
    meta.title = sanitized;
    meta.titleSource = "prompt";
    void this.flushMeta(storeId).catch(() => {});
  }

  /**
   * Makes the summary durable, so the sidebar sees a finished task.
   *
   * Serialised through the same queue as the appends, and snapshot only after it
   * drains. Awaiting the queue and then stringifying the live meta object wrote a
   * summary describing records whose lines were still queued, which on a power
   * loss left the meta permanently ahead of its own log.
   */
  async flushMeta(storeId: string): Promise<void> {
    const writer = this.writers.get(storeId);
    if (writer === undefined) {
      const meta = this.index.get(storeId);
      if (meta === undefined) return;
      try {
        await this.writeMeta({ ...meta });
      } catch (cause) {
        this.report("E_STORE_WRITABLE", `could not write meta: ${String(cause)}`);
      }
      return;
    }
    const run = async (): Promise<void> => {
      const meta = this.index.get(storeId);
      if (meta === undefined) return;
      try {
        await this.writeMeta({ ...meta });
      } catch (cause) {
        this.report("E_STORE_WRITABLE", `could not write meta: ${String(cause)}`);
      }
    };
    writer.queue = writer.queue.then(run, run);
    await writer.queue;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.writers.keys()].map((id) => this.flushMeta(id)));
  }

  list(): SessionSummary[] {
    // Ordered by the index's own sequence rather than by updatedAt, which a
    // concurrent write can move underneath the sort.
    const summaries = [...this.index.values()]
      .map((meta) => this.toSummary(meta))
      .sort((a, b) => b.lastSeq - a.lastSeq || b.updatedAt.localeCompare(a.updatedAt));
    return summaries.slice(0, MAX_LISTED_SESSIONS);
  }

  summary(storeId: string): SessionSummary | null {
    const meta = this.index.get(storeId);
    return meta === undefined ? null : this.toSummary(meta);
  }

  /**
   * The raw stored record, for callers that need more than the browser-facing
   * summary — the title's source, or whether a boot found an unclean end.
   */
  meta(storeId: string): MetaFile | null {
    return this.index.get(storeId) ?? null;
  }

  /** Just the fields continuation needs, and nothing about storage. */
  stored(
    storeId: string,
  ): { projectId: string; cwd: string; harnessSessionId: string } | null {
    const meta = this.index.get(storeId);
    if (meta === undefined) return null;
    return {
      projectId: meta.projectId,
      cwd: meta.cwd,
      harnessSessionId: meta.harnessSessionId,
    };
  }

  private toSummary(meta: MetaFile): SessionSummary {
    return SessionSummarySchema.parse({
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
    });
  }

  /**
   * Reads a page of records after `since`.
   *
   * Reads never mutate the log. Truncating a torn tail here is catastrophic:
   * with no newline written yet, "cut at the last newline" is offset zero, so a
   * plain GET would truncate the live log to nothing. The one place that repairs
   * a tail is repairTornTails, which runs at open with no writer attached.
   */
  async read(
    storeId: string,
    since: number | null,
    limit: number = MAX_EVENTS_PER_PAGE,
  ): Promise<SessionEventsResponse> {
    const meta = this.index.get(storeId);
    if (meta === undefined) {
      throw new SessionStoreError("E_STORE_UNKNOWN_SESSION", `no stored session ${storeId}`);
    }
    const cappedLimit = Math.max(1, Math.min(limit, MAX_EVENTS_PER_PAGE));
    const { firstSeq, lastSeq } = meta;
    // 0 is the "start over" cursor: it means everything after seq 0, which is
    // the whole log for any firstSeq. Every path that cannot serve the request
    // returns it, so a client following nextSince rehydrates from the start
    // rather than concluding it has caught up with a log it never read.
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
      // would be indistinguishable from caught-up, and the client would wait
      // forever.
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

    const scan = await this.readLines(storeId, from, lastSeq);
    const events: SessionEventsResponse["events"] = [];
    let dropped = scan.skipped + (scan.windowExceeded ? 1 : 0);
    let bytes = 0;
    let expected = from;
    let hasMore = false;
    let nextSince = since ?? startOver;
    for (const record of scan.records) {
      if (record.seq < expected) {
        // A log that steps backwards. The clamp keeps `dropped` non-negative:
        // a negative count failed the response schema and turned a readable
        // session into a permanent 500 from the API.
        dropped += 1;
        continue;
      }
      if (record.seq > expected) {
        // A gap is data loss. It is reported and stepped over rather than
        // aborting the page: one unreadable record must not make every page
        // empty, which left a client permanently unable to read its transcript.
        dropped += record.seq - expected;
        expected = record.seq;
      }
      const size = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (events.length >= cappedLimit || (events.length > 0 && bytes + size > MAX_PAGE_BYTES)) {
        hasMore = true;
        break;
      }
      events.push({ seq: record.seq, ts: record.ts, event: record.event });
      bytes += size;
      nextSince = record.seq;
      expected = record.seq + 1;
    }
    if (scan.sawPartialTail) dropped += 1;
    return {
      storeId,
      status: events.length === 0 && !hasMore ? (dropped > 0 ? "cursor-invalid" : "up-to-date") : "appended",
      firstSeq,
      lastSeq,
      nextSince,
      hasMore,
      dropped,
      events,
    };
  }

  private async readLines(
    storeId: string,
    fromSeq: number,
    lastSeq: number,
  ): Promise<{
    records: StoredEventRecord[];
    skipped: number;
    sawPartialTail: boolean;
    windowExceeded: boolean;
  }> {
    const empty = { records: [], skipped: 0, sawPartialTail: false, windowExceeded: false };
    const target = this.eventsPath(storeId);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(target, fs.constants.O_RDONLY);
    } catch (cause) {
      this.report("E_STORE_WRITABLE", `could not read ${storeId}: ${String(cause)}`);
      // The index says records exist, so an unreadable log is not "caught up".
      return { ...empty, skipped: this.index.get(storeId)?.lastSeq ?? 0 };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return empty;
      if (stat.size === 0) {
        const claimed = this.index.get(storeId)?.lastSeq ?? 0;
        if (claimed > 0) {
          this.report("E_STORE_WRITABLE", `log for ${storeId} is empty but the index claims ${claimed} records`);
          return { ...empty, skipped: claimed };
        }
        return empty;
      }
      // A log larger than the window means the tail is unreachable. Said out
      // loud, rather than returning a page that looks complete.
      if (stat.size > MAX_READ_WINDOW_BYTES) {
        this.report(
          "E_STORE_WRITABLE",
          `log for ${storeId} is ${stat.size} bytes, past the ${MAX_READ_WINDOW_BYTES}-byte read window`,
        );
        return { ...empty, skipped: lastSeq, windowExceeded: true };
      }
      const buffer = Buffer.allocUnsafe(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      // Everything after the final newline is an in-flight append and is not
      // yet a record.
      const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline);
      const sawPartialTail = lastNewline === -1 && bytesRead > 0;
      const records: StoredEventRecord[] = [];
      let skipped = 0;
      if (complete.length === 0) return { records, skipped, sawPartialTail, windowExceeded: false };
      for (const line of complete.split("\n")) {
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          skipped += 1;
          continue;
        }
        const result = StoredEventRecordSchema.safeParse(parsed);
        // An unreadable line is skipped and counted, not fatal: one bad record
        // must not hide the rest of the transcript.
        if (!result.success) {
          skipped += 1;
          continue;
        }
        if (result.data.seq < fromSeq) continue;
        if (result.data.seq > lastSeq) break;
        records.push(result.data);
      }
      return { records, skipped, sawPartialTail, windowExceeded: false };
    } finally {
      await handle.close();
    }
  }

  // --- attachments ---
  // k5 holds the bytes; the harness is handed a prompt block. Nothing here ever
  // lets a stored path reach the wire, because the manifest is the only thing the
  // turn carries and it names no file.

  /**
   * Writes one attachment into the session's spool and returns the manifest k5
   * will believe about it.
   *
   * `kind` and `size` are derived from the bytes the server just received, never
   * from what the client claimed in `?mime=`: a client that says "text/plain"
   * about a binary would otherwise make the harness inline garbage as text, and
   * the durable transcript would record a size that never arrived. Only `name`
   * is the client's, because only the client knows it.
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
    const dir = await this.liveSessionDir(storeId);
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new SessionStoreError(
        "E_STORE_QUOTA",
        `an attachment of ${input.bytes.length} bytes is over the ${MAX_ATTACHMENT_BYTES}-byte cap`,
      );
    }
    // Checked against the whole-store ceiling rather than only the per-file cap:
    // spooled bytes are not events, so they never reach the log's own accounting
    // and would otherwise be the only thing in the store nothing bounds.
    if (this.storeBytes + input.bytes.length > this.maxStoreBytes) {
      throw new SessionStoreError(
        "E_STORE_QUOTA",
        `the session store reached its ${this.maxStoreBytes}-byte cap; ${storeId} has no room for an attachment`,
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
    for (const sub of [ATTACHMENT_BYTES_DIR, ATTACHMENT_MANIFEST_DIR]) {
      await fsp.mkdir(path.join(dir, sub), { recursive: true, mode: 0o700 });
    }
    try {
      await this.publishFile(this.attachmentPath(storeId, input.attachmentId), input.bytes);
      await this.publishFile(
        this.attachmentManifestPath(storeId, input.attachmentId),
        `${JSON.stringify(manifest.data)}\n`,
      );
    } catch (cause) {
      throw cause instanceof SessionStoreError
        ? cause
        : new SessionStoreError(
            "E_STORE_WRITABLE",
            `could not spool an attachment for ${storeId}: ${String(cause)}`,
          );
    }
    // Accrued only after both files are published, so a failed write charges
    // nothing. The manifest is charged with the bytes because it shares the disk.
    const charged = manifest.data.size + Buffer.byteLength(`${JSON.stringify(manifest.data)}\n`);
    this.storeBytes += charged;
    this.spoolBytes.set(storeId, (this.spoolBytes.get(storeId) ?? 0) + charged);
    return manifest.data;
  }

  /** Gives a session's spooled bytes back to the store budget. */
  private releaseSpool(storeId: string): void {
    const held = this.spoolBytes.get(storeId);
    if (held === undefined) return;
    this.storeBytes = Math.max(0, this.storeBytes - held);
    this.spoolBytes.delete(storeId);
  }

  /**
   * The manifest a spooled attachment was stored under, keyed by the id alone.
   *
   * The browser names an attachment by id, so this is the only way the name and
   * mime it was given at upload can reach the turn that uses it. It is re-read
   * rather than remembered: an in-memory table would lose every attachment across
   * a restart, and the turn would then silently run without the bytes the user
   * attached.
   */
  async attachmentManifest(
    storeId: string,
    attachmentId: string,
  ): Promise<AttachmentManifestEntry> {
    // The path is resolved outside the try, so a refused id stays a path refusal
    // rather than being reported as an attachment that is merely not there.
    const target = this.attachmentManifestPath(storeId, attachmentId);
    let text: string;
    try {
      text = await fsp.readFile(target, "utf8");
    } catch (cause) {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_ATTACHMENT",
        `no attachment ${attachmentId} in session ${storeId}: ${String(cause)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_ATTACHMENT",
        `the manifest for ${attachmentId} is unreadable: ${String(cause)}`,
      );
    }
    const manifest = AttachmentManifestEntrySchema.safeParse(parsed);
    if (!manifest.success) {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_ATTACHMENT",
        `the manifest for ${attachmentId} is not in the expected shape`,
      );
    }
    return manifest.data;
  }

  async readAttachment(storeId: string, attachmentId: string): Promise<Buffer> {
    const target = this.attachmentPath(storeId, attachmentId);
    try {
      return await fsp.readFile(target);
    } catch (cause) {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_ATTACHMENT",
        `no attachment ${attachmentId} in session ${storeId}: ${String(cause)}`,
      );
    }
  }

  /** The reverse state for an upload that was never used. */
  async discardAttachment(storeId: string, attachmentId: string): Promise<boolean> {
    const target = this.attachmentPath(storeId, attachmentId);
    let existed = true;
    let charged = 0;
    try {
      // The size is read before the unlink, because afterwards there is nothing
      // left to measure and the store would keep charging for bytes it no longer
      // has on disk.
      const stat = await fsp.stat(target);
      existed = true;
      charged = stat.size;
      try {
        const manifest = await this.attachmentManifest(storeId, attachmentId);
        charged += Buffer.byteLength(`${JSON.stringify(manifest)}\n`);
      } catch {
        // The bytes are gone either way; charging only the payload is better than
        // charging nothing and drifting high.
      }
    } catch {
      existed = false;
    }
    await fsp.rm(target, { force: true });
    await fsp.rm(this.attachmentManifestPath(storeId, attachmentId), { force: true });
    if (charged > 0) {
      this.storeBytes = Math.max(0, this.storeBytes - charged);
      this.spoolBytes.set(storeId, Math.max(0, (this.spoolBytes.get(storeId) ?? 0) - charged));
    }
    return existed;
  }

  private async liveSessionDir(storeId: string): Promise<string> {
    if (this.index.get(storeId) === undefined) {
      throw new SessionStoreError("E_STORE_UNKNOWN_SESSION", `no stored session ${storeId}`);
    }
    const dir = this.dirFor(storeId);
    // Stat, never mkdir -p: spooling into a session the user deleted would be a
    // deleted session quietly back, which is the same resurrection `append`
    // refuses at the index lookup.
    try {
      await fsp.stat(dir);
    } catch {
      throw new SessionStoreError(
        "E_STORE_UNKNOWN_SESSION",
        `stored session ${storeId} has no directory on disk`,
      );
    }
    return dir;
  }

  /**
   * Publishes a file by rename, so a reader never sees half of one.
   *
   * The temp name is unpredictable and opened O_EXCL, for the same reason
   * writeMeta's is: a harness running agent-supplied code shares this uid, so a
   * predictable temp name is an arbitrary-file-overwrite primitive. A torn
   * attachment would be worse than a missing one, because the manifest says it
   * is there.
   */
  private async publishFile(target: string, contents: Buffer | string): Promise<void> {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const tmp = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${randomUUID()}.tmp`,
    );
    const handle = await fsp.open(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(tmp, target);
    } catch (cause) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw cause;
    }
  }

  /** Removes k5's own record. Never touches the harness's session. */
  async remove(storeId: string): Promise<boolean> {
    const meta = this.index.get(storeId);
    if (meta === undefined) return false;
    // Removed from the index first, so a concurrent append is refused at the
    // index lookup and can never recreate what we are about to delete.
    this.index.delete(storeId);
    this.storeBytes = Math.max(0, this.storeBytes - meta.bytes);
    this.releaseSpool(storeId);
    const writer = this.writers.get(storeId);
    if (writer !== undefined) {
      writer.stopped = true;
      await writer.queue;
      if (writer.handle !== null) {
        await writer.handle.close().catch(() => {});
        writer.handle = null;
      }
      this.writers.delete(storeId);
    }
    await fsp.rm(this.dirFor(storeId), { recursive: true, force: true });
    return true;
  }

  /** Closes every open handle. A closed handle must not accept another append. */
  async close(): Promise<void> {
    for (const [id, writer] of this.writers) {
      writer.stopped = true;
      await writer.queue;
      if (writer.handle !== null) {
        await writer.handle.close().catch(() => {});
        writer.handle = null;
      }
      this.writers.delete(id);
    }
    this.ready = false;
  }
}

export type { ReplayStatus };

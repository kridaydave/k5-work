import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AttachmentIdSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_EVENTS_PER_PAGE,
  SessionEventsResponseSchema,
  SessionListResponseSchema,
  UploadedAttachmentSchema,
  type SessionEventsResponse,
} from "@k5-work/shared";
import { SessionStoreError, type SessionStoreErrorCode } from "./store/errors.js";
import { isSafeNameSegment } from "./store/safe-name.js";
import { SessionStore } from "./store/session-store.js";
import { REQUEST_TIMEOUT_MS } from "./env.js";

// Read side of the durable store, over HTTP. Bulk history does not belong on the
// websocket: that channel caps a frame at 64 KiB, and a transcript is bulk data.
// /api/projects already established HTTP as the shape for a bulk read.

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

/** 413, which no store code maps to: an over-cap body never reaches the store. */
const STATUS_TOO_LARGE = 413;

/** 408, for an upload that stopped arriving. Never reaches the store either. */
const STATUS_TIMEOUT = 408;

/** A store fault the browser can render. Anything else is a 500 with no detail. */
const STATUS_BY_CODE: Record<SessionStoreErrorCode, number> = {
  E_STORE_PATH_ESCAPE: 500,
  E_STORE_META_CORRUPT: 500,
  E_STORE_CORRUPT_RECORD: 500,
  E_STORE_CORRUPT_LOG: 503,
  E_STORE_LINE_TOO_LONG: 500,
  E_STORE_WRITABLE: 503,
  E_STORE_QUOTA: 507,
  E_STORE_EVICTED: 500,
  E_STORE_UNKNOWN_SESSION: 404,
  E_STORE_UNKNOWN_ATTACHMENT: 404,
  E_STORE_ROOT: 500,
};

const MESSAGE_BY_CODE: Record<SessionStoreErrorCode, string> = {
  E_STORE_PATH_ESCAPE: "The session store path was refused",
  E_STORE_META_CORRUPT: "A stored session could not be read",
  E_STORE_CORRUPT_RECORD: "A recorded event was not in the expected shape",
  E_STORE_CORRUPT_LOG: "A stored transcript could not be read back",
  E_STORE_LINE_TOO_LONG: "A recorded event was too large to store",
  E_STORE_WRITABLE: "The session store is not writable",
  E_STORE_QUOTA: "The session store is full",
  E_STORE_EVICTED: "A stored session was pruned",
  E_STORE_UNKNOWN_SESSION: "No such stored session",
  E_STORE_UNKNOWN_ATTACHMENT: "No such attachment",
  E_STORE_ROOT: "The session store root is unusable",
};

export function isSessionApiPath(pathname: string): boolean {
  return pathname === "/api/sessions" || pathname.startsWith("/api/sessions/");
}

/**
 * k5 mints store ids as UUIDs, so a path segment that is not one is refused
 * before it reaches the filesystem. This is a cheap second gate: the store
 * derives its own directory from the id, and never from a caller-supplied string.
 */
function isStoreIdSegment(segment: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment);
}

/** Percent-decoding a malformed segment is a client error, not a store fault. */
function decodeStoreId(rawId: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  return isStoreIdSegment(decoded) ? decoded.toLowerCase() : null;
}

/**
 * The same gates the store applies, run at the edge so a hostile id is a 400
 * rather than a 500 from deep inside a write.
 *
 * The separator check is not redundant with the safe-name predicate: that one
 * judges a single path segment by design, and a value taken from a URL can still
 * carry one.
 */
function decodeAttachmentId(rawId: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (decoded.includes("/") || decoded.includes("\\")) return null;
  return AttachmentIdSchema.safeParse(decoded).success && isSafeNameSegment(decoded)
    ? decoded
    : null;
}

function parseSince(raw: string | null): number | null | "invalid" {
  if (raw === null || raw === "") return null;
  if (!/^\d{1,15}$/.test(raw)) return "invalid";
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return "invalid";
  return value;
}

function parseLimit(raw: string | null): number {
  if (raw === null || !/^\d{1,6}$/.test(raw)) return MAX_EVENTS_PER_PAGE;
  const value = Number(raw);
  if (value < 1) return 1;
  return Math.min(value, MAX_EVENTS_PER_PAGE);
}

/**
 * The upload's identity, which travels in the query because the body is the file
 * itself — not JSON, not multipart, and not base64, which would add a third again
 * to a 25 MB cap and buy nothing.
 */
const UploadQuerySchema = z.object({
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(120),
});

/**
 * How long an upload may take end to end. Must not exceed the app's own
 * `requestTimeout`, or Node closes the socket before this timer fires and the
 * client sees a truncated connection rather than the 408 below.
 */
const UPLOAD_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

/**
 * Reads the body, refusing the moment it is over the cap rather than after it has
 * been buffered: an unbounded read is how a 25 MB limit becomes an
 * out-of-memory crash.
 *
 * An over-cap body is drained rather than cut. Destroying the socket would take
 * the 413 down with it, so a client that streams without a Content-Length — which
 * is most of them — would see a reset instead of the reason it was refused. The
 * app's own requestTimeout is what bounds a client that keeps streaming.
 */
function readCappedBody(
  req: IncomingMessage,
  cap: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; refused: "too-large" | "stalled" }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: { ok: true; bytes: Buffer } | { ok: false; refused: "too-large" | "stalled" }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onEnd);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > cap) {
        chunks.length = 0;
        finish({ ok: false, refused: "too-large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      finish({ ok: true, bytes: Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => {
      chunks.length = 0;
      finish({ ok: false, refused: "stalled" });
      req.destroy();
    }, UPLOAD_TIMEOUT_MS);
    timer.unref();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onEnd);
  });
}

export interface SessionApiOptions {
  readonly store: SessionStore;
}

export function handleSessionApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  options: SessionApiOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://k5-work.invalid");
  } catch {
    sendJson(res, 400, { error: "Invalid request URL" });
    return Promise.resolve();
  }
  const pathname = url.pathname;
  if (!isSessionApiPath(pathname)) {
    next();
    return Promise.resolve();
  }
  const store = options.store;

  const failWith = (cause: unknown): void => {
    if (cause instanceof SessionStoreError) {
      sendJson(res, STATUS_BY_CODE[cause.code] ?? 500, {
        error: MESSAGE_BY_CODE[cause.code] ?? "The session store failed",
      });
      return;
    }
    // A response the store produced that no longer satisfies the contract is a
    // store fault, not an anonymous 500: it is logged and answered as one, so an
    // operator can see which session is unreadable.
    process.stderr.write(
      `k5 session store produced an unreadable response: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
    sendJson(res, 503, { error: "A stored transcript could not be read back" });
  };

  return (async () => {
    try {
      if (pathname === "/api/sessions" || pathname === "/api/sessions/") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        // Bounded by MAX_LISTED_SESSIONS inside the store, so the response cannot
        // grow without limit as the workspace accumulates sessions.
        //
        // `q` turns the same read into a search, and the response is the same
        // shape either way: rows, and a snippets array on each row that only a
        // search fills. An empty search never falls back to the full list.
        const query = new URL(req.url ?? "/", "http://k5.invalid").searchParams.get("q");
        const sessions = query === null ? store.list() : store.search(query);
        const body = SessionListResponseSchema.parse({ sessions });
        sendJson(res, 200, body);
        return;
      }

      const rest = pathname.slice("/api/sessions/".length);
      const slash = rest.indexOf("/");
      const rawId = slash === -1 ? rest : rest.slice(0, slash);
      const tail = slash === -1 ? "" : rest.slice(slash + 1);
      const storeId = decodeStoreId(rawId);
      if (storeId === null) {
        sendJson(res, 400, { error: "Malformed session id" });
        return;
      }

      if (tail === "" || tail === "events" || tail === "summary") {
        if (req.method === "DELETE") {
          // The reverse state for a durable store. Without it a user can never
          // remove a session, and AGENTS.md is explicit that a one-way door is a
          // bug: the store would accumulate transcripts with no way out.
          if (tail !== "") {
            // A sub-resource is read-only even though its parent is deletable, so
            // it must not inherit the parent's Allow. Advertising DELETE on
            // `/events` tells a client something this route will refuse.
            res.setHeader("Allow", "GET");
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          res.setHeader("Allow", "GET, DELETE");
          const removed = await store.remove(storeId);
          if (!removed) {
            sendJson(res, 404, { error: "No such stored session" });
            return;
          }
          // 204: the resource is gone and there is nothing useful to say.
          res.statusCode = 204;
          res.setHeader("Cache-Control", "no-store");
          res.end();
          return;
        }
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, DELETE");
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        if (tail === "summary") {
          const summary = store.summary(storeId);
          if (summary === null) {
            sendJson(res, 404, { error: "No such stored session" });
            return;
          }
          sendJson(res, 200, summary);
          return;
        }
        const since = parseSince(url.searchParams.get("since"));
        if (since === "invalid") {
          // Malformed, as opposed to well-formed-but-impossible: that is a 400
          // here and a 200 with status "cursor-invalid" in the body.
          sendJson(res, 400, { error: "since must be a non-negative integer" });
          return;
        }
        const page: SessionEventsResponse = await store.read(
          storeId,
          since,
          parseLimit(url.searchParams.get("limit")),
        );
        sendJson(res, 200, SessionEventsResponseSchema.parse(page));
        return;
      }

      // --- attachments ---
      // Both directions, so an upload is never a one-way door: what a user
      // attached and then changed their mind about can be dropped without
      // deleting the whole task.
      if (tail === "attachments" || tail.startsWith("attachments/")) {
        if (tail === "attachments") {
          if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const query = UploadQuerySchema.safeParse({
            name: url.searchParams.get("name"),
            mime: url.searchParams.get("mime"),
          });
          if (!query.success) {
            sendJson(res, 400, { error: "name and mime are required" });
            return;
          }
          // Refused on the declared length before a byte is read, so an
          // over-cap upload is a 413 rather than a 25 MB allocation.
          const declared = req.headers["content-length"];
          if (declared !== undefined && Number(declared) > MAX_ATTACHMENT_BYTES) {
            sendJson(res, STATUS_TOO_LARGE, { error: "The attachment is too large" });
            return;
          }
          const body = await readCappedBody(req, MAX_ATTACHMENT_BYTES);
          if (!body.ok) {
            // Distinct codes, because the two have different repairs: too large
            // means pick a smaller file, stalled means try again.
            sendJson(
              res,
              body.refused === "too-large" ? STATUS_TOO_LARGE : STATUS_TIMEOUT,
              {
                error:
                  body.refused === "too-large"
                    ? "The attachment is too large"
                    : "The upload stalled before it finished",
              },
            );
            return;
          }
          // Minted here, never taken from the request: the id becomes a filename
          // in the spool, and a browser that chose it would be choosing a path.
          const manifest = await store.spoolAttachment(storeId, {
            attachmentId: randomUUID(),
            name: query.data.name,
            mimeType: query.data.mime,
            bytes: body.bytes,
          });
          sendJson(res, 200, UploadedAttachmentSchema.parse(manifest));
          return;
        }
        const attachmentId = decodeAttachmentId(tail.slice("attachments/".length));
        if (attachmentId === null) {
          sendJson(res, 400, { error: "Malformed attachment id" });
          return;
        }
        if (req.method !== "DELETE") {
          res.setHeader("Allow", "DELETE");
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        const discarded = await store.discardAttachment(storeId, attachmentId);
        if (!discarded) {
          sendJson(res, 404, { error: "No such attachment" });
          return;
        }
        res.statusCode = 204;
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }

      sendJson(res, 404, { error: "Session API route not found" });
    } catch (cause) {
      failWith(cause);
    }
  })();
}

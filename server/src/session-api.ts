import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MAX_EVENTS_PER_PAGE,
  SessionEventsResponseSchema,
  SessionListResponseSchema,
  type SessionEventsResponse,
} from "@k5-work/shared";
import { SessionStoreError, type SessionStoreErrorCode } from "./store/errors.js";
import { SessionStore } from "./store/session-store.js";

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
        }        // Bounded by MAX_LISTED_SESSIONS inside the store, so the response cannot
        // grow without limit as the workspace accumulates sessions.
        const body = SessionListResponseSchema.parse({ sessions: store.list() });
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
          res.setHeader("Allow", "GET, DELETE");
          if (tail !== "") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
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

      sendJson(res, 404, { error: "Session API route not found" });
    } catch (cause) {
      failWith(cause);
    }
  })();
}

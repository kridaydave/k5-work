import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_EVENTS_PER_PAGE,
  SessionEventsResponseSchema,
  SessionListResponseSchema,
  projectTranscript,
  type ProjectedTranscript,
  type SessionEventsResponse,
  type SessionSummary,
  type StoredEventSchema,
} from "@k5-work/shared";
import type { z } from "zod";
type StoredEvent = z.infer<typeof StoredEventSchema>;

// The read side of the durable store.
//
// Bulk history does not belong on the websocket: that channel caps a frame at
// 64 KiB, and a transcript is bulk data. These are plain HTTP calls with no
// harness process involved, so the sidebar can be populated on a machine with no
// ACP command configured at all.

export interface StoredTranscript {
  readonly transcript: ProjectedTranscript;
  /** The cursor to send for the next page, or null once fully read. */
  readonly nextSince: number | null;
  /** True when the store said its cursor could not be honoured. */
  readonly rehydrateRequired: boolean;
}

export interface StoredSessionState {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  remove: (storeId: string) => Promise<boolean>;
}

export function useStoredSessions(): StoredSessionState {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Guards against a slow response overwriting a newer one.
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/sessions", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`the server answered ${String(response.status)}`);
        const parsed = SessionListResponseSchema.parse(await response.json());
        if (request !== latest.current) return;
        setSessions(parsed.sessions);
        setError(null);
      } catch (cause) {
        if (request !== latest.current) return;
        setSessions([]);
        setError(
          cause instanceof Error ? cause.message : "Stored tasks could not be read",
        );
      } finally {
        if (request === latest.current) setLoading(false);
      }
    })();
    return () => {
      // Invalidate this response without cancelling the fetch, so an aborted
      // render cannot leave a late answer applying to new state.
      latest.current += 1;
    };
  }, [nonce]);

  const remove = useCallback(async (storeId: string): Promise<boolean> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(storeId)}`, {
      method: "DELETE",
    });
    if (response.status === 204) {
      setSessions((current) => current.filter((entry) => entry.storeId !== storeId));
      return true;
    }
    return false;
  }, []);

  return {
    sessions,
    loading,
    error,
    refresh: useCallback(() => setNonce((value) => value + 1), []),
    remove,
  };
}

/** Enough pages for a log at the store's 12 MiB cap; past this it is a prefix. */
const MAX_TRANSCRIPT_PAGES = 64;

function parsedLastSeq(bySeq: Map<number, StoredEvent>): number | null {
  let last: number | null = null;
  for (const seq of bySeq.keys()) if (last === null || seq > last) last = seq;
  return last;
}

function isUnrecorded(storeId: string | null | undefined): boolean {
  // The server sends the all-zero id when no recorder is wired, so the browser
  // never has to distinguish "missing" from "not recorded".
  // The sentinel is an all-zero UUID apart from the version and variant nibbles,
  // so the tail is what identifies it rather than every group being zero.
  return (
    storeId === null ||
    storeId === undefined ||
    /^0{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{12}$/.test(storeId)
  );
}

/**
 * Reads a stored transcript, paging until the store says there is no more.
 *
 * The four replay states are honoured explicitly: `cursor-too-old` and
 * `cursor-invalid` both mean the client's cursor cannot be used, so the read
 * restarts from the beginning rather than silently returning a partial history.
 */
export async function readStoredTranscript(
  storeId: string,
  options: { readonly since?: number | null } = {},
): Promise<StoredTranscript> {
  if (isUnrecorded(storeId)) {
    return { transcript: projectTranscript([]), nextSince: null, rehydrateRequired: false };
  }
  // Keyed by seq, so a store that reports hasMore with a cursor that has stopped
  // advancing cannot duplicate records: the page bound stops the loop and the
  // keying makes a repeat a no-op. A cursor comparison cannot do this, because a
  // first request has no previous cursor to compare against.
  const bySeq = new Map<number, StoredEvent>();
  let since: number | null = options.since ?? null;
  let nextSince: number | null = options.since ?? null;
  let rehydrateRequired = false;
  let truncated = false;
  let dropped = 0;
  let restarted = false;

  for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(MAX_EVENTS_PER_PAGE) });
    if (since !== null) query.set("since", String(since));
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(storeId)}/events?${query.toString()}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw new Error(`the transcript could not be read (${String(response.status)})`);
    const parsed: SessionEventsResponse = SessionEventsResponseSchema.parse(await response.json());

    // A cursor the store will not honour means its idea of the log and this
    // client's disagree. Read from the beginning, once. The discard is deferred
    // until that restart actually returns a usable page: clearing eagerly and
    // then finding the restart also refused the cursor erased a full transcript
    // and left nothing to report, which is how a readable session came back empty.
    if (parsed.status === "cursor-too-old" || parsed.status === "cursor-invalid") {
      if (restarted || since === null) {
        truncated = true;
        rehydrateRequired = true;
        break;
      }
      restarted = true;
      rehydrateRequired = true;
      since = null;
      continue;
    }

    if (restarted) {
      // The restart worked, so what came before it was read against a cursor the
      // store has disowned.
      bySeq.clear();
      dropped = 0;
      restarted = false;
    }
    for (const event of parsed.events) bySeq.set(event.seq, event);
    dropped += parsed.dropped;
    nextSince = parsed.nextSince;
    since = parsed.nextSince;
    if (!parsed.hasMore) break;
    if (parsed.nextSince === null) break;
    if (parsed.events.length === 0) break;
  }

  // Anything still unread once the page budget is gone is a prefix, and the
  // caller has to be able to tell that from a complete history.
  if (since !== null) {
    const last = parsedLastSeq(bySeq);
    if (last !== null && nextSince !== null && nextSince < last) truncated = true;
    if (bySeq.size === MAX_EVENTS_PER_PAGE * MAX_TRANSCRIPT_PAGES) truncated = true;
  }

  const records = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  return {
    transcript: projectTranscript(
      records.map((record) => ({ v: 1 as const, seq: record.seq, ts: record.ts, event: record.event })),
      { truncated, dropped },
    ),
    nextSince,
    rehydrateRequired,
  };
}

export { isUnrecorded };

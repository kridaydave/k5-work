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

/** One page from the store. I/O only; it makes no policy decision. */
async function readPage(storeId: string, since: number | null): Promise<SessionEventsResponse> {
  const query = new URLSearchParams({ limit: String(MAX_EVENTS_PER_PAGE) });
  if (since !== null) query.set("since", String(since));
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(storeId)}/events?${query.toString()}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`the transcript could not be read (${String(response.status)}`);
  return SessionEventsResponseSchema.parse(await response.json());
}

/**
 * The cursor and restart policy, as a state machine.
 *
 * This was one function with eleven branches, and it is where both bugs this
 * reader ever had lived: an eager clear that erased a full transcript, then a
 * second refusal that re-erased it. The states are named now and the only way out
 * of a refusal is the single restart, so "how many times may this happen" is a
 * property of the machine rather than a detail of the loop wrapped around it.
 */
class TranscriptCursor {
  private readonly bySeq = new Map<number, StoredEvent>();
  private since: number | null;
  private nextSince: number | null;
  private dropped = 0;
  private truncated = false;
  private restarted = false;
  /** Set when the store disowned a cursor, which is a hard signal to rehydrate. */
  rehydrateRequired = false;

  constructor(since: number | null) {
    this.since = since;
    this.nextSince = since;
  }

  /** The cursor the next request should carry. */
  get cursor(): number | null {
    return this.since;
  }

  /** Absorbs one page. Returns false when there is nothing left worth asking for. */
  accept(page: SessionEventsResponse): boolean {
    if (page.status === "cursor-too-old" || page.status === "cursor-invalid") {
      this.rehydrateRequired = true;
      // With no cursor of our own the store is refusing the start of the log, and
      // asking again cannot help. Report what was read as a prefix and stop.
      if (this.restarted || this.since === null) {
        this.truncated = true;
        return false;
      }
      // The discard is deliberately NOT here. It happens when a restart returns a
      // usable page and not before: clearing now, then finding the restart also
      // refused, erased a full transcript and left nothing to report.
      this.restarted = true;
      this.since = null;
      return true;
    }

    if (this.restarted) {
      this.bySeq.clear();
      this.dropped = 0;
      this.restarted = false;
    }
    for (const event of page.events) this.bySeq.set(event.seq, event);
    this.dropped += page.dropped;
    this.nextSince = page.nextSince;
    this.since = page.nextSince;
    // A page that claims more but carries nothing, or carries nothing to page
    // past, is a store that will not advance. Continuing re-requests the same
    // cursor until the page bound, so stop and call what we have a prefix.
    if (!page.hasMore) return false;
    if (page.nextSince === null) {
      this.truncated = true;
      return false;
    }
    if (page.events.length === 0) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  /**
   * Closes the read. `budgetExhausted` is true when the page bound ended the
   * loop rather than the store.
   */
  finish(budgetExhausted: boolean): {
    records: StoredEvent[];
    nextSince: number | null;
    truncated: boolean;
    dropped: number;
  } {
    if (budgetExhausted) {
      // Anything still unread once the budget is gone is a prefix, and the caller
      // has to be able to tell that from a complete history.
      const last = parsedLastSeq(this.bySeq);
      if (last !== null && this.nextSince !== null && this.nextSince < last) this.truncated = true;
      if (this.bySeq.size === MAX_EVENTS_PER_PAGE * MAX_TRANSCRIPT_PAGES) this.truncated = true;
    }
    return {
      records: [...this.bySeq.values()].sort((a, b) => a.seq - b.seq),
      nextSince: this.nextSince,
      truncated: this.truncated,
      dropped: this.dropped,
    };
  }
}

/**
 * Reads a stored transcript, paging until the store says there is no more.
 *
 * The four replay states are honoured explicitly: `cursor-too-old` and
 * `cursor-invalid` both mean the client's cursor cannot be used, so the read
 * restarts from the beginning rather than silently returning partial history.
 *
 * Records are keyed by seq, so a store that reports hasMore with a cursor that
 * has stopped advancing cannot duplicate them: the page bound stops the loop and
 * the keying makes a repeat a no-op. A cursor comparison cannot do this, because
 * a first request has no previous cursor to compare against.
 */
export async function readStoredTranscript(
  storeId: string,
  options: { readonly since?: number | null } = {},
): Promise<StoredTranscript> {
  if (isUnrecorded(storeId)) {
    return { transcript: projectTranscript([]), nextSince: null, rehydrateRequired: false };
  }
  const cursor = new TranscriptCursor(options.since ?? null);
  let budgetExhausted = true;
  for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
    if (!cursor.accept(await readPage(storeId, cursor.cursor))) {
      budgetExhausted = false;
      break;
    }
  }
  const read = cursor.finish(budgetExhausted);
  return {
    transcript: projectTranscript(
      read.records.map((record) => ({ v: 1 as const, seq: record.seq, ts: record.ts, event: record.event })),
      { truncated: read.truncated, dropped: read.dropped },
    ),
    nextSince: read.nextSince,
    rehydrateRequired: cursor.rehydrateRequired,
  };
}

export { isUnrecorded };

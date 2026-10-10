import { z } from "zod";
import {
  ServerEventSchema,
  StopReasonSchema,
  ToolLifecycleSchema,
  ToolStatusSchema,
  type AttachmentManifestEntry,
  type ServerEvent,
  type ServerEventType,
  type StopReason,
  type ToolLifecycle,
  type ToolStatus,
} from "./contracts.js";
import type { TranscriptEntry } from "./reducer.js";
import { StoreIdSchema } from "./contracts.js";

// Read side of the durable session store. The browser wire contract in
// contracts.ts is the live channel and is deliberately unchanged: nothing here
// adds a field to a command or an event. Persistence wraps each event in a
// record so the stored shape can carry a sequence number without the wire
// having to.

// k5 mints this. The harness session id is opaque, harness-controlled, up to
// 256 chars, and is never used as a path component or as a browser-facing
// identity, because two harnesses can return the same id. Declared in
// contracts.ts, which does not depend on this module, and re-exported here so
// both halves of the boundary are reachable from one place.
export { StoreIdSchema, type StoreId } from "./contracts.js";

export const RECORD_VERSION = 1;

/**
 * Only session-scoped variants are persisted. `command.result` correlates a
 * browser command rather than session history, and `connection.closed` and
 * `error` carry no session at all — so they cannot be filed under a session,
 * and replaying the first would pin the browser's connection state shut.
 */
export const PERSISTED_EVENT_TYPES = [
  "session.opened",
  "session.configured",
  "session.closed",
  "session.failed",
  "session.updated",
  "session.loaded",
  "turn.started",
  "turn.delta",
  "tool.updated",
  "turn.completed",
  "seat.reaped",
] as const;
export type PersistedEventType = (typeof PERSISTED_EVENT_TYPES)[number];

const persistedTypeSet: ReadonlySet<string> = new Set(PERSISTED_EVENT_TYPES);

export function isPersistedEventType(type: ServerEventType): type is PersistedEventType {
  return persistedTypeSet.has(type);
}

export const StoredEventRecordSchema = z
  .object({
    v: z.literal(RECORD_VERSION),
    // 1-based and gapless. A gap means a lost write, which is reported to the
    // client as data loss rather than being read as "no new events".
    seq: z.number().int().positive(),
    ts: z.string().min(1).max(64),
    event: ServerEventSchema,
  })
  .strict();
export type StoredEventRecord = z.infer<typeof StoredEventRecordSchema>;

// A timestamp is harness- or clock-supplied on the way back in, so it is a
// display string, never a key and never an ordering authority.
export const IsoTimestampSchema = z.string().min(1).max(64);
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const SessionSummarySchema = z
  .object({
    storeId: StoreIdSchema,
    // Harness-supplied text reaches the sidebar, so it is stripped and
    // grapheme-truncated before it is ever written.
    title: z.string().min(1).max(200),
    projectId: z.string().min(1).max(256),
    projectName: z.string().min(1).max(200).nullable(),
    cwd: z.string().min(1).max(4096),
    harness: z.string().min(1).max(64),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    turnCount: z.number().int().nonnegative(),
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    // The reverse of a stored transcript: the log hit its byte cap, so what is
    // on disk is a prefix. The UI has to say so rather than imply completeness.
    truncated: z.boolean(),
    /**
     * Records the store refused to keep in a way that left no gap behind, so a
     * reader cannot notice the loss by comparing sequences. Separate from
     * `truncated` because the session kept accepting appends: this is a
     * transcript with a hole in it, not a prefix that stopped growing.
     */
    droppedRecords: z.number().int().nonnegative(),
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const MAX_LISTED_SESSIONS = 500;

/**
 * The longest a search query may be, trimmed. A query longer than this is a
 * paste, not a question, and it is refused at the boundary rather than
 * searched: every session's payload is scanned per candidate.
 */
export const MAX_QUERY_CHARS = 200;

/** A search query as it arrives on the wire: trimmed, and bounded. */
export const SessionQuerySchema = z.string().trim().min(1).max(MAX_QUERY_CHARS);
export type SessionQuery = z.infer<typeof SessionQuerySchema>;

/** The longest a snippet runs before it is cut with an ellipsis at either end. */
export const SNIPPET_CHARS = 200;

/** Snippets per matching session. Enough to tell two threads apart, no more. */
export const MAX_SNIPPETS_PER_SESSION = 3;

/**
 * One matched line out of a stored transcript.
 *
 * Carries the record's sequence and timestamp so a client can name the turn the
 * hit came from, and the trimmed text itself. `role` is which side of the
 * conversation it came from, which is what tells two threads that share a phrase
 * apart: one asked for it, the other said it.
 *
 * Messages only. Tool calls are not searched, because "which task read this
 * file" is a different question from "which task was about this", and the second
 * is the one a transcript search is for.
 */
export const SessionSnippetSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: IsoTimestampSchema,
    role: z.enum(["prompt", "reply"]),
    text: z.string().min(1).max(SNIPPET_CHARS),
  })
  .strict();
export type SessionSnippet = z.infer<typeof SessionSnippetSchema>;

/**
 * The list response, whatever produced it.
 *
 * Rows are `SessionSearchRow`, not `SessionSummary`, because a search and a
 * list share this shape and the search is the one that fills `snippets`. A row
 * from a plain list simply omits it, which reads as "not searched" rather than
 * as "searched and found nothing".
 */
export const SessionSearchRowSchema = SessionSummarySchema.extend({
  snippets: z.array(SessionSnippetSchema).max(MAX_SNIPPETS_PER_SESSION).optional(),
});
export type SessionSearchRow = z.infer<typeof SessionSearchRowSchema>;

export const SessionListResponseSchema = z
  .object({ sessions: z.array(SessionSearchRowSchema).max(MAX_LISTED_SESSIONS) })
  .strict();

/**
 * Four states, because "no new events" and "your cursor cannot be honoured" are
 * different answers and collapsing them strands a client that waits for an
 * event that will never arrive.
 */
export const ReplayStatusSchema = z.enum([
  // since === lastSeq. events is empty and that is the whole answer.
  "up-to-date",
  // since is inside the retained window and the page is contiguous.
  "appended",
  // since predates the oldest surviving record: the log was compacted.
  "cursor-too-old",
  // since is past the end, or a hole was found. Rehydrate from firstSeq.
  "cursor-invalid",
]);
export type ReplayStatus = z.infer<typeof ReplayStatusSchema>;

export const MAX_EVENTS_PER_PAGE = 500;

export const StoredEventSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: IsoTimestampSchema,
    event: ServerEventSchema,
  })
  .strict();
export type StoredEventPage = z.infer<typeof StoredEventSchema>;

export const SessionEventsResponseSchema = z
  .object({
    storeId: StoreIdSchema,
    status: ReplayStatusSchema,
    firstSeq: z.number().int().nonnegative(),
    lastSeq: z.number().int().nonnegative(),
    /**
     * The value to send as `since` for the next request, i.e. the highest seq
     * this page actually contained. Named for what the client does with it:
     * an earlier draft called this `nextSeq` and meant "the first seq not in
     * this page", which is off by one from the `since` contract and silently
     * skipped a record on every page boundary.
     */
    nextSince: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    // Records skipped inside this page, from the cap or from unreadable lines.
    dropped: z.number().int().nonnegative(),
    events: z.array(StoredEventSchema).max(MAX_EVENTS_PER_PAGE),
  })
  .strict();
export type SessionEventsResponse = z.infer<typeof SessionEventsResponseSchema>;

// --- transcript projection ---

export const ProjectedToolSchema = z
  .object({
    toolCallId: z.string().min(1).max(256),
    title: z.string().max(500),
    status: ToolStatusSchema,
    lifecycle: ToolLifecycleSchema,
  })
  .strict();
export type ProjectedTool = z.infer<typeof ProjectedToolSchema>;

/**
 * A turn is the unit a stored transcript is really made of. Projecting to a flat
 * entry list would throw away the grouping the events already carry.
 */
export interface ProjectedTurn {
  readonly turnId: string;
  readonly userText: string;
  readonly assistantText: string;
  /** Kept out of the visible transcript, matching the live reducer, but not
   * discarded, so a future "show thinking" affordance needs no re-record. */
  readonly thoughtText: string;
  readonly stopReason: StopReason | null;
  readonly tools: readonly ProjectedTool[];
  /** What was attached, from the stored manifest. Identity and provenance only:
   * the bytes stay in the spool and are read back by `attachmentId`. */
  readonly attachments: readonly AttachmentManifestEntry[];
}

export interface ProjectedTranscript {
  readonly turns: readonly ProjectedTurn[];
  readonly truncated: boolean;
  /**
   * Why the session ended, when the log says. A stored session that failed to
   * open otherwise rehydrates as an empty transcript with no indication at all,
   * while the live reducer has a reason for exactly this case.
   */
  readonly outcome: ProjectedOutcome | null;
  /** True when at least one stored record could not be read back. */
  readonly dropped: number;
}

export interface ProjectedOutcome {
  readonly reason: "failed" | "closed";
  readonly message: string | null;
}

const EMPTY_PROJECTION: ProjectedTranscript = {
  turns: [],
  truncated: false,
  outcome: null,
  dropped: 0,
};

function isFailedStop(reason: StopReason | null): boolean {
  return reason === "refusal" || reason === "k5-error" || reason === "k5-timeout";
}

interface MutableTurn {
  turnId: string;
  userText: string;
  assistantText: string;
  thoughtText: string;
  stopReason: StopReason | null;
  tools: Map<string, ProjectedTool>;
  attachments: AttachmentManifestEntry[];
  order: number;
}

function freezeTurn(turn: MutableTurn): ProjectedTurn {
  return {
    turnId: turn.turnId,
    userText: turn.userText,
    assistantText: turn.assistantText,
    thoughtText: turn.thoughtText,
    stopReason: turn.stopReason,
    tools: [...turn.tools.values()],
    attachments: turn.attachments,
  };
}

/**
 * Builds view state from a stored log.
 *
 * This is deliberately NOT `applyServerEvent`. Every turn event in the live
 * reducer is gated on `activeTurnId`, so replaying history through it yields one
 * empty assistant entry and silently discards the whole transcript — with no
 * error to notice. The live reducer keeps one job: the running session. A stored
 * transcript is read by this instead, and the two compose because a loaded
 * transcript is always a prefix of a session whose later turns arrive live with
 * fresh turn ids.
 */
export function projectTranscript(
  records: readonly StoredEventRecord[],
  options: { readonly truncated?: boolean; readonly dropped?: number } = {},
): ProjectedTranscript {
  const truncated = options.truncated === true;
  const dropped = options.dropped ?? 0;
  if (records.length === 0) {
    return { ...EMPTY_PROJECTION, truncated, dropped };
  }

  const turns = new Map<string, MutableTurn>();
  const order: string[] = [];
  let seatGone = false;
  let outcome: ProjectedOutcome | null = null;

  const turnFor = (turnId: string): MutableTurn => {
    const existing = turns.get(turnId);
    if (existing !== undefined) return existing;
    const created: MutableTurn = {
      turnId,
      userText: "",
      assistantText: "",
      thoughtText: "",
      stopReason: null,
      tools: new Map(),
      attachments: [],
      order: order.length,
    };
    turns.set(turnId, created);
    order.push(turnId);
    return created;
  };

  for (const record of records) {
    const event: ServerEvent = record.event;
    switch (event.type) {
      case "turn.started": {
        const turn = turnFor(event.turnId);
        // First writer wins, so a duplicated record after a rehydrate cannot
        // replace the prompt the user actually sent.
        if (turn.userText.length === 0) turn.userText = event.userText;
        if (turn.attachments.length === 0) turn.attachments = event.attachments;
        break;
      }
      case "turn.delta": {
        const turn = turnFor(event.turnId);
        if (event.stream === "text") turn.assistantText += event.text;
        else turn.thoughtText += event.text;
        break;
      }
      case "tool.updated": {
        const turn = turnFor(event.turnId);
        turn.tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          title: event.title,
          status: event.status,
          lifecycle: event.lifecycle,
        });
        break;
      }
      case "turn.completed": {
        turnFor(event.turnId).stopReason = event.stopReason;
        break;
      }
      case "seat.reaped": {
        seatGone = true;
        break;
      }
      case "session.closed": {
        seatGone = true;
        outcome = { reason: "closed", message: event.message ?? null };
        break;
      }
      case "session.failed": {
        outcome = { reason: "failed", message: event.message ?? event.reason };
        break;
      }
      default:
        // Remaining persisted variants carry no turn content.
        break;
    }
  }

  // One pass at the end, rather than one pass per reap event: rescanning every
  // turn on every seat.reaped was O(records x turns x tools), measured at 355 ms
  // for 4000 turns and heading for seconds on a full-size log, on the browser's
  // main thread.
  for (const id of order) {
    const turn = turns.get(id);
    if (turn === undefined) continue;
    for (const card of turn.tools.values()) {
      if (card.lifecycle !== "active") continue;
      if (seatGone || truncated) {
        // Nothing is still running. `seatGone` is a reap or a close; `truncated`
        // is a log the byte cap cut mid-turn, which otherwise left the last
        // turn's tool spinning forever after a reload.
        card.lifecycle = "orphaned";
      } else if (
        turn.stopReason !== null &&
        card.status !== "completed" &&
        card.status !== "failed"
      ) {
        // Same correction the live reducer applies: a card the harness never
        // resolved must not sit looking in-flight once the turn has ended.
        card.lifecycle = "cancelled";
      }
    }
  }

  return {
    turns: order.map((id) => freezeTurn(turns.get(id) as MutableTurn)),
    truncated,
    outcome,
    dropped,
  };
}

/** Flattens a projection into the live reducer's entry shape. */
export function transcriptEntries(
  transcript: ProjectedTranscript,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const turn of transcript.turns) {
    // A turn can exist with no user text (a store that began mid-stream), so an
    // entry pair is only emitted when there is something to show.
    if (turn.userText.length === 0 && turn.assistantText.length === 0) continue;
    if (turn.userText.length > 0) {
      entries.push({ id: `user:${turn.turnId}`, role: "user", text: turn.userText });
    }
    entries.push({
      id: `assistant:${turn.turnId}`,
      role: "assistant",
      text: turn.assistantText,
    });
  }
  return entries;
}

export function isFailedTurn(turn: ProjectedTurn): boolean {
  return isFailedStop(turn.stopReason);
}

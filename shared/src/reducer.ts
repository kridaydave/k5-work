import type {
  BrowserCommand,
  CommandFailureReason,
  ConfigOptionSummary,
  ResolvedPostureReport,
  ServerEvent,
  ToolLifecycle,
  ToolStatus,
} from "./contracts.js";
import {
  isFailedTurn,
  projectTranscript,
  transcriptEntries,
  type ProjectedTranscript,
} from "./sessions.js";

// --- browser view state ---
// Pure state transitions over the wire contract. No Node imports, no service
// state, and no side effects, so the same reducer runs in the app and in a Node
// test. The scheduler is injected rather than reaching for requestAnimationFrame,
// so a test can drive coalescing deterministically.

export type ConnectionState = "connecting" | "open" | "closed";

export type SessionState = "none" | "opening" | "open" | "failed";

export type TurnStatus =
  | "idle"
  | "queued"
  | "running"
  | "cancelling"
  | "done"
  | "error";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ToolCard {
  toolCallId: string;
  title: string;
  status: ToolStatus;
  lifecycle: ToolLifecycle;
}

export interface K5ViewState {
  connection: ConnectionState;
  session: SessionState;
  sessionId: string | null;
  /**
   * The harness's own title for this session, once it has generated one. Kept
   * apart from a stored summary because the sidebar lists stored sessions over
   * HTTP and this is the live one.
   */
  sessionTitle: string | null;
  /**
   * The durable record for this session, so a reconnect can rehydrate from the
   * store. Null when no session is open, and the all-zero id when the server is
   * not recording, which the browser must not try to fetch.
   */
  storeId: string | null;
  /**
   * What the live seat's harness actually resolved for permissions, or null when
   * no seat has reported one. Null is the honest answer for a view with no live
   * seat: the transcript is not a record of the posture, so a rehydrated task has
   * none and must say so rather than fall back to a hardcoded label.
   */
  posture: ResolvedPostureReport | null;
  /** The reason a session failed or closed, for a visible reverse state. */
  sessionReason: CommandFailureReason | null;
  sessionMessage: string | null;
  activeTurnId: string | null;
  /**
   * The commandId of the prompt that the active turn was opened for. A refusal is
   * tied to the turn that sent it, because a turn is optimistic and a
   * `command.result` carries no turnId of its own. Without this, a refusal for a
   * second prompt — the seat was busy, and the one already running is not the one
   * that was refused — took down the running turn and the user's answer streamed
   * into a bubble that had been told it would never come.
   */
  pendingPromptId: string | null;
  turnStatus: TurnStatus;
  /** Why the turn ended, when it ended badly. */
  turnReason: string | null;
  entries: TranscriptEntry[];
  tools: Record<string, ToolCard>;
  thinking: string;
  configOptions: ConfigOptionSummary[];
}

export const INITIAL_VIEW_STATE: K5ViewState = {
  connection: "connecting",
  session: "none",
  sessionId: null,
  sessionTitle: null,
  storeId: null,
  posture: null,
  sessionReason: null,
  sessionMessage: null,
  activeTurnId: null,
  pendingPromptId: null,
  turnStatus: "idle",
  turnReason: null,
  entries: [],
  tools: {},
  thinking: "",
  configOptions: [],
};

/**
 * A hard ceiling on retained entries.
 *
 * Deltas arrive per chunk, and the original append mapped the whole array each
 * time, so a long turn was quadratic. The cap bounds both the copy cost and what
 * a rehydrating browser can be asked to render. Oldest entries are dropped, and
 * the drop is reported so the UI can say the transcript is a tail rather than
 * implying completeness.
 */
export const MAX_VIEW_ENTRIES = 500;

/**
 * Replaces the visible transcript with a stored one.
 *
 * Used after a reconnect or when a task is opened from the sidebar. The stored
 * log is read through `projectTranscript` rather than replayed event by event
 * here, because every turn event below is gated on `activeTurnId`: feeding a
 * history through `applyServerEvent` would produce one empty assistant entry and
 * silently drop the rest.
 *
 * The live socket then continues appending to the same shape, because a loaded
 * transcript is always a prefix and later turns arrive with fresh ids.
 */
export function hydrateTranscript(
  state: K5ViewState,
  transcript: ProjectedTranscript,
  options: { readonly storeId?: string; readonly sessionId?: string } = {},
): K5ViewState {
  const entries = capEntries(transcriptEntries(transcript));
  const tools: Record<string, ToolCard> = {};
  // Only the final turn's cards are live state: earlier ones belong to history and
  // are rendered from the projection, not from the reducer's per-turn rail.
  const last = transcript.turns[transcript.turns.length - 1];
  const lastTurnId = last?.turnId ?? null;
  if (lastTurnId !== null) {
    for (const card of last?.tools ?? []) {
      tools[card.toolCallId] = {
        toolCallId: card.toolCallId,
        title: card.title,
        status: card.status,
        lifecycle: card.lifecycle,
      };
    }
  }
  return {
    ...state,
    session: options.sessionId === undefined ? state.session : "open",
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.storeId === undefined ? {} : { storeId: options.storeId }),
    // A hydrated transcript is a finished prefix, so no turn is live. Leaving
    // activeTurnId pointing at the last turn would let a late delta for it pass
    // the active-turn gate and append to text that is already there, and would
    // let a cancel reach for a turn that finished an hour ago. The socket
    // re-establishes the live turn from its own turn.started.
    turnStatus: last !== undefined && isFailedTurn(last) ? "error" : "idle",
    turnReason: last !== undefined && isFailedTurn(last) ? last.stopReason : null,
    activeTurnId: null,
    thinking: last?.thoughtText ?? "",
    entries,
    tools,
    sessionReason: null,
    sessionMessage:
      transcript.outcome === null
        ? state.sessionMessage
        : transcript.outcome.message ??
          `this task ${transcript.outcome.reason === "failed" ? "failed" : "was closed"}`,
    ...(transcript.dropped > 0
      ? {
          sessionMessage:
            "some of this transcript could not be read back, so it may be incomplete",
        }
      : {}),
    ...(transcript.truncated
      ? { sessionMessage: "this transcript was cut off at its storage limit" }
      : {}),
  };
}

export function isTurnTerminal(status: TurnStatus): boolean {
  return status === "done" || status === "error";
}

/** Starts a turn optimistically so the user's text is never lost. */
export function beginTurn(
  state: K5ViewState,
  turnId: string,
  userText: string,
  commandId?: string,
): K5ViewState {
  // A turn that is still running or cancelling owns the working view. Starting a
  // second one stole `activeTurnId` from it, so every later event for the real
  // turn landed in nothing and the user watched an answer stream into a bubble
  // that was not the live one. The second prompt is either queued or refused;
  // either way this state must not invent an optimistic turn for it.
  if (state.turnStatus === "running" || state.turnStatus === "cancelling") return state;
  return {
    ...state,
    activeTurnId: turnId,
    pendingPromptId: commandId ?? null,
    turnStatus: "running",
    turnReason: null,
    thinking: "",
    // A new turn starts with a clean tool rail; a stale card would look live.
    tools: {},
    entries: [
      ...state.entries,
      { id: `user:${turnId}`, role: "user", text: userText },
      { id: `assistant:${turnId}`, role: "assistant", text: "" },
    ],
  };
}

export function requestCancel(state: K5ViewState): K5ViewState {
  if (!state.activeTurnId || isTurnTerminal(state.turnStatus)) return state;
  // Referential no-op so a React reducer does not re-render on a repeat click.
  if (state.turnStatus === "cancelling") return state;
  return { ...state, turnStatus: "cancelling" };
}

export function resetSession(state: K5ViewState): K5ViewState {
  return {
    ...INITIAL_VIEW_STATE,
    connection: state.connection,
  };
}

function appendTo(
  state: K5ViewState,
  entryId: string,
  text: string,
): TranscriptEntry[] {
  // Only the matching entry is rebuilt. The old form allocated a new object for
  // every entry on every delta; measured at 200 deltas against a full 500-entry
  // view this is about 4 ms in total, so the win is real but modest.
  let found = false;
  const next = state.entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    found = true;
    return { ...entry, text: entry.text + text };
  });
  return found ? capEntries(next) : next;
}

/** Drops the oldest entries past the cap, and reports that it did. */
function capEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.length > MAX_VIEW_ENTRIES
    ? entries.slice(entries.length - MAX_VIEW_ENTRIES)
    : entries;
}

/**
 * Applies one server event. Idempotent per turn: once a turn reaches a terminal
 * status, later deltas or a late completion for the same turn are dropped. That
 * is what makes "exactly one terminal event per turn" survive a cancel race or a
 * watchdog firing alongside a real response.
 */
/**
 * `command.result` carries only a commandId, so the originating command's kind
 * has to be supplied by the caller. Without it a failed model change looks
 * exactly like a failed turn.
 */
export function applyServerEvent(
  state: K5ViewState,
  event: ServerEvent,
  commandScope?: BrowserCommand["type"],
): K5ViewState {
  switch (event.type) {
    case "connection.closed":
      return {
        ...state,
        connection: "closed",
        // A dropped socket must not leave the UI claiming a live turn.
        turnStatus: isTurnTerminal(state.turnStatus) ? state.turnStatus : "error",
        turnReason: isTurnTerminal(state.turnStatus) ? state.turnReason : "socket-closed",
        session: state.session === "open" ? "failed" : state.session,
        sessionReason: state.session === "open" ? "internal" : state.sessionReason,
      };

    case "session.opened":
      // A different session means everything about the previous turn is a
      // stranger here, and none of it belongs on screen in the new one. Orphaned
      // tool cards and a half-streamed answer had a way to survive a reap plus a
      // new open, because nothing cleared the turn-scoped fields. When the id is
      // the same one, nothing is reset: the snapshot is updated in place.
      if (state.sessionId === event.sessionId) {
        return {
          ...state,
          session: "open",
          storeId: event.storeId,
          configOptions: event.configOptions,
          sessionTitle: null,
          posture: null,
        };
      }
      return {
        ...state,
        session: "open",
        sessionId: event.sessionId,
        storeId: event.storeId,
        pendingPromptId: null,
        activeTurnId: null,
        turnStatus: "idle",
        turnReason: null,
        thinking: "",
        tools: {},
        entries: [],
        // Cleared, not carried: a title belongs to one session, and the harness
        // only sends its own once it has generated one. Without this a new
        // session showed the previous one's name until that update arrived, and
        // forever if the harness never sends one.
        sessionTitle: null,
        // A posture belongs to the seat that resolved it, exactly as the title
        // does. Cleared rather than held, because the new seat's own report
        // arrives on its own event and a stale grant list would otherwise be
        // shown as this session's permissions.
        posture: null,
        sessionReason: null,
        sessionMessage: null,
        configOptions: event.configOptions,
      };

    case "session.posture":
      // Scoped like every other session event, and this is what stops a late
      // report for a reaped seat from becoming the new session's permissions.
      if (state.sessionId !== event.sessionId) return state;
      return { ...state, posture: event.posture };

    case "session.configured":
      if (state.sessionId !== event.sessionId) return state;
      return { ...state, configOptions: event.configOptions };

    case "session.closed":
      // Scoped to the session that closed, like every sibling. A close or a reap
      // that arrives after a different session opened — the old seat's notification
      // lands late, or the harness answers a close out of order — used to wipe the
      // whole current view, including the active turn's id, which then disarmed
      // every later event meant for the running task.
      if (state.sessionId !== event.sessionId) return state;
      return {
        ...state,
        pendingPromptId: null,
        session: "none",
        sessionId: null,
        sessionTitle: null,
        storeId: null,
        posture: null,
        turnStatus: isTurnTerminal(state.turnStatus) ? state.turnStatus : "idle",
        turnReason: null,
        thinking: "",
        tools: {},
            };

    case "session.failed":
      return {
        ...state,
        session: "failed",
        sessionReason: event.reason,
        sessionMessage: event.message ?? null,
        turnStatus: isTurnTerminal(state.turnStatus) ? state.turnStatus : "error",
        turnReason: isTurnTerminal(state.turnStatus) ? state.turnReason : event.reason,
      };

    case "session.listed":
    case "session.loaded":
      // Discovery and continuation are reported through command.result and the
      // session's own events. Neither changes view state on its own: a listed
      // session is not a session, and a loaded one announces itself with
      // session.opened semantics on the same connection.
      return state;

    case "session.updated":
      // The harness's own title, which it generates after the first exchange.
      // A null title means the update carried none, so an existing title is
      // kept rather than blanked.
      if (state.sessionId !== event.sessionId) return state;
      if (event.title === null) return state;
      return { ...state, sessionTitle: event.title };

    case "seat.reaped":
      if (state.sessionId !== event.sessionId) return state;
      return {
        ...state,
        pendingPromptId: null,
        session: "none",
        sessionId: null,
        sessionTitle: null,
        storeId: null,
        posture: null,
        turnStatus: isTurnTerminal(state.turnStatus) ? state.turnStatus : "idle",
        turnReason: null,
        thinking: "",
              // Every open path has a visible reverse state, and a reaped seat takes
        // its in-progress tool cards with it rather than leaving them spinning.
        tools: Object.fromEntries(
          Object.entries(state.tools).map(([id, card]) => [
            id,
            { ...card, lifecycle: "orphaned" as ToolLifecycle },
          ]),
        ),
      };

    case "command.result": {
      if (event.ok) return state;
      // A command that is not the turn must report into the session message and
      // nothing else. A failed model change is about a model, and a failed list
      // or continuation is about discovery; treating either as a turn failure
      // killed the working dots and then dropped every remaining delta from a
      // harness that was still streaming, so a finished answer stayed truncated.
      if (
        commandScope === "session.configure" ||
        commandScope === "session.list" ||
        commandScope === "session.load"
      ) {
        return {
          ...state,
          sessionMessage: event.message ?? state.sessionMessage,
        };
      }
      // A failed open leaves an optimistic "opening" state that must not persist.
      if (commandScope === "session.open") {
        if (state.session !== "opening") {
          return {
            ...state,
            sessionReason: event.reason,
            sessionMessage: event.message ?? null,
          };
        }
        return {
          ...state,
          session: "failed",
          sessionReason: event.reason,
          sessionMessage: event.message ?? null,
          turnStatus: isTurnTerminal(state.turnStatus) ? state.turnStatus : "error",
          turnReason: isTurnTerminal(state.turnStatus) ? state.turnReason : event.reason,
        };
      }
      // Only the prompt that this state optimistically started may fail its turn.
      // A refusal for a different prompt — the seat was busy, or a configure the
      // harness refused after the turn began — belongs in the message bar. Keying
      // off `turnStatus === "running"` instead meant any failed command killed the
      // turn and then every later event for it was dropped: a configure refusal
      // and a busy refusal each turned into a lost answer.
      if (commandScope === "session.prompt") {
        const live = state.turnStatus === "running" || state.turnStatus === "cancelling";
        if (state.pendingPromptId !== event.commandId || !live) {
          return {
            ...state,
            sessionMessage: event.message ?? null,
          };
        }
        return {
          ...state,
          turnStatus: "error",
          turnReason: event.reason,
          sessionMessage: event.message ?? null,
        };
      }
      // The remaining command results (cancel, close, and the configure/list/load
      // family already handled above) are never a turn failure: they report into
      // the message bar and leave the running view alone.
      return {
        ...state,
        sessionReason: event.reason,
        sessionMessage: event.message ?? null,
      };
    }

    case "turn.started":
      if (state.activeTurnId !== event.turnId) return state;
      return { ...state, turnStatus: "running", pendingPromptId: null };

    case "turn.delta": {
      if (state.activeTurnId !== event.turnId) return state;
      if (isTurnTerminal(state.turnStatus)) return state;
      if (event.stream === "thought") {
        return { ...state, thinking: state.thinking + event.text };
      }
      return {
        ...state,
        entries: appendTo(state, `assistant:${event.turnId}`, event.text),
      };
    }

    case "tool.updated": {
      // Scoped like every other turn event: without this, a tool update that
      // arrives after a new task or during teardown leaks a stale card into the
      // fresh session.
      if (state.activeTurnId !== event.turnId) return state;
      if (isTurnTerminal(state.turnStatus)) {
        // A card is finished once the turn is; a straggler update cannot reopen it.
        // The old guard admitted any update for a card it already knew about, so a
        // `tool.updated` sitting behind the completion rewrote lifecycle to "active"
        // and the card spun forever on a turn that had already ended, with nothing
        // left to correct it. An update after a terminal event is one the harness
        // sent late, and the only honest use of it is a late completion.
        const existing = state.tools[event.toolCallId];
        if (existing === undefined) return state;
        // A late completion is allowed because it ends the card truthfully.
        const reachingTerminal = event.status === "completed" || event.status === "failed";
        if (!reachingTerminal) return state;
        if (existing.status === "completed" || existing.status === "failed") return state;
        return {
          ...state,
          tools: {
            ...state.tools,
            [event.toolCallId]: { ...existing, status: event.status, lifecycle: event.lifecycle },
          },
        };
      }
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            toolCallId: event.toolCallId,
            title: event.title,
            status: event.status,
            lifecycle: event.lifecycle,
          },
        },
      };
    }

    case "turn.completed": {
      if (state.activeTurnId !== event.turnId) return state;
      if (isTurnTerminal(state.turnStatus)) {
        // A second terminal for the same turn is a duplicate, not an update.
        return state;
      }
      const failed =
        event.stopReason === "refusal" ||
        event.stopReason === "k5-error" ||
        event.stopReason === "k5-timeout";
      return {
        ...state,
        turnStatus: failed ? "error" : "done",
        turnReason: failed ? event.stopReason : null,
        pendingPromptId: null,
        // A turn that has ended cannot have a tool still running. This covers
        // `in_progress` as well as `pending`: a card the harness left mid-flight
        // used to keep lifecycle "active" and spin forever, because only
        // "pending" was corrected. The harness's own reported status is left
        // alone, so a card that really did complete still reads completed.
        tools: Object.fromEntries(
          Object.entries(state.tools).map(([id, card]) =>
            card.lifecycle === "active" &&
            card.status !== "completed" &&
            card.status !== "failed"
              ? [id, { ...card, lifecycle: "cancelled" as ToolLifecycle }]
              : [id, card],
          ),
        ),
      };
    }

    case "error":
      return {
        ...state,
        sessionMessage: state.sessionMessage ?? event.message,
      };
  }
}

/** A pending rAF-style flush, so deltas can be coalesced before a render. */
export interface Coalescer<T> {
  push(value: T): void;
  flush(): void;
  cancel(): void;
}

export type Scheduler = (run: () => void) => void;

export const immediateScheduler: Scheduler = (run) => {
  run();
};

export function createCoalescer<T>(
  schedule: Scheduler,
  apply: (values: T[]) => void,
): Coalescer<T> {
  let pending: T[] = [];
  let scheduled = false;
  return {
    push(value) {
      pending.push(value);
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        const batch = pending;
        pending = [];
        if (batch.length > 0) apply(batch);
      });
    },
    flush() {
      const batch = pending;
      pending = [];
      scheduled = false;
      if (batch.length > 0) apply(batch);
    },
    cancel() {
      pending = [];
      scheduled = false;
    },
  };
}

/**
 * Applies a batch of events in order. Intended for uniform batches (a frame of
 * deltas, or tool updates); a `command.result` needs its originating command
 * kind passed to `applyServerEvent` so a failed model change is not mistaken for
 * a failed turn.
 */
export function applyServerEvents(
  state: K5ViewState,
  events: ServerEvent[],
): K5ViewState {
  return events.reduce((current, event) => applyServerEvent(current, event), state);
}

/** Tracks which command kind produced each `command.result`, for scoping. */
export function rememberCommandScope(
  scopes: Map<string, BrowserCommand["type"]>,
  command: BrowserCommand,
): Map<string, BrowserCommand["type"]> {
  scopes.set(command.commandId, command.type);
  // Bounded so a long session cannot grow this without limit.
  if (scopes.size > 200) {
    const oldest = scopes.keys().next();
    if (!oldest.done) scopes.delete(oldest.value);
  }
  return scopes;
}

export function scopeFor(
  scopes: Map<string, BrowserCommand["type"]>,
  commandId: string,
): BrowserCommand["type"] | undefined {
  const scope = scopes.get(commandId);
  scopes.delete(commandId);
  return scope;
}

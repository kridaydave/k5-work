import type {
  BrowserCommand,
  CommandFailureReason,
  ConfigOptionSummary,
  ServerEvent,
  ToolLifecycle,
  ToolStatus,
} from "./contracts.js";

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
  /** The reason a session failed or closed, for a visible reverse state. */
  sessionReason: CommandFailureReason | null;
  sessionMessage: string | null;
  activeTurnId: string | null;
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
  sessionReason: null,
  sessionMessage: null,
  activeTurnId: null,
  turnStatus: "idle",
  turnReason: null,
  entries: [],
  tools: {},
  thinking: "",
  configOptions: [],
};

export function isTurnTerminal(status: TurnStatus): boolean {
  return status === "done" || status === "error";
}

/** Starts a turn optimistically so the user's text is never lost. */
export function beginTurn(
  state: K5ViewState,
  turnId: string,
  userText: string,
): K5ViewState {
  return {
    ...state,
    activeTurnId: turnId,
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
  return state.entries.map((entry) =>
    entry.id === entryId ? { ...entry, text: entry.text + text } : entry,
  );
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
      return {
        ...state,
        session: "open",
        sessionId: event.sessionId,
        sessionReason: null,
        sessionMessage: null,
        configOptions: event.configOptions,
      };

    case "session.configured":
      if (state.sessionId !== event.sessionId) return state;
      return { ...state, configOptions: event.configOptions };

    case "session.closed":
      return {
        ...state,
        session: "none",
        sessionId: null,
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

    case "seat.reaped":
      return {
        ...state,
        session: "none",
        sessionId: null,
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
      // A configure failure is about a model, not the turn. Treating it as a
      // turn failure would kill the working dots and then silently drop every
      // remaining delta from a harness that is still streaming.
      if (commandScope === "session.configure") {
        return { ...state, sessionMessage: event.message ?? state.sessionMessage };
      }
      // A failed open leaves an optimistic "opening" state that must not persist.
      if (state.session === "opening" || state.turnStatus === "running") {
        return {
          ...state,
          session: state.session === "opening" ? "failed" : state.session,
          sessionReason: event.reason,
          sessionMessage: event.message ?? null,
          turnStatus: isTurnTerminal(state.turnStatus) ? state.turnStatus : "error",
          turnReason: isTurnTerminal(state.turnStatus) ? state.turnReason : event.reason,
        };
      }
      // A newer failure must not be masked by a stale reason from an earlier one.
      return {
        ...state,
        sessionReason: event.reason,
        sessionMessage: event.message ?? null,
      };
    }

    case "turn.started":
      if (state.activeTurnId !== event.turnId) return state;
      return { ...state, turnStatus: "running" };

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
      if (isTurnTerminal(state.turnStatus) && state.tools[event.toolCallId] === undefined) {
        return state;
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
        // A cancelled turn must not leave a tool card claiming to be running.
        tools: Object.fromEntries(
          Object.entries(state.tools).map(([id, card]) =>
            card.lifecycle === "active" && card.status === "pending"
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

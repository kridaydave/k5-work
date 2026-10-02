import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserCommandSchema,
  ServerEventSchema,
  applyServerEvent,
  beginTurn,
  createCoalescer,
  INITIAL_VIEW_STATE,
  isTurnTerminal,
  rememberCommandScope,
  requestCancel,
  resetSession,
  scopeFor,
  type AttachmentRef,
  type BrowserCommand,
  type K5ViewState,
  type ServerEvent,
  type ProjectedTranscript,
  type Scheduler,
  hydrateTranscript,
} from "@k5-work/shared";

// One socket per tab. The URL is same-origin and relative on purpose: a
// hardcoded host breaks immediately under a tunnel or a remote origin, which is
// the mistake AGENTS.md calls out for frontend origins.
export function wsScheme(originProtocol: string): "wss:" | "ws:" {
  return originProtocol === "https:" ? "wss:" : "ws:";
}

export function socketUrl(): string {
  return `${wsScheme(window.location.protocol)}//${window.location.host}/ws`;
}

/** How long a socket must stay open before it counts as a working connection. */
export const STABLE_SOCKET_MS = 5_000;

/** Ceiling on re-reading the transcript before reconnecting anyway. */
export const REHYDRATE_BUDGET_MS = 5_000;

/** Exponential backoff, capped, so a dead server is not hammered. */
export const MAX_RECONNECT_DELAY_MS = 15_000;
export function backoffMs(attempt: number): number {
  const delay = 250 * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}

const defaultSchedule = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

let commandCounter = 0;
function nextCommandId(): string {
  commandCounter += 1;
  return `c-${Date.now().toString(36)}-${commandCounter}`;
}

export interface K5Socket {
  state: K5ViewState;
  openSession(projectId: string): void;
  /**
   * Sends a prompt. `attachments` are ids the spool already holds: the bytes were
   * uploaded before this call, and the command carries identity only.
   */
  prompt(text: string, attachments?: readonly AttachmentRef[]): void;
  cancel(): void;
  closeSession(): void;
  newTask(): void;
  /** Applies a harness-advertised config option to the live seat. */
  configure(sessionId: string, configOptionId: string, value: string): void;
  /**
   * Replaces the visible transcript with a stored one, read after a reconnect.
   * Kept here rather than in the caller so the socket's own view state and the
   * caller's can never disagree about what is on screen.
   */
  adoptTranscript(transcript: ProjectedTranscript): void;
  /** Continues a stored task on the harness, by k5 store id. */
  loadSession(storeId: string): boolean;
  connected: boolean;
}

export interface UseK5SocketOptions {
  /** Injected so tests can drive frame coalescing without a browser. */
  scheduler?: Scheduler;
  /**
   * Injected so a test can drive reconnection without waiting on real backoff.
   * The default is a real timer.
   */
  schedule?: (run: () => void, delayMs: number) => () => void;
  /**
   * Re-reads the durable transcript after a reconnect. Injected because it does
   * I/O, and because a test must be able to assert it was called with the right
   * store id rather than that a fetch happened to resolve.
   */
  rehydrate?: (storeId: string) => Promise<void>;
  /** Ceiling on rehydrating before reconnecting anyway. Injectable for tests. */
  rehydrateBudgetMs?: number;
}

/**
 * Defined once at module scope, not inline in the hook body.
 *
 * An inline default would be a new function identity on every render, which
 * would recreate the coalescer and re-run the socket effect each time: the
 * socket would tear down and reconnect on every state change, and a command
 * sent between teardown and setup would be silently dropped.
 */
const rafScheduler: Scheduler = (run) => {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => run());
    return;
  }
  run();
};

export function useK5Socket(options: UseK5SocketOptions = {}): K5Socket {
  const [state, setState] = useState<K5ViewState>(INITIAL_VIEW_STATE);
  const socketRef = useRef<WebSocket | null>(null);
  const turnCounter = useRef(0);
  // The coalescer holds the latest state via a ref so a queued frame never
  // applies to a stale snapshot.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Memoized on the *identity* of the injected scheduler, and defaulted to a
  // module constant. An inline closure from a caller would still change every
  // render, so the contract is that the scheduler must be stable; holding it in
  // a ref did not and could not fix that.
  const scheduler = options.scheduler ?? rafScheduler;

  const apply = useCallback(
    (event: ServerEvent, scope?: BrowserCommand["type"]) => {
      setState((current) => applyServerEvent(current, event, scope));
    },
    [],
  );

  /**
   * Records a failure for a command that never left the browser.
   *
   * This is local state, not a `command.result`: fabricating a wire result for
   * a command that was never sent would be a lie, and a constant commandId could
   * never be tied back to a specific submission.
   */
  const rejectLocal = useCallback((message: string) => {
    setState((current) => ({
      ...current,
      turnStatus: isTurnTerminal(current.turnStatus) ? current.turnStatus : "error",
      turnReason: current.turnReason ?? "not-sent",
      sessionMessage: current.sessionMessage ?? message,
    }));
  }, []);

  // Deltas are coalesced per frame: the gateway has no animation frame, and a
  // Markdown re-lex per token is the expensive part.
  const coalescer = useMemo(
    () => createCoalescer<ServerEvent>(scheduler, (events) => {
      setState((current) => events.reduce((acc, e) => applyServerEvent(acc, e), current));
    }),
    [scheduler],
  );

  /**
   * Returns false when the command could not be delivered, and records a visible
   * failure. The Composer clears its textarea on submit, so a send that quietly
   * fails loses the user's text with no indication that anything went wrong.
   */
  // A command.result carries only an id, so the originating kind is recorded
  // here: a failed model change must not be read as a failed turn.
  const commandScopes = useRef(new Map<string, BrowserCommand["type"]>());

  const send = useCallback((command: BrowserCommand): boolean => {
    const socket = socketRef.current;
    const parsed = BrowserCommandSchema.safeParse(command);
    if (!parsed.success) {
      rejectLocal("the command did not match the wire contract");
      return false;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      rejectLocal(
        socket && socket.readyState === WebSocket.CONNECTING
          ? "the workspace is still connecting; try again in a moment"
          : "no connection to the workspace",
      );
      return false;
    }
    rememberCommandScope(commandScopes.current, parsed.data);
    try {
      socket.send(JSON.stringify(parsed.data));
    } catch {
      // A socket can close between the readyState check and the write; that
      // would otherwise throw out of a React event handler.
      rejectLocal("the workspace went offline before the command could be sent");
      return false;
    }
    return true;
  }, [rejectLocal]);

  // The injected collaborators are read through a ref, not listed as effect
  // dependencies. A caller that passes an inline arrow would otherwise give it a
  // new identity on every render, and the socket effect would tear down and
  // reconnect each time — which is exactly the failure the module-scope scheduler
  // below exists to prevent, reintroduced through a different door.
  const scheduleRetry = useRef(options.schedule ?? defaultSchedule);
  scheduleRetry.current = options.schedule ?? defaultSchedule;
  const rehydrate = useRef(options.rehydrate);
  rehydrate.current = options.rehydrate;
  const rehydrateBudget = useRef(options.rehydrateBudgetMs ?? REHYDRATE_BUDGET_MS);
  rehydrateBudget.current = options.rehydrateBudgetMs ?? REHYDRATE_BUDGET_MS;

  useEffect(() => {
    // A stable token so React StrictMode's development double mount opens one
    // logical connection rather than two.
    let disposed = false;
    let cancelRetry: (() => void) | null = null;
    let attempt = 0;

    /**
     * One bounded rehydrate, shared by both callers: a socket reconnecting under
     * a live task, and a task just continued from the store. The returned promise
     * always settles: the read is raced against a budget, and a rejection is
     * logged rather than propagated, because a rehydrator that throws
     * synchronously or never settles must not strand the caller.
     */
    const rehydrateNow = (storeId: string): Promise<void> => {
      const load = rehydrate.current;
      if (disposed || load === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, rehydrateBudget.current);
        void Promise.resolve()
          .then(() => load(storeId))
          .then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (cause: unknown) => {
              clearTimeout(timer);
              console.warn("k5: the stored transcript could not be re-read", cause);
              resolve();
            },
          );
      });
    };

    // Reconnecting, rather than treating a close as terminal: the server restarts
    // during development and a dropped wifi connection is not a reason for the
    // workspace to become a dead tab. Backoff is capped, and the attempt counter
    // resets on a successful open so a later drop does not inherit an old delay.
    const connect = (): void => {
      if (disposed) return;
      const socket = new WebSocket(socketUrl());
      socketRef.current = socket;

      let openedAt = 0;
      socket.onopen = () => {
        if (disposed) return;
        openedAt = Date.now();
        setState((current) => ({ ...current, connection: "open" }));
      };
      socket.onerror = () => {
        if (disposed) return;
        setState((current) => ({ ...current, connection: "closed" }));
      };

      socket.onclose = () => {
        // Only the socket that currently owns the ref may release it. A
        // superseded socket closes asynchronously, after its replacement has
        // already been assigned, so an unconditional clear here would leave the
        // live socket untracked while the UI still claims to be connected.
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        coalescer.flush();
        setState((current) => ({
          ...applyServerEvent(current, {
            type: "connection.closed",
            reason: "socket closed",
          }),
        }));
        // Reset only after the socket has stayed up long enough to count as a
        // working connection. Resetting on every open disabled the backoff against
        // the most common real failure: a server that accepts the upgrade and then
        // closes, which is exactly a dev-server restart. Measured eight
        // accept-then-drop cycles all retrying at 250 ms, four connects a second
        // for ever.
        if (openedAt > 0 && Date.now() - openedAt >= STABLE_SOCKET_MS) {
          attempt = 0;
        }
        attempt += 1;
        const delay = backoffMs(attempt);
        const runRetry = (): void => {
          if (disposed) return;
          // Re-read the transcript before the new socket can deliver anything, so
          // a turn that finished while we were away is not silently lost. The
          // store is the record; the socket is only a viewer.
          const storeId = stateRef.current.storeId;
          if (rehydrate.current !== undefined && storeId !== null) {
            // The reconnect waits for the read, so a live delta can never land
            // before the history it belongs to.
            void rehydrateNow(storeId).finally(() => {
              if (!disposed) connect();
            });
            return;
          }
          connect();
        };
        cancelRetry = scheduleRetry.current(runRetry, delay);
      };

      socket.onmessage = (message) => {
        if (disposed) return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const parsed = ServerEventSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn("k5: dropping an unrecognised server event", parsed.error.message);
          return;
        }
        const event = parsed.data;
        if (event.type === "turn.delta" || event.type === "tool.updated") {
          coalescer.push(event);
          return;
        }
        coalescer.flush();
        if (event.type === "command.result") {
          apply(event, scopeFor(commandScopes.current, event.commandId));
          return;
        }
        apply(event);
        // A continuation announces itself without touching view state, so the
        // entries on screen are still the previous task's. The store is the
        // record of the task just opened, and it is read here rather than on a
        // timer: by now `session.opened` has established this session's ids, so
        // the transcript lands on the session it belongs to.
        if (event.type === "session.loaded") void rehydrateNow(event.storeId);
      };
    };

    connect();

    return () => {
      disposed = true;
      cancelRetry?.();
      coalescer.cancel();
      // Whatever is live is closed here; connect() may have replaced the socket
      // this effect originally created, so the ref is the authority, not a
      // captured local.
      const live = socketRef.current;
      socketRef.current = null;
      if (live === null) return;
      // Closing is the browser's authoritative signal, not a second event.
      if (live.readyState === WebSocket.OPEN || live.readyState === WebSocket.CONNECTING) {
        live.close(1000, "unmount");
      }
    };
  }, [apply, coalescer]);

  const openSession = useCallback(
    (projectId: string) => {
      setState((current) => ({ ...current, session: "opening" }));
      send({ commandId: nextCommandId(), type: "session.open", projectId });
    },
    [send],
  );

  const prompt = useCallback(
    (text: string, attachments: readonly AttachmentRef[] = []) => {
      const { sessionId, connection } = stateRef.current;
      if (connection !== "open") {
        // Never begin a turn with no way to send it: the optimistic entry would
        // sit on "running" with nothing behind it.
        rejectLocal("the workspace is offline, so the prompt was not sent");
        return;
      }
      if (!sessionId) {
        // Never wait for a session that cannot arrive: the submission is
        // reported as failed rather than left optimistic forever.
        setState((current) => ({
          ...current,
          turnStatus: "error",
          turnReason: "no-session",
          sessionReason: "initialize-failed",
          sessionMessage: "no ACP session is open",
        }));
        return;
      }
      turnCounter.current += 1;
      const turnId = `t-${Date.now().toString(36)}-${String(turnCounter.current)}`;
      // Begin only once the command is known to be deliverable, so the user's
      // text is never optimistically shown as sent when it was not.
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        rejectLocal("the workspace is offline, so the prompt was not sent");
        return;
      }
      const commandId = nextCommandId();
      setState((current) => beginTurn(current, turnId, text, commandId));
      // Copied, because the contract's own type is a mutable array and a caller
      // holding the list could otherwise mutate the frame after it was validated.
      send({
        commandId,
        type: "session.prompt",
        sessionId,
        turnId,
        text,
        attachments: [...attachments],
      });
    },
    [rejectLocal, send],
  );

  const cancel = useCallback(() => {
    const sessionId = stateRef.current.sessionId;
    if (!sessionId) return;
    setState(requestCancel);
    send({ commandId: nextCommandId(), type: "session.cancel", sessionId });
  }, [send]);

  const closeSession = useCallback(() => {
    const sessionId = stateRef.current.sessionId;
    if (!sessionId) return;
    send({ commandId: nextCommandId(), type: "session.close", sessionId });
  }, [send]);

  const adoptTranscript = useCallback((transcript: ProjectedTranscript) => {
    setState((current) => hydrateTranscript(current, transcript));
  }, []);

  const newTask = useCallback(() => {
    // A new task ends the live turn server-side before the transcript resets,
    // so a tab never leaves a seat running behind an empty hero.
    const sessionId = stateRef.current.sessionId;
    if (sessionId) {
      send({ commandId: nextCommandId(), type: "session.close", sessionId });
    }
    coalescer.cancel();
    setState(resetSession);
  }, [coalescer, send]);

  const configure = useCallback(
    (sessionId: string, configOptionId: string, value: string) => {
      send({ commandId: nextCommandId(), type: "session.configure", sessionId, configOptionId, value });
    },
    [send],
  );

  return {
    state,
    openSession,
    prompt,
    cancel,
    closeSession,
    newTask,
    configure,
    adoptTranscript,
    /**
     * Sends the continuation command, so the caller never builds a wire shape.
     *
     * There is deliberately no `listSessions` here. The server implements
     * `session.list` against the harness, but nothing in the browser asks for it:
     * the sidebar is populated from the store over HTTP, because that is the list
     * of transcripts that actually exist. A button that listed the harness's own
     * sessions would show work k5 has no record of and cannot reopen. The command
     * stays on the wire and stays tested until there is a screen that can be honest
     * about what such a row would mean.
     */
    loadSession: useCallback(
      (storeId: string) => send({ commandId: nextCommandId(), type: "session.load", storeId }),
      [send],
    ),
    connected: state.connection === "open",
  };
}

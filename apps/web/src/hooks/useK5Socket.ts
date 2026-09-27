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
  type BrowserCommand,
  type K5ViewState,
  type ServerEvent,
  type Scheduler,
} from "@k5-work/shared";

// One socket per tab. The URL is same-origin and relative on purpose: a
// hardcoded host breaks immediately under a tunnel or a remote origin, which is
// the mistake AGENTS.md calls out for frontend origins.
function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

let commandCounter = 0;
function nextCommandId(): string {
  commandCounter += 1;
  return `c-${Date.now().toString(36)}-${commandCounter}`;
}

export interface K5Socket {
  state: K5ViewState;
  openSession(projectId: string): void;
  prompt(text: string): void;
  cancel(): void;
  closeSession(): void;
  newTask(): void;
  /** Applies a harness-advertised config option to the live seat. */
  configure(sessionId: string, configOptionId: string, value: string): void;
  connected: boolean;
}

export interface UseK5SocketOptions {
  /** Injected so tests can drive frame coalescing without a browser. */
  scheduler?: Scheduler;
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

  useEffect(() => {
    // A stable token so React StrictMode's development double mount opens one
    // logical connection rather than two.
    let disposed = false;
    const socket = new WebSocket(socketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      if (disposed) return;
      setState((current) => ({ ...current, connection: "open" }));
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
      // An unparseable frame is dropped rather than partially applied; logging
      // keeps schema drift visible instead of silent.
      if (!parsed.success) {
        console.warn("k5: dropping an unrecognised server event", parsed.error.message);
        return;
      }
      const event = parsed.data;
      // Large streams are batched; state changes are applied immediately so a
      // terminal event is never stuck behind a frame.
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
      return;
    };

    return () => {
      disposed = true;
      coalescer.cancel();
      socketRef.current = null;
      // Closing is the browser's authoritative signal, not a second event.
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "unmount");
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
    (text: string) => {
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
      setState((current) => beginTurn(current, turnId, text));
      send({ commandId, type: "session.prompt", sessionId, turnId, text });
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
    connected: state.connection === "open",
  };
}

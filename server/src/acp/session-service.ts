import {
  resolveAccessProfile,
  type BrowserCommand,
  type CommandFailureReason,
  type ConfigOptionSummary,
  type PermissionResolvedReason,
  type ServerEvent,
} from "@k5-work/shared";
import type { AcceptedConnection, ConnectionHandlers } from "../ws/gateway.js";
import { SeatOpenError, type SeatRunner } from "./seat-runner.js";
import { AcpAuthRequiredError } from "./probe.js";
import type {
  AcpPermissionRequest,
  AcpSeat,
  SeatStreamEvent,
} from "./acp-seat.js";

/** Monotonic so a permission requestId is never reused within a connection. */
let permissionCounter = 0;
import type { TurnCompletedEvent } from "@k5-work/shared";
type TurnStopReason = TurnCompletedEvent["stopReason"];
import type { AcpChild } from "./spawn.js";
import type { Seat, SeatPool } from "./seat-pool.js";
import type { ResolvedPosture } from "./posture.js";

export interface SessionHandlers extends ConnectionHandlers {
  /** Resolves when any in-flight seat teardown has finished. */
  waitForIdle(): Promise<void>;
}

export interface ProjectLookup {
  /** Canonical path for a project id, or null when the id is unknown. */
  resolve(projectId: string): string | null;
}

export interface SessionServiceOptions {
  runner: SeatRunner;
  pool: SeatPool;
  projects: ProjectLookup;
  /**
   * Registers each seat child so a hard shutdown still reaps it. Reaping on
   * close is the normal path, but a seat can outlive its socket if the process
   * is going down at the wrong moment.
   */
  trackSeat?: (child: AcpChild) => void;
  untrackSeat?: (child: AcpChild | null) => void;
  /** Maps a wire failure reason onto the closed CommandFailureReason union. */
  onAudit?: (entry: {
    sessionId: string | null;
    action: string;
    detail: string;
  }) => void;
}

interface ConnectionState {
  sessionId: string | null;
  seat: Seat | null;
  /** The live ACP connection, or null between sessions. */
  acp: AcpSeat | null;
  /** The turn currently running, so cancel and terminal events can be matched. */
  turn: { id: string; closed: boolean } | null;
  /** Set while a seat is being torn down; awaited by waitForIdle. */
  releasing: Promise<void> | null;
  /** Pending permission decisions, single-use by construction. */
  pendingPermissions: Map<
    string,
    { optionIds: Set<string>; resolve: (optionId: string | null) => void }
  >;
  closed: boolean;
}

/**
 * Per-browser-connection session state.
 *
 * One socket owns at most one seat and at most one turn. A second concurrent
 * session is refused with `seat-busy` rather than queued, because a queued
 * request the user cannot see is a request that looks lost.
 */
export function createSessionHandlers(
  connection: AcceptedConnection,
  options: SessionServiceOptions,
): SessionHandlers {
  const state: ConnectionState = {
    sessionId: null,
    seat: null,
    acp: null,
    turn: null,
    releasing: null,
    pendingPermissions: new Map(),
    closed: false,
  };

  /**
   * Returns false instead of throwing when the event could not be delivered.
   * `AcceptedConnection.send` throws on a contract violation, and that call
   * happens from inside the seat's update pump: an exception there would leave
   * the turn with no terminal event and the working dots spinning forever.
   */
  const emit = (event: ServerEvent): boolean => {
    if (state.closed) return false;
    try {
      // On overflow the gateway closes the socket and calls overflow() first.
      return connection.send(event);
    } catch (err) {
      // A contract violation must be visible: silently dropping it is how a
      // browser ends up waiting forever on an event that was never sent.
      process.stderr.write(
        `k5 dropped an invalid ${String(event.type)} event: ${(err as Error).message}\n`,
      );
      return false;
    }
  };

  /** Publishes a refreshed option snapshot; false when it could not be sent. */
  const setConfigOptions = (options: ConfigOptionSummary[]): boolean => {
    const sessionId = state.sessionId;
    if (sessionId === null) return false;
    return emit({ type: "session.configured", sessionId, configOptions: options });
  };

  const fail = (command: BrowserCommand, err: SeatOpenError): void => {
    emit({
      type: "command.result",
      commandId: command.commandId,
      ok: false,
      reason: err.reason,
      message: err.message.slice(0, 500),
    });
    emit({
      type: "session.failed",
      sessionId: state.sessionId,
      reason: err.reason,
      message: err.message.slice(0, 500),
    });
    // A seat that failed to open is not a live session, so the browser is told
    // the reverse state too. Otherwise the optimistic bubble waits forever.
    if (state.seat) {
      emit({ type: "seat.reaped", sessionId: state.sessionId, reason: err.reason });
      state.releasing = releaseSeat(state);
    }
    options.onAudit?.({
      sessionId: state.sessionId,
      action: "session.open",
      detail: `${err.reason}: ${err.message}`,
    });
  };

  const base: SessionHandlers = {
    async waitForIdle() {
      await state.releasing;
    },
    command(command) {
      switch (command.type) {
        case "session.open":
          void openSession(command);
          return;
        case "session.prompt":
          void runTurn(command);
          return;
        case "session.cancel": {
          if (state.sessionId !== command.sessionId) {
            emit({
              type: "command.result",
              commandId: command.commandId,
              ok: false,
              reason: "not-found",
              message: "no such session on this connection",
            });
            return;
          }
          emit({ type: "command.result", commandId: command.commandId, ok: true, reason: "ok" });
          // A cancel with no live turn still has to leave a terminal state, so
          // the browser's working dots cannot spin forever.
          if (state.turn && !state.turn.closed) {
            state.acp?.cancel();
            finishTurn(state.turn.id, "cancelled");
          }
          return;
        }
        case "session.close":
          closeSession(command.commandId, command.sessionId, "client-request");
          return;
        case "session.configure":
          void applyConfig(command);
          return;
        case "permission.decide":
          decidePermission(command);
          return;
      }
    },

    overflow() {
      // Every pending permission is resolved locally, because the socket is
      // about to close and a dropped request would strand the agent.
      resolveOutstandingPermissions("overflow");
    },

    closed() {
      state.closed = true;
      // A tab that closes mid-turn must not leave the seat or the agent waiting.
      for (const requestId of [...state.pendingPermissions.keys()]) {
        options.onAudit?.({
          sessionId: state.sessionId,
          action: "permission.resolved",
          detail: `socket-closed ${requestId}`,
        });
      }
      resolveOutstandingPermissions("revoked");
      if (state.seat) state.releasing = releaseSeat(state);
    },
  };
  return base;

  /**
   * Reaps the seat's harness child and drops the key.
   *
   * Nulling the session state is not enough: the child is a live process with
   * open stdio pipes, and leaving it running is exactly the orphaned harness the
   * workspace rules forbid. The key is only released once the child is gone, so
   * a later open cannot collide with a seat that is still shutting down.
   */
  function classifyConfigFailure(err: unknown): CommandFailureReason {
    const message = err instanceof Error ? err.message : "";
    if (/not an offered value|did not advertise/.test(message)) return "invalid-payload";
    if (/already running/.test(message)) return "busy";
    if (/no such session|no session/.test(message)) return "not-found";
    // Seat closed, no ACP context, or a transport error: the server's problem,
    // not the browser's payload.
    return "internal";
  }

  async function releaseSeat(current: ConnectionState): Promise<void> {
    const seat = current.seat;
    const acp = current.acp;
    current.seat = null;
    current.acp = null;
    current.sessionId = null;
    current.turn = null;
    if (!seat) return;
    // Dropped from the table before the async teardown starts, not after. The
    // cap slot has to be reclaimable the moment a seat begins dying, and the
    // browser must never be told a session closed while the pool still counts
    // it as live.
    options.pool.remove(seat);
    try {
      // Closing the ACP seat cancels any live turn and releases the connection
      // before the child goes away, so a half-dead seat is never left behind.
      if (acp) await acp.close();
      else if (seat.child) await seat.child.close();
    } finally {
      // Untracked only once the child is actually gone, so a concurrent
      // shutdown still knows it has something to reap.
      options.untrackSeat?.(seat.child);
    }
  }

  async function openSession(command: Extract<BrowserCommand, { type: "session.open" }>) {
    if (state.seat) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "seat-busy",
        message: "this connection already holds a session",
      });
      return;
    }

    const projectPath = options.projects.resolve(command.projectId);
    if (projectPath === null) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "not-found",
        message: `unknown project ${command.projectId}`,
      });
      return;
    }

    try {
      const opened = await options.runner.open(
        {
          harness: "opencode",
          projectId: command.projectId,
          projectPath,
          // The browser cannot choose a posture; the server derives it.
          access: "full",
        },
        (turnId, event) => forwardSeatEvent(state, turnId, event),
        (request) => askPermission(request),
      );
      state.seat = opened.seat;
      state.acp = opened.acp;
      state.sessionId = opened.info.sessionId;
      options.pool.touch(opened.seat);
      options.trackSeat?.(opened.child);

      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: true,
        reason: "ok",
      });
      emit({
        type: "session.opened",
        commandId: command.commandId,
        sessionId: opened.info.sessionId,
        projectId: command.projectId,
        cwd: projectPath,
        configOptions: opened.info.configOptions,
      });
      options.onAudit?.({
        sessionId: state.sessionId,
        action: "session.open",
        detail: `seat ${opened.seat.id} profile ${opened.profile.label}`,
      });
    } catch (err) {
      fail(
        command,
        err instanceof SeatOpenError
          ? err
          : new SeatOpenError("initialize-failed", (err as Error).message),
      );
    }
  }

  /** Emits exactly one terminal event per turn, even on a cancel race. */
  function finishTurn(turnId: string, stopReason: TurnStopReason): void {
    if (state.turn === null || state.turn.id !== turnId) return;
    if (state.turn.closed) return;
    state.turn.closed = true;
    const sessionId = state.sessionId;
    if (sessionId === null) return;
    emit({ type: "turn.completed", sessionId, turnId, stopReason });
    // Whatever the turn was waiting on is now moot. Leaving it open would hold
    // the harness on a question nobody can answer any more.
    resolveOutstandingPermissions(stopReason === "cancelled" ? "cancelled" : "revoked");
    armIdleTimer();
  }

  /**
   * Closes an abandoned session.
   *
   * A seat that is never used again must not hold its harness process open
   * indefinitely: one tab left open is one permanently running agent. The
   * browser is told the session is gone, so the UI cannot sit on a live pill
   * for a session that no longer exists.
   */
  function armIdleTimer(): void {
    const seat = state.seat;
    if (seat === null) return;
    options.pool.startIdleTimer(seat, (expired) => {
      // Re-checked: the user may have acted between arming and expiry.
      if (state.seat !== expired) return;
      const sessionId = state.sessionId;
      if (sessionId === null) return;
      if (state.turn !== null && !state.turn.closed) return;
      options.onAudit?.({
        sessionId,
        action: "session.idle",
        detail: "closed after the idle timeout",
      });
      emit({
        type: "session.closed",
        sessionId,
        reason: "idle-timeout",
        message: "this session was closed after sitting idle",
      });
      void releaseSeat(state);
    });
  }

  /** Any user activity means the session is not abandoned. */
  function clearIdleTimer(): void {
    if (state.seat) options.pool.clearIdleTimer(state.seat);
  }

  function forwardSeatEvent(
    current: ConnectionState,
    turnId: string,
    event: SeatStreamEvent,
  ): void {
    // Returning false is the signal the seat uses to end the turn.
    const sessionId = current.sessionId;
    if (sessionId === null) return;
    if (current.turn === null || current.turn.id !== turnId) return;
    if (current.turn.closed) return;
    if (event.kind === "text" || event.kind === "thought") {
      const ok = emit({
        type: "turn.delta",
        sessionId,
        turnId,
        stream: event.kind,
        text: event.text,
      });
      if (!ok) current.acp?.cancel();
      return;
    }
    const ok = emit({
      type: "tool.updated",
      sessionId,
      turnId,
      toolCallId: event.toolCallId,
      // A harness title is unbounded; the wire caps it, so a long one is
      // truncated rather than dropped whole.
      title: event.title.slice(0, 500),
      status: event.status,
      lifecycle: "active",
    });
    if (!ok) current.acp?.cancel();
  }

  async function applyConfig(
    command: Extract<BrowserCommand, { type: "session.configure" }>,
  ): Promise<void> {
    if (state.sessionId !== command.sessionId || state.acp === null) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "not-found",
        message: "no such session on this connection",
      });
      return;
    }
    clearIdleTimer();
    if (state.turn !== null && !state.turn.closed) {
      // A harness may reject a model change mid-turn, and the failure would be
      // indistinguishable from a turn failure. Refusing up front is honest.
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "busy",
        message: "wait for the current turn to finish before changing settings",
      });
      return;
    }
    try {
      // The harness answers with the full snapshot, so the menu is refreshed
      // from what was actually applied rather than from a local guess.
      const options = await state.acp.setConfigOption(
        command.configOptionId,
        command.value,
      );
      // Only report success if the refreshed snapshot was actually delivered;
      // otherwise the browser would believe a change it never received.
      const delivered = setConfigOptions(options);
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: delivered,
        reason: delivered ? "ok" : "internal",
        ...(delivered ? {} : { message: "the refreshed settings could not be delivered" }),
      });
    } catch (err) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: classifyConfigFailure(err),
        message: (err as Error).message.slice(0, 500),
      });
    }
  }

  async function runTurn(
    command: Extract<BrowserCommand, { type: "session.prompt" }>,
  ): Promise<void> {
    if (state.sessionId !== command.sessionId || state.acp === null) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "not-found",
        message: "no such session on this connection",
      });
      return;
    }
    if (state.turn !== null && !state.turn.closed) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "busy",
        message: "a turn is already running on this session",
      });
      return;
    }
    clearIdleTimer();
    if (state.acp.busy) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "busy",
        message: "the harness is still producing the previous turn",
      });
      return;
    }

    state.turn = { id: command.turnId, closed: false };
    emit({ type: "turn.started", sessionId: command.sessionId, turnId: command.turnId });
    emit({ type: "command.result", commandId: command.commandId, ok: true, reason: "ok" });

    try {
      const stopReason = await state.acp.prompt(command.turnId, command.text);
      finishTurn(command.turnId, stopReason);
    } catch (err) {
      // A turn that fails must still terminate, or the working dots never stop.
      options.onAudit?.({
        sessionId: command.sessionId,
        action: "turn",
        detail: `failed: ${(err as Error).message}`,
      });
      finishTurn(command.turnId, "k5-error");
      if (err instanceof AcpAuthRequiredError) {
        emit({
          type: "session.failed",
          sessionId: command.sessionId,
          reason: "auth-required",
          message: (err as Error).message.slice(0, 500),
        });
      }
    } finally {
      // The seat may already have been released by a close or a socket drop
      // while this turn was in flight; touching a null seat would throw inside a
      // finally block and take the process down.
      if (state.seat) options.pool.touch(state.seat);
    }
  }

  function closeSession(commandId: string, sessionId: string, reason: string) {
    if (state.sessionId !== sessionId) {
      emit({
        type: "command.result",
        commandId,
        ok: false,
        reason: "not-found",
        message: "no such session on this connection",
      });
      return;
    }
    emit({ type: "command.result", commandId, ok: true, reason: "ok" });
    emit({ type: "session.closed", sessionId, reason });
    if (state.seat) {
      emit({ type: "seat.reaped", sessionId, reason });
      state.releasing = releaseSeat(state);
    }
  }

  /**
   * Puts a harness permission request to the browser and waits for its answer.
   *
   * The promise must always settle. If the browser never answers, the harness
   * waits forever, so the seat's own abort signal (from the ACP runtime) and
   * the connection closing both release it.
   */
  function askPermission(request: AcpPermissionRequest): Promise<string | null> {
    const sessionId = state.sessionId;
    const turnId = state.turn?.id ?? null;
    if (sessionId === null || turnId === null) {
      return Promise.resolve(null);
    }
    const requestId = `perm-${++permissionCounter}`;
    const options = request.options.slice(0, 16);
    if (options.length === 0) return Promise.resolve(null);

    return new Promise<string | null>((resolve) => {
      const settle = (): void => {
        state.pendingPermissions.delete(requestId);
      };
      state.pendingPermissions.set(requestId, {
        optionIds: new Set(options.map((o) => o.optionId)),
        resolve: (optionId) => {
          settle();
          resolve(optionId);
        },
      });
      const delivered = emit({
        type: "permission.requested",
        requestId,
        sessionId,
        turnId,
        toolCallId: request.toolCallId,
        title: request.title,
        options,
      });
      // A socket that cannot carry the question can never answer it, so the
      // request is withdrawn instead of stranding the agent.
      if (!delivered) {
        settle();
        resolve(null);
      }
    });
  }

  /**
   * Answers every outstanding permission question and tells the browser why.
   *
   * Any path that leaves a question open strands the harness, which blocks on
   * `session/request_permission` until it is answered. It also strands the
   * browser, which would keep a prompt for a turn that no longer exists.
   */
  function resolveOutstandingPermissions(reason: PermissionResolvedReason): void {
    for (const [requestId, pending] of state.pendingPermissions) {
      pending.resolve(null);
      emit({ type: "permission.resolved", requestId, reason });
    }
    state.pendingPermissions.clear();
  }

  function decidePermission(
    command: Extract<BrowserCommand, { type: "permission.decide" }>,
  ) {
    const pending = state.pendingPermissions.get(command.requestId);
    if (!pending) {
      // A late or forged decision is rejected locally and never reaches the
      // agent. The record is single-use, so there is nothing to answer.
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "not-found",
        message: "no such pending permission",
      });
      emit({
        type: "permission.resolved",
        requestId: command.requestId,
        reason: "forged",
      });
      return;
    }
    if (command.optionId !== null && !pending.optionIds.has(command.optionId)) {
      // An option the server never offered is a forgery, not a preference.
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "invalid-payload",
        message: "option was not offered by the harness",
      });
      emit({
        type: "permission.resolved",
        requestId: command.requestId,
        reason: "forged",
      });
      return;
    }
    state.pendingPermissions.delete(command.requestId);
    pending.resolve(command.optionId);
    emit({ type: "command.result", commandId: command.commandId, ok: true, reason: "ok" });
    emit({
      type: "permission.resolved",
      requestId: command.requestId,
      reason: command.optionId === null ? "cancelled" : "selected",
    });
  }
}

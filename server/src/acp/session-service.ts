import path from "node:path";
import {
  resolveAccessProfile,
  type AttachmentManifestEntry,
  type BrowserCommand,
  type CommandFailureReason,
  type ConfigOptionSummary,
  type ServerEvent,
} from "@k5-work/shared";
import type { AcceptedConnection, ConnectionHandlers } from "../ws/gateway.js";
import { SeatOpenError, type SeatRunner } from "./seat-runner.js";
import { AcpAuthRequiredError } from "./probe.js";
import { AcpCapabilityError } from "./acp-seat.js";
import type { AcpSeat, SeatStreamEvent } from "./acp-seat.js";
import { planPromptBlocks, type PlannedPrompt } from "./prompt-blocks.js";
import type { TurnCompletedEvent } from "@k5-work/shared";
type TurnStopReason = TurnCompletedEvent["stopReason"];
import type { AcpChild } from "./spawn.js";
import type { Seat, SeatPool } from "./seat-pool.js";
import type { ResolvedPosture } from "./posture.js";

/**
 * A well-formed id for "this session is not being recorded". The contract requires
 * a real id so the browser never has to special-case a missing field, and the
 * reducer checks for this value rather than treating any id as fetchable.
 */
const EMPTY_STORE_ID = "00000000-0000-4000-8000-000000000000";

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
   * The durable store. k5 owns the transcript, so every event the service emits
   * is recorded before it is sent: the store is the record of what happened,
   * the socket is only a viewer, and a browser that vanished must not cost us
   * the turn.
   */
  recorder?: SessionRecorder;
  /**
   * Registers each seat child so a hard shutdown still reaps it. Reaping on
   * close is the normal path, but a seat can outlive its socket if the process
   * is going down at the wrong moment.
   */
  trackSeat?: (child: AcpChild) => void;
  untrackSeat?: (child: AcpChild | null) => void;
  /**
   * Reports every harness process this connection has spawned, including one a
   * read is still awaiting. A read holds no pool slot, so this is the only way a
   * caller can assert that a list left nothing running.
   */
  onChild?: (child: AcpChild) => void;
  /** Maps a wire failure reason onto the closed CommandFailureReason union. */
  onAudit?: (entry: {
    sessionId: string | null;
    action: string;
    detail: string;
  }) => void;
}

/**
 * The slice of the store the service needs. Narrow on purpose: the service owns
 * orchestration, so it records events and asks for a title, and knows nothing
 * about directories, byte caps or sequence numbers.
 */
export interface SessionRecorder {
  create(input: {
    harness: string;
    harnessSessionId: string;
    projectId: string;
    projectName: string | null;
    cwd: string;
    title?: string;
  }): Promise<{ storeId: string }>;
  append(storeId: string, event: ServerEvent): void;
  /** Makes the summary durable, so the sidebar sees a finished task. */
  flush(storeId: string): Promise<void>;
  /**
   * Applies a harness-supplied title to an already-recorded session.
   */
  setTitle(storeId: string, title: string, updatedAt?: string | null): void;
  /** Falls back to the opening prompt when the harness never names the session. */
  titleFromPrompt(storeId: string, prompt: string): void;
  /**
   * Drops a record that was created for a connection that went away before the
   * session was ever announced. Without it a tab closed mid-open leaves a blank
   * row in the sidebar forever.
   */
  remove(storeId: string): Promise<boolean>;
  /**
   * The record a store id names, or null. The service needs the recorded cwd and
   * harness session id to validate and continue a task, and must not learn the
   * store's shape to get them.
   */
  stored(storeId: string): { projectId: string; cwd: string; harnessSessionId: string } | null;
  /**
   * The manifest a spooled attachment was stored under, and its bytes.
   *
   * Two calls rather than one object because a store may hold many attachments:
   * the manifest is identity and provenance, and the bytes are the payload, and
   * the service must be able to refuse a turn for a missing attachment before it
   * has read anything large. Both are keyed by a k5 store id the service already
   * has, so a browser can never name a path.
   */
  attachmentManifest(storeId: string, attachmentId: string): Promise<AttachmentManifestEntry>;
  readAttachment(storeId: string, attachmentId: string): Promise<Buffer>;
}

interface ConnectionState {
  sessionId: string | null;
  /** The k5-minted id of the recorded transcript, or null when not recording. */
  storeId: string | null;
  seat: Seat | null;
  /** The live ACP connection, or null between sessions. */
  acp: AcpSeat | null;
  /**
   * Set while `session.open` is awaiting the harness. The `state.seat` guard
   * cannot see an open that has not finished spawning, so a second command
   * arriving in that window read a null seat and opened a second harness. The
   * loser was left tracked and never reaped.
   */
  opening: boolean;
  /** The turn currently running, so cancel and terminal events can be matched. */
  turn: { id: string; closed: boolean } | null;
  /** Set while a seat is being torn down; awaited by waitForIdle. */
  releasing: Promise<void> | null;
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
  // Read tracking, declared with the rest of the per-connection state.
  let headlessInFlight = 0;
  let headlessIdle: Promise<void> = Promise.resolve();
  let headlessResolve: (() => void) | null = null;

  const state: ConnectionState = {
    sessionId: null,
    storeId: null,
    seat: null,
    acp: null,
    opening: false,
    turn: null,
    releasing: null,
    closed: false,
  };

  /**
   * The one diagnostic path. process.stderr can raise EPIPE when the terminal or
   * a log pipe goes away, and with no error listener that is an uncaught
   * exception: the two "never break a live turn" guards would then take the
   * process down mid-turn, losing the turn, every live harness child, and every
   * unflushed store write.
   */
  const warn = (message: string): void => {
    try {
      process.stderr.write(message);
    } catch {
      // A broken diagnostic channel is not a reason to fail a turn.
    }
  };

  /**
   * Records an event to the durable log.
   *
   * Called for every event the service produces, including ones the socket never
   * receives. The store filters the non-persisted variants itself, so this does
   * not need to know which they are.
   */
  const record = (event: ServerEvent): void => {
    const storeId = state.storeId;
    if (storeId === null) return;
    try {
      options.recorder?.append(storeId, event);
    } catch (err) {
      // Recording must never break a live turn. The store is written not to
      // throw on append, but a defensive boundary here is cheap and the
      // consequence of getting it wrong is a wedged seat.
      warn(`k5 could not record a ${event.type} event: ${String(err)}\n`);
    }
  };

  /**
   * Returns false instead of throwing when the event could not be delivered.
   * `AcceptedConnection.send` throws on a contract violation, and that call
   * happens from inside the seat's update pump: an exception there would leave
   * the turn with no terminal event and the working dots spinning forever.
   */
  const emit = (event: ServerEvent): boolean => {
    // Recorded before the send, and regardless of its outcome, because the log
    // is the record of what happened rather than of what a viewer received.
    record(event);
    if (state.closed) return false;
    try {
      // On overflow the gateway closes the socket and calls overflow() first.
      return connection.send(event);
    } catch (err) {
      // A contract violation must be visible: silently dropping it is how a
      // browser ends up waiting forever on an event that was never sent.
      warn(`k5 dropped an invalid ${String(event.type)} event: ${(err as Error).message}\n`);
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
        case "session.list":
          void listSessions(command);
          return;
        case "session.load":
          void loadSession(command);
          return;
        default: {
          // A command with no handler would otherwise be accepted, validated and
          // dropped, and the browser would wait forever for a result. Compiling
          // this line is the point: adding a command without handling it is an
          // error, exactly as adding an event without rendering it is.
          const unhandled: never = command;
          warn(`k5 has no handler for ${(unhandled as BrowserCommand).type}\n`);
          emit({
            type: "command.result",
            commandId: (unhandled as BrowserCommand).commandId,
            ok: false,
            reason: "unknown-command",
            message: "this build has no handler for that command",
          });
        }
      }
    },

    overflow() {
      // The socket is about to close, so a seat is released now rather than
      // leaving a harness running behind a connection that can no longer answer.
      if (state.seat) state.releasing = releaseSeat(state);
    },

    closed() {
      state.closed = true;
      // A tab that closes mid-turn must not leave the seat or the agent running.
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

  async function releaseSeat(
    current: ConnectionState,
    reapedAlready = false,
  ): Promise<void> {
    const seat = current.seat;
    const acp = current.acp;
    const storeId = current.storeId;
    const sessionId = current.sessionId;
    // Captured before the state is cleared: a turn that was still open at this
    // point is the one that needs a terminator in the stored log.
    const turnWasOpen = current.turn !== null && !current.turn.closed;
    if (!seat) return;

    // Recorded while the state is still intact, because record() reads
    // state.storeId. A stored transcript needs an ending even when the socket is
    // the thing that went away: without this the log stops mid-turn with no
    // terminal event, and a reloaded session shows tool cards spinning forever.
    //
    // The TURN is terminated rather than only reaping the seat, so the turn has
    // a stop reason and its in-flight cards get the same correction a normal
    // end applies. A reap on its own would leave stopReason null.
    if (storeId !== null && sessionId !== null && turnWasOpen && !reapedAlready) {
      const openTurnId = current.turn?.id;
      if (openTurnId !== undefined) {
        record({
          type: "turn.completed",
          sessionId,
          turnId: openTurnId,
          stopReason: "k5-cancelled",
        });
      }
      record({ type: "seat.reaped", sessionId, reason: "connection-ended" });
    } else if (storeId !== null && sessionId !== null && turnWasOpen) {
      // The teardown already emitted a reap for this seat, so only the turn is
      // left to terminate.
      const openTurnId = current.turn?.id;
      if (openTurnId !== undefined) {
        record({
          type: "turn.completed",
          sessionId,
          turnId: openTurnId,
          stopReason: "k5-cancelled",
        });
      }
    }
    if (storeId !== null) {
      void options.recorder?.flush(storeId).catch(() => {});
    }

    current.seat = null;
    current.acp = null;
    current.sessionId = null;
    current.storeId = null;
    current.turn = null;

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
    // The in-flight latch, not just `state.seat`: an open that is still awaiting
    // the harness has not assigned a seat yet, so a second command in that window
    // used to read a null seat and start a second harness. The loser stayed
    // tracked and was never reaped.
    if (state.seat || state.opening) {
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

    state.opening = true;
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
      );
      state.seat = opened.seat;
      state.acp = opened.acp;
      state.sessionId = opened.info.sessionId;
      options.pool.touch(opened.seat);
      options.trackSeat?.(opened.child);

      // The transcript is created before anything is reported, and awaited, so
      // the store's meta write is durable by the time the browser is told the
      // session exists. A record that only lands later is a session the user
      // never finds in the sidebar again.
      if (options.recorder) {
        const projectName = path.basename(projectPath) || null;
        const created = await options.recorder.create({
          harness: "opencode",
          harnessSessionId: opened.info.sessionId,
          projectId: command.projectId,
          projectName,
          cwd: projectPath,
        });
        // The tab may have closed inside that await, in which case the seat has
        // already been released and nothing will ever claim this record. Left
        // behind it is a blank row in the sidebar with an empty transcript.
        if (state.seat !== opened.seat) {
          await options.recorder.remove(created.storeId).catch(() => {});
          options.untrackSeat?.(opened.child);
          await opened.child.close().catch(() => {});
          options.pool.remove(opened.seat);
          return;
        }
        state.storeId = created.storeId;
      }

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
        // Null only when no recorder is wired, which the browser treats as "this
        // session is not durable" rather than as an id it can fetch.
        storeId: state.storeId ?? EMPTY_STORE_ID,
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
    } finally {
      state.opening = false;
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
    // A finished task is what the sidebar lists, so the summary is made durable
    // now rather than whenever the process next happens to exit.
    if (state.storeId !== null) {
      void options.recorder?.flush(state.storeId).catch(() => {});
    }
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
      state.releasing = releaseSeat(state, true);
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
    if (event.kind === "session") {
      // A session-level fact, not turn content, so it is emitted and applied to
      // the stored summary. It carries no turnId of its own.
      if (event.title !== null && current.storeId !== null) {
        try {
          options.recorder?.setTitle(current.storeId, event.title, event.updatedAt);
        } catch (err) {
          warn(`k5 could not record a session title: ${String(err)}\n`);
        }
      }
      emit({
        type: "session.updated",
        sessionId,
        title: event.title === null ? null : event.title.slice(0, 200),
        updatedAt: event.updatedAt,
      });
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

  /**
   * Resolves every ref the browser named to bytes k5 actually holds, and refuses
   * the turn if any of them cannot be produced.
   *
   * A missing attachment is refused rather than skipped. The user's bytes would
   * not reach the model, and a turn that started anyway would claim otherwise —
   * which is the same lie as reporting a truncated log as complete.
   */
  async function resolveAttachments(
    command: Extract<BrowserCommand, { type: "session.prompt" }>,
  ): Promise<
    | { manifest: AttachmentManifestEntry[]; plan: PlannedPrompt }
    | { refusal: { reason: "not-found" | "capability-unsupported"; message: string } }
  > {
    const storeId = state.storeId;
    const recorder = options.recorder;
    if (storeId === null || recorder === undefined) {
      return {
        refusal: {
          reason: "not-found",
          message: "this session is not recording attachments, so there is nothing to read them from",
        },
      };
    }
    const attachments: { manifest: AttachmentManifestEntry; bytes: Buffer }[] = [];
    for (const ref of command.attachments) {
      try {
        const manifest = await recorder.attachmentManifest(storeId, ref.attachmentId);
        const bytes = await recorder.readAttachment(storeId, ref.attachmentId);
        attachments.push({ manifest, bytes });
      } catch (err) {
        return {
          refusal: {
            reason: "not-found",
            message: `attachment ${ref.attachmentId} is not in the store: ${(err as Error).message.slice(0, 300)}`,
          },
        };
      }
    }
    const acp = state.acp;
    // The seat is the only thing that knows what the harness can accept, so the
    // gate is read from the live connection rather than from configuration.
    const plan = planPromptBlocks({
      text: command.text,
      attachments,
      caps: { embeddedContext: acp === null ? false : acp.capabilities.embeddedContext },
    });
    if (plan.refused.length > 0) {
      const names = plan.refused.map((entry) => entry.name).join(", ");
      return {
        refusal: {
          reason: "capability-unsupported",
          message: `this harness cannot accept embedded content, so ${names} could not be delivered`,
        },
      };
    }
    return { manifest: attachments.map((entry) => entry.manifest), plan };
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
    // Captured once: the reads below await, and a close that lands in that window
    // clears the connection's seat, so a later property read would be a TypeError
    // from nowhere rather than the seat's own "closed" refusal.
    const seat = state.acp;
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
    if (seat.busy) {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason: "busy",
        message: "the harness is still producing the previous turn",
      });
      return;
    }

    // Before the idle timer is cleared and before state.turn is assigned, so a
    // refusal leaves nothing half-open: a turn that never started has no
    // terminator to forget, and an abandoned session still gets reaped.
    let attachments: AttachmentManifestEntry[] = [];
    let plan: PlannedPrompt | null = null;
    if (command.attachments.length > 0) {
      const resolved = await resolveAttachments(command);
      if ("refusal" in resolved) {
        emit({
          type: "command.result",
          commandId: command.commandId,
          ok: false,
          reason: resolved.refusal.reason,
          message: resolved.refusal.message.slice(0, 500),
        });
        return;
      }
      attachments = resolved.manifest;
      plan = resolved.plan;
    }

    clearIdleTimer();
    state.turn = { id: command.turnId, closed: false };
    // A title fallback, so a task is never a blank row. Only the first prompt
    // counts; the harness's own title wins if it sends one later.
    if (state.storeId !== null) {
      try {
        options.recorder?.titleFromPrompt(state.storeId, command.text);
      } catch (err) {
        warn(`k5 could not record a session title: ${String(err)}\n`);
      }
    }
    // The prompt rides on turn.started so the durable store can record what the
    // user asked. Without it a reloaded session shows only the assistant's half
    // of every exchange. The browser already holds this text and shows it
    // optimistically, so the live reducer ignores the field.
    emit({
      type: "turn.started",
      sessionId: command.sessionId,
      turnId: command.turnId,
      userText: command.text,
      attachments,
    });
    emit({ type: "command.result", commandId: command.commandId, ok: true, reason: "ok" });

    try {
      const stopReason = await seat.prompt(
        command.turnId,
        plan?.blocks ?? [{ type: "text", text: command.text }],
      );
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

  /**
   * Asks the harness what sessions it knows about for a project.
   *
   * A short-lived headless seat, reaped as soon as the read is done: the whole
   * point of the workspace's lazy spawn is that a list costs no lasting harness
   * process. A harness that does not advertise `session/list` is reported as
   * unsupported rather than as an empty list, because only one of those is a real
   * answer.
   */
  /**
   * Tracks an outstanding read so waitForIdle can see it.
   *
   * A shutdown that lands mid-list must wait for the read, or it exits with a
   * live harness behind it. An explicit deferred, not a poll: a timer loop here
   * would be both slower and less honest about when the work is actually done.
   */
  function headlessStarted(): void {
    if (headlessInFlight === 0) {
      headlessIdle = new Promise<void>((resolve) => {
        headlessResolve = resolve;
      });
    }
    headlessInFlight += 1;
    const previous = state.releasing;
    const current = headlessIdle;
    state.releasing = previous === null ? current : Promise.all([previous, current]).then(() => {});
  }

  function headlessFinished(): void {
    headlessInFlight = Math.max(0, headlessInFlight - 1);
    if (headlessInFlight === 0 && headlessResolve !== null) {
      headlessResolve();
      headlessResolve = null;
    }
  }

  async function listSessions(command: Extract<BrowserCommand, { type: "session.list" }>) {
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
    let headless: { child: AcpChild; acp: AcpSeat } | null = null;
    try {
      headless = await options.runner.openHeadless({
        projectId: command.projectId,
        projectPath,
        readOnly: true,
      });
      // Tracked before the read is awaited: a shutdown that lands while the read
      // is still outstanding must still know there is a process to reap.
      options.trackSeat?.(headless.child);
      options.onChild?.(headless.child);
      headlessStarted();
      const sessions = await headless.acp.listSessions();
      emit({ type: "command.result", commandId: command.commandId, ok: true, reason: "ok" });
      emit({
        type: "session.listed",
        commandId: command.commandId,
        projectId: command.projectId,
        sessions,
        unsupported: false,
      });
    } catch (err) {
      if (err instanceof AcpCapabilityError) {
        // Not a failure: the harness simply does not offer it.
        emit({ type: "command.result", commandId: command.commandId, ok: true, reason: "ok" });
        emit({
          type: "session.listed",
          commandId: command.commandId,
          projectId: command.projectId,
          sessions: [],
          unsupported: true,
        });
        return;
      }
      const reason = err instanceof SeatOpenError ? err.reason : "internal";
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason,
        message: (err as Error).message.slice(0, 500),
      });
    } finally {
      headlessFinished();
      // Reaped whatever happened, so a list never leaves a harness behind.
      if (headless !== null) {
        await headless.acp.close().catch(() => {});
        await headless.child.close().catch(() => {});
        options.untrackSeat?.(headless.child);
      }
    }
  }

  /**
   * Continues a stored session on the harness.
   *
   * The stored cwd is re-validated rather than trusted. What this actually
   * proves is that k5's own record is self-consistent: the task is being reopened
   * from the same project directory it was recorded in. It does NOT prove the
   * harness agrees — nothing here reads the harness's own cwd for the session, and
   * a directory replaced in place has an identical path string. Refusing a moved
   * project is the part worth having.
   * The harness session id never comes from the browser — it is read back from
   * the store, keyed by the k5 store id the browser is allowed to name.
   */
  async function loadSession(command: Extract<BrowserCommand, { type: "session.load" }>) {
    const refuse = (reason: CommandFailureReason, message: string): void => {
      emit({
        type: "command.result",
        commandId: command.commandId,
        ok: false,
        reason,
        message: message.slice(0, 500),
      });
    };
    if (state.seat || state.opening) {
      refuse("seat-busy", "this connection already holds a session");
      return;
    }
    const stored = options.recorder?.stored(command.storeId) ?? null;
    if (options.recorder === undefined || stored === null) {
      refuse("session-unknown", "no such stored session");
      return;
    }
    const projectPath = options.projects.resolve(stored.projectId);
    if (projectPath === null) {
      refuse("cwd-mismatch", "the project this task belonged to is no longer available");
      return;
    }
    // The canonical path is the comparison, not the stored string: a project can
    // be reached by more than one path and only the canonical form means
    // anything.
    if (projectPath !== stored.cwd) {
      refuse(
        "cwd-mismatch",
        `this task was recorded in ${stored.cwd}, which is not the project it is being opened from`,
      );
      return;
    }

    state.opening = true;
    let headless: { child: AcpChild; acp: AcpSeat } | null = null;
    try {
      headless = await options.runner.openHeadless({
        projectId: stored.projectId,
        projectPath,
      });
      // Tracked before the adopt is awaited, for the same reason as the list.
      options.trackSeat?.(headless.child);
      options.onChild?.(headless.child);
      headlessStarted();
      const info = await headless.acp.adopt(stored.harnessSessionId);
      // The read seat is now a live session, so it takes a pool slot under the
      // same key a fresh open would: one seat and one turn pump either way.
      const seat = options.runner.promoteAdopted({
        harness: "opencode",
        projectId: stored.projectId,
        projectPath,
        child: headless.child,
        acp: headless.acp,
        sessionId: info.sessionId,
      });
      state.seat = seat;
      state.acp = headless.acp;
      state.sessionId = info.sessionId;
      state.storeId = command.storeId;
      // Ownership has moved to the connection, so neither the finally block nor a
      // later throw may reap a seat the pool now counts as active.
      headless = null;

      emit({ type: "command.result", commandId: command.commandId, ok: true, reason: "ok" });
      emit({
        type: "session.opened",
        commandId: command.commandId,
        sessionId: info.sessionId,
        storeId: command.storeId,
        projectId: stored.projectId,
        cwd: projectPath,
        configOptions: info.configOptions,
      });
      emit({
        type: "session.loaded",
        commandId: command.commandId,
        storeId: command.storeId,
        sessionId: info.sessionId,
        projectId: stored.projectId,
        cwd: projectPath,
        configOptions: info.configOptions,
      });
      // After the ownership move and wrapped, because a throwing audit sink would
      // otherwise be caught as a load failure while the connection already holds a
      // live seat and the browser has already been told it opened.
      try {
        options.onAudit?.({
          sessionId: info.sessionId,
          action: "session.load",
          detail: `store ${command.storeId} seat ${seat.id}`,
        });
      } catch (err) {
        warn(`k5 audit sink failed: ${String(err)}\n`);
      }
    } catch (err) {
      const reason =
        err instanceof AcpCapabilityError
          ? "capability-unsupported"
          : err instanceof SeatOpenError
            ? err.reason
            : "internal";
      refuse(reason, (err as Error).message);
    } finally {
      state.opening = false;
      headlessFinished();
      if (headless !== null) {
        await headless.acp.close().catch(() => {});
        await headless.child.close().catch(() => {});
        options.untrackSeat?.(headless.child);
      }
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
      state.releasing = releaseSeat(state, true);
    }
  }
}

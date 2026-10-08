import {
  client,
  PROTOCOL_VERSION,
  RequestError,
  type ActiveSession,
  type ClientContext,
  type ContentBlock,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AcpChild } from "./spawn.js";
import { MAX_CONFIG_OPTION_VALUES, MAX_CONFIG_OPTIONS } from "@k5-work/shared";
import { NO_CAPABILITIES, probeCapabilities, type AcpCapabilities } from "./capabilities.js";
import {
  attachSessionShim,
} from "./adopt.js";
import { classifySessionUpdate } from "./updates.js";
import type { ConfigOptionSummary } from "@k5-work/shared";

/** ACP caps a value label and the option id; mirrored so the wire stays bounded. */
/**
 * The wire caps a config option's values at the same number (shared, the 64 on
 * ConfigOptionValue). Named import rather than a literal, so raising one raises the
 * other and the truncation here is a compile error rather than a silent loss of
 * models a user could have picked.
 */
const MAX_OPTION_VALUES = MAX_CONFIG_OPTION_VALUES;
import { AcpAuthRequiredError, AcpProtocolMismatchError, AcpTerminalAuthUnsupportedError } from "./probe.js";

/**
 * A capability the harness never advertised, or an SDK that no longer exposes
 * the pump a feature needs. Distinct from AcpSeatError so the service can map it
 * to a wire reason the browser can render.
 */
export class AcpCapabilityError extends Error {
  readonly capability: "load" | "resume" | "list" | "pump";

  constructor(capability: AcpCapabilityError["capability"], message: string) {
    super(message);
    this.name = "AcpCapabilityError";
    this.capability = capability;
  }
}

export class AcpSeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpSeatError";
  }
}

export type SeatStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type SeatStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      status: "pending" | "in_progress" | "completed" | "failed";
    }
  // The harness's own title, which it generates after the first exchange. It is
  // a session-level fact rather than turn content, so it carries no turnId.
  | { kind: "session"; title: string | null; updatedAt: string | null };

export interface AcpSeatOptions {
  cwd: string;
  clientName?: string;
  openTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export interface AcpSeatInfo {
  /** Empty on a headless seat, which has no ACP session yet. */
  sessionId: string;
  /** The harness's own options, including each select value and its label. */
  configOptions: ConfigOptionSummary[];
  capabilities: AcpCapabilities;
}

const DEFAULT_OPEN_TIMEOUT_MS = 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;

// How long a cancelled or timed-out turn is given for the harness to send its
// trailing updates and a stop before the seat is declared unusable. The SDK's
// AbortSignal only *sends* `$/cancelRequest`; it never settles the local request,
// so without a local escape and this bound a cancel would hang forever.
const CANCEL_DRAIN_MS = 5_000;

/**
 * How long close() waits for the update pump to notice the seat is closing.
 *
 * The pump now ends on a signal rather than on the stream breaking, so it should
 * stop almost immediately. The bound exists so a pump wedged behind a read that
 * never returns cannot hold the teardown: past this, the child close that
 * follows is what guarantees nothing is left alive.
 */
const ACP_PUMP_STOP_MS = 2_000;

/**
 * How long the seat waits for a quiet stream before ending a turn.
 *
 * ACP does not promise the prompt response is the last thing on the wire: an
 * agent may answer and then flush chunks it had already produced. Settling the
 * turn on the response therefore races the last chunk, and the chunk that loses
 * is recorded after `turn.completed`, where nothing can use it — the transcript
 * reads back one word short of what the harness actually said.
 *
 * So the response arms this window instead of ending the turn, and every update
 * that arrives inside it pushes the deadline out. A harness that has more to
 * say is taken at its word; one that has finished falls silent and the turn
 * ends. It is short because trailing chunks are already buffered and arrive in
 * the same batch, so this only has to outlast that batch, not a slow model.
 */
const QUIET_BEFORE_SETTLE_MS = 150;

/** A promise and the one function that settles it. */
function createClosingSignal(): { promise: Promise<void>; signal: () => void } {
  let signal!: () => void;
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { promise, signal };
}

/** Resolves true when the promise settles first, false when the bound wins. */
async function settleOrTimeout(pending: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([pending.then(() => true, () => true), guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Arms the drain bound the moment this turn's signal aborts, and disarms it
 * again if the turn finishes on its own.
 *
 * The signal fires for a user cancel and for the turn timeout, and in both cases
 * the SDK has only *sent* `$/cancelRequest` — it never settles the local request,
 * so without a local escape the promise hangs and the seat is pinned open
 * forever. The bound therefore has to start at the abort, not at the prompt.
 */
function armDrainOnAbort(turn: ActiveTurn, onDrain: () => void): void {
  let timer: NodeJS.Timeout | null = null;
  const arm = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      if (turn.settled) return;
      onDrain();
    }, CANCEL_DRAIN_MS);
    timer.unref();
  };
  if (turn.controller.signal.aborted) {
    arm();
    return;
  }
  turn.controller.signal.addEventListener("abort", arm, { once: true });
  // A turn that ends normally must not leave a timer holding the loop open.
  // `finished` rejects when the turn fails, so both outcomes are handled: a bare
  // `finally` here would manufacture a second rejected promise with no handler.
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      return;
    }
    turn.controller.signal.removeEventListener("abort", arm);
  };
  void turn.finished.then(disarm, disarm);
}

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  /** Resolved when the SDK reports the turn stopped, not when prompt() returns. */
  settle: (stopReason: SeatStopReason) => void;
  fail: (err: unknown) => void;
  settled: boolean;
  finished: Promise<SeatStopReason>;
}

/**
 * A live ACP connection to one harness process.
 *
 * The probe opens a connection and closes it; a seat must stay connected for the
 * life of the session, so the SDK's `connectWith` callback is held open and turns
 * are driven from inside it. `session/update` is routed by session id and by the
 * turn that is currently active, so a notification left over from a previous turn
 * cannot be attributed to the current one.
 */
export class AcpSeat {
  private context: ClientContext | null = null;
  private session: ActiveSession | null = null;
  private info: AcpSeatInfo | null = null;
  private activeTurn: ActiveTurn | null = null;
  /**
   * When the current grace window ends, or null when none is open.
   *
   * Opened by a cancel and cleared by the first update that arrives inside it. It
   * replaces a list of abandoned turn ids, which only ever grew and so could not
   * distinguish "the harness is still finishing" from "the harness never stopped"
   * after the first cancel.
   */
  private graceUntilMs: number | null = null;
  /**
   * The stop reason the prompt response reported, held until the stream is quiet.
   *
   * Null when there is nothing pending. The turn is not ended by the response
   * itself: an agent may flush chunks after answering, and ending on the
   * response records those chunks after `turn.completed`, where the transcript
   * cannot use them. Holding the reason until the stream goes quiet puts every
   * chunk the harness sent inside the turn it belongs to.
   */
  private pendingStopReason: SeatStopReason | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  /** True while the seat's one pump is consuming the session's update stream. */
  private pumpRunning = false;
  /**
   * Resolved when close() begins, so the pump can stop instead of being torn
   * out from under a pending nextUpdate().
   *
   * A pending nextUpdate() has no abort of its own, so the only way to end the
   * pump is for it to notice the seat is closing. Close used to just close the
   * connection underneath it and move on, which left the pump running against a
   * stream whose child was dying and let it call onEvent for a seat that had
   * already been disposed.
   *
   * The resolver is created with the promise rather than assigned to a field
   * later: with useDefineForClassFields, a declared-but-unassigned field is
   * defined as undefined after any earlier field initializer runs, which would
   * silently clobber the assignment.
   */
  private readonly closing: { promise: Promise<void>; signal: () => void } = createClosingSignal();
  /** Why the stream broke, kept so the next turn can be refused with the reason. */
  private streamFailure: unknown = null;
  /** Outstanding update pump, awaited so a new turn never steals stale updates. */
  private pumpDone: Promise<void> = Promise.resolve();
  private poisonReason: string | null = null;
  /** Probed from the raw initialize result, leniently. */
  private caps: AcpCapabilities = NO_CAPABILITIES;
  private closed = false;
  private releaseLifetime!: () => void;
  private readonly lifetime: Promise<void>;

  readonly onEvent: ((turnId: string, event: SeatStreamEvent) => void) | null;

  private constructor(
    private readonly child: AcpChild,
    private readonly options: AcpSeatOptions,
    onEvent: ((turnId: string, event: SeatStreamEvent) => void) | null,
  ) {
    this.onEvent = onEvent;
    this.lifetime = new Promise<void>((resolve) => {
      this.releaseLifetime = resolve;
    });
  }

  static async open(
    child: AcpChild,
    options: AcpSeatOptions,
    onEvent: ((turnId: string, event: SeatStreamEvent) => void) | null,
  ): Promise<AcpSeat> {
    const seat = new AcpSeat(child, options, onEvent);
    await seat.handshake("new");
    return seat;
  }

  /**
   * Opens a connection with no ACP session.
   *
   * A read must not create a session: a page that lists tasks would otherwise
   * leave a new harness session behind on every load. The same headless seat then
   * adopts an existing session id through `adopt`, so there is one seat and one
   * turn pump either way.
   */
  static async openHeadless(
    child: AcpChild,
    options: AcpSeatOptions,
    onEvent: ((turnId: string, event: SeatStreamEvent) => void) | null,
  ): Promise<AcpSeat> {
    const seat = new AcpSeat(child, options, onEvent);
    await seat.handshake("headless");
    return seat;
  }

  private get openTimeoutMs(): number {
    return this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  }

  private async handshake(mode: "new" | "headless"): Promise<void> {
    const seat = this;
    const app = client({ name: this.options.clientName ?? "k5-work" });
    // There is no permission screen, so a harness that asks is refused rather
    // than left waiting. The handler must exist: without one the request goes
    // unanswered and the harness blocks on it for the rest of the turn, which is
    // worse than a visible refusal. Fail-closed is the only honest answer while
    // nobody can be asked.
    app.onRequest("session/request_permission", () => ({
      outcome: { outcome: "cancelled" },
    }));

    const settled = new Promise<AcpSeatInfo>((resolve, reject) => {
      void app
        .connectWith(this.child.stream, async (ctx) => {
          try {
            const init = await ctx.request(
              "initialize",
              {
                protocolVersion: PROTOCOL_VERSION,
                // Nothing is advertised that k5 has no handler behind. The fs
                // pair is the load-bearing one: it is why k5 never sends a
                // `resource_link`, whose whole contract is that the agent asks
                // the client to read a path. Attached files go out as inline
                // `resource` blocks instead — see prompt-blocks.ts.
                clientCapabilities: {
                  fs: { readTextFile: false, writeTextFile: false },
                  terminal: false,
                  auth: { terminal: false },
                },
                clientInfo: { name: seat.options.clientName ?? "k5-work", version: "0.1.0" },
              },
              { cancellationSignal: AbortSignal.timeout(seat.openTimeoutMs) },
            );
            if (init.protocolVersion !== PROTOCOL_VERSION) {
              throw new AcpProtocolMismatchError(init.protocolVersion);
            }
            // Probed leniently and off the raw object: the SDK never validates
            // this response on the client path, and its generated schema drops a
            // mis-shaped field silently. A strict parse here would fail the seat
            // open for a harness that merely spelled a capability differently.
            seat.caps = probeCapabilities(init);
            for (const field of seat.caps.mismatches) {
              process.stderr.write(
                `k5: the harness advertised ${field} in a shape k5 does not read; treating it as unsupported\n`,
              );
            }

            const methods = (init.authMethods ?? []) as {
              id: string;
              type?: string;
            }[];
            const terminal = methods.filter((m) => m.type === "terminal");
            if (terminal.length > 0) {
              throw new AcpTerminalAuthUnsupportedError(terminal[0].id);
            }
            const agentAuth = methods.filter((m) => m.type !== "terminal");
            if (agentAuth.length > 0) {
              try {
                await ctx.request(
                  "authenticate",
                  { methodId: agentAuth[0].id },
                  { cancellationSignal: AbortSignal.timeout(seat.openTimeoutMs) },
                );
              } catch (err) {
                if (err instanceof RequestError && err.code === -32000) {
                  throw new AcpAuthRequiredError(
                    `auth method ${agentAuth[0].id} requires sign-in`,
                  );
                }
                throw err;
              }
            }

            seat.context = ctx;
            if (mode === "headless") {
              // No session is created. The connection is still held for the
              // seat's lifetime so a later adopt, or a list, has a live context.
              resolve({
                sessionId: "",
                configOptions: [],
                capabilities: seat.caps,
              });
              await seat.lifetime;
              return;
            }

            const active = await ctx.buildSession(seat.options.cwd).start({
              cancellationSignal: AbortSignal.timeout(seat.openTimeoutMs),
            });
            const created = active.newSessionResponse;
            seat.session = active;
            seat.info = {
              sessionId: created.sessionId,
              configOptions: summarizeOptions(created.configOptions ?? []),
              capabilities: seat.caps,
            };
            resolve(seat.info);
            // Held for the seat's lifetime: connectWith closes the connection
            // when this resolves, which would end every later turn.
            await seat.lifetime;
          } catch (err) {
            reject(err);
          }
        })
        .catch(reject);
    });

    try {
      await settled;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  get sessionId(): string {
    if (this.info === null) throw new AcpSeatError("seat has no session");
    return this.info.sessionId;
  }

  /** What the harness said it supports, probed leniently at handshake. */
  get capabilities(): AcpCapabilities {
    return this.caps;
  }

  /**
   * Adopts an existing harness session so this seat can prompt it.
   *
   * `session/resume` is the continue path, and `session/load` is deliberately
   * not used for it. k5 holds the transcript itself, so a replay would be history
   * it already has; worse, `session/load` streams that replay and then responds,
   * and the SDK offers no way to tell a drained queue from an empty one. Draining
   * it would either truncate the replay or leave a task blocked on `nextUpdate()`
   * that then swallows the next live turn's updates.
   *
   * The attach MUST happen before the request is issued. It is the only thing
   * that gives a session a per-session update queue, and without it every
   * notification for the adopted session is dropped on the floor.
   */
  async adopt(sessionId: string): Promise<AcpSeatInfo> {
    if (this.closed) throw new AcpSeatError("seat is closed");
    if (this.session !== null) throw new AcpSeatError("seat already has a session");
    const context = this.context;
    if (context === null) throw new AcpSeatError("seat has no ACP context");
    if (!this.capabilities.resume) {
      throw new AcpCapabilityError("resume", "this harness does not offer session/resume");
    }

    // Attached first, before the request, and released again if the request
    // fails, so a transient refusal does not leave the seat permanently
    // un-adoptable behind an attached queue nobody reads.
    const attached = attachSessionShim(context, sessionId);
    if (attached === null) {
      throw new AcpCapabilityError(
        "resume",
        "the installed ACP SDK does not expose the session pump this seat needs",
      );
    }

    let response: { configOptions?: unknown; modes?: unknown };
    try {
      response = (await context.request(
        "session/resume",
        { sessionId, cwd: this.options.cwd, mcpServers: [] },
        // Bounded, for the same reason a read is: an unanswered resume would hold
        // the child open and wedge the connection that asked.
        { cancellationSignal: AbortSignal.timeout(this.openTimeoutMs) },
      )) as { configOptions?: unknown; modes?: unknown };
    } catch (err) {
      attached.dispose();
      throw err;
    }
    this.session = attached;

    // The response carries no sessionId, so the id is the one we asked for.
    this.info = {
      sessionId,
      configOptions: summarizeOptions(
        Array.isArray(response.configOptions) ? (response.configOptions as never[]) : [],
      ),
      capabilities: this.capabilities,
    };
    return this.info;
  }

  get configOptions(): ConfigOptionSummary[] {
    return this.info?.configOptions ?? [];
  }

  /**
   * Applies a config option and returns the harness's re-synced snapshot.
   *
   * The response carries the full set with current values, so the browser's
   * menu is refreshed from the harness rather than from a local guess that could
   * drift from what was actually applied.
   */
  async setConfigOption(
    configId: string,
    value: string | boolean,
  ): Promise<ConfigOptionSummary[]> {
    if (this.closed) throw new AcpSeatError("seat is closed");
    if (this.context === null) throw new AcpSeatError("seat has no ACP context");
    const known = this.configOptions.find((o) => o.id === configId);
    if (!known) {
      throw new AcpSeatError(`harness did not advertise a "${configId}" option`);
    }
    if (known.type === "boolean" && typeof value !== "boolean") {
      throw new AcpSeatError(`"${configId}" expects a boolean value`);
    }
    if (
      known.type === "select" &&
      (typeof value !== "string" || !known.values.some((v) => v.value === value))
    ) {
      // A value the harness never offered is a forgery, not a preference.
      throw new AcpSeatError(`"${String(value)}" is not an offered value for "${configId}"`);
    }
    const response = await this.context.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    });
    const refreshed = (response as { configOptions?: unknown }).configOptions;
    const options = Array.isArray(refreshed) && refreshed.length > 0
      ? summarizeOptions(refreshed as never)
      : // No snapshot back: keep the known set and record the applied value.
        this.configOptions.map((o) =>
          o.id === configId ? { ...o, current: String(value) } : o,
        );
    if (this.info) this.info = { ...this.info, configOptions: options };
    return options;
  }

  /**
   * Busy while a turn is running *or* while its trailing updates are still
   * draining. Accepting a new turn before the pump exits would let it consume
   * the previous turn's updates and misattribute them.
   */
  get busy(): boolean {
    return this.activeTurn !== null;
  }

  get poisoned(): boolean {
    return this.poisonReason !== null;
  }

  /**
   * Whether the seat's update pump is still consuming the stream.
   *
   * Read by close(), and exposed because "close() returned" and "the pump has
   * stopped" are different claims. A caller disposing a seat needs the second
   * one to hold: a pump that outlives close() can still emit into a connection
   * the service has already torn down.
   */
  get pumping(): boolean {
    return this.pumpRunning;
  }

  /**
   * Pumps the SDK's update stream.
   *
   * ACP delivers the `session/prompt` response *before* the trailing
   * notifications, so the response alone cannot be used to end a turn: doing so
   * drops the last chunks. The SDK's `nextUpdate()` is the documented source of
   * truth, yielding updates until a `stop` message carrying the response.
   */
  /**
   * The seat's single consumer of the harness's update stream.
   *
   * One pump for the seat's lifetime, not one per turn. `nextUpdate()` reads a
   * queue that belongs to the ACP *session*, so a pump per turn means a cancelled
   * turn's pump is still waiting when the next turn begins, receives that turn's
   * first updates, drops them, and poisons the seat. This was masked by a
   * force-settle timer; with the timer fixed, the misrouting showed up as a
   * second turn that streamed a few deltas and never finished.
   *
   * Routing is by arrival order, which is the only correlation ACP gives us: the
   * SDK enqueues a `stop` for each prompt in the order the prompts were sent, so
   * a stop still owed to a cancelled turn is matched to that turn from the front
   * of the abandoned list rather than settled against whichever turn is live.
   */
  private async pumpUpdates(): Promise<void> {
    const session = this.session;
    if (!session) {
      throw new AcpSeatError("seat has no ACP session");
    }
    for (;;) {
      // Checked before every read, so closing the seat ends the pump at the
      // next boundary rather than at whatever point the stream happens to break.
      // Racing this against nextUpdate() is what lets close() wait for the pump:
      // the pending read is abandoned, not the process.
      if (this.closed) return;
      let message: Awaited<ReturnType<ActiveSession["nextUpdate"]>> | null;
      try {
        message = await Promise.race([session.nextUpdate(), this.closing.promise.then(() => null)]);
      } catch (err) {
        // The stream broke. Whoever is live owns the failure; a seat with no live
        // turn has nothing to settle, so the reason is kept for the next opener.
        this.streamFailure = err;
        this.activeTurn?.fail(err);
        return;
      }
      // close() won the race. The message, if any, belongs to a seat that is
      // being disposed, so it is dropped rather than attributed to a turn.
      if (message === null) return;
      if (message.kind === "stop") {
        // The pump does NOT settle on `stop`. The SDK correlates a prompt's
        // response to that prompt, so `session.prompt()` resolving is the only
        // trustworthy terminal signal. A `stop` read here is unattributable: a
        // harness that ignores `$/cancelRequest` never sends one for the
        // cancelled turn, so the next `stop` on the wire belongs to the live turn
        // and matching it against a list of abandoned turns would swallow the
        // live turn's completion and leave the browser spinning.
        continue;
      }
      const turn = this.activeTurn;
      if (turn !== null && !turn.settled) {
        // The harness is still talking, so a pending end is not safe yet.
        this.deferSettle();
      }
      if (turn === null || turn.settled) {
        // A straggler for a turn that has ended. Dropped rather than forwarded.
        //
        // Poisoning here used to fire whenever no grace window was open, which
        // is the case where no cancel ever happened. That made an ordinary
        // trailing chunk fatal: ACP lets an agent answer session/prompt and then
        // flush more notifications, so a single legal chunk after a normal
        // completion poisoned the seat and every later prompt on it was refused.
        // The window is opened only by cancel(), so it is the only evidence that
        // the harness was told to stop. Without it there is nothing to have
        // ignored, and a late chunk is noise to drop rather than a verdict.
        //
        // With it, the window is the deadline: the harness had its seconds to
        // finish what it already sent, and anything past that means the stream
        // can no longer be trusted to belong to any turn. Time-based rather than
        // count-based, so it is recorded with the deadline instead of inferring
        // "still inside the window" from a list that is never emptied.
        if (this.graceUntilMs !== null && Date.now() >= this.graceUntilMs) {
          this.graceUntilMs = null;
          this.poisonReason = "harness kept streaming after a cancel";
        }
        continue;
      }
      try {
        this.forwardTo(turn.turnId, message);
      } catch (err) {
        // An emit that throws must end the turn, not wedge the pump: otherwise
        // the browser's working dots spin forever with no terminal event.
        turn.fail(err);
        continue;
      }
      // ignore and suppress verdicts carry no browser-visible state by design.
    }
  }

  /**
   * Pushes a pending end back, because an update just proved the stream is not
   * quiet. A no-op when nothing is pending.
   */
  private deferSettle(): void {
    if (this.pendingStopReason === null) return;
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.settleIfQuiet(), QUIET_BEFORE_SETTLE_MS);
    this.quietTimer.unref();
  }

  /** Ends the turn once the stream has been quiet for the window. */
  private settleIfQuiet(): void {
    this.quietTimer = null;
    const reason = this.pendingStopReason;
    if (reason === null) return;
    this.pendingStopReason = null;
    this.activeTurn?.settle(reason);
  }

  /**
   * Projects one update onto the wire and emits it under a turn id.
   *
   * Split out so the pump's read loop stays about routing and lifetime rather
   * than about the shape of an update, which is the part with a schema behind it.
   */
  private forwardTo(turnId: string, message: { update: SessionUpdate }): void {
    const verdict = classifySessionUpdate(message.update);
    if (verdict.kind === "text") {
      this.onEvent?.(turnId, { kind: verdict.stream, text: verdict.text });
    } else if (verdict.kind === "tool") {
      this.onEvent?.(turnId, {
        kind: "tool",
        toolCallId: verdict.toolCallId,
        title: verdict.title,
        status: verdict.status,
      });
    } else if (verdict.kind === "session") {
      // Forwarded with the turn id it arrived under so the service can route it
      // to the right connection; the service drops the id because a title is a
      // session fact, not turn content.
      this.onEvent?.(turnId, {
        kind: "session",
        title: verdict.title,
        updatedAt: verdict.updatedAt,
      });
    }
  }

  /**
   * Runs one turn with the blocks the service planned.
   *
   * An array rather than a string because ACP prompt content is a list: a
   * prompt carrying an attachment is one text block plus resource blocks, and
   * joining them into prose would make the bytes the model sees depend on how the
   * text happened to be formatted.
   */
  async prompt(turnId: string, blocks: ContentBlock[]): Promise<SeatStopReason> {
    if (this.closed) throw new AcpSeatError("seat is closed");
    if (this.poisonReason) {
      throw new AcpSeatError(`seat is unusable: ${this.poisonReason}`);
    }
    if (this.activeTurn) throw new AcpSeatError("a turn is already running on this seat");
    // No await on the previous pump here. The pump now runs for the seat's whole
    // lifetime, so waiting for it to finish would hang every prompt after the
    // first. Updates are routed to whichever turn is active, so a new turn does
    // not need the old pump to be done; it needs it to be the same pump.
    const session = this.session;
    if (this.context === null || session === null) {
      throw new AcpSeatError("seat has no ACP context");
    }

    const controller = new AbortController();
    let settle!: (stopReason: SeatStopReason) => void;
    let fail!: (err: unknown) => void;
    const finished = new Promise<SeatStopReason>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    let settledOnce = false;
    const once = <T>(fn: (value: T) => void) => (value: T) => {
      if (settledOnce) return;
      settledOnce = true;
      fn(value);
    };
    const turn: ActiveTurn = {
      turnId,
      controller,
      settle: once(settle),
      fail: once((err: unknown) => {
        settledOnce = true;
        fail(err);
      }),
      settled: false,
      finished,
    };
    this.activeTurn = turn;

    const timer = setTimeout(
      () => controller.abort(),
      this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    );
    timer.unref();

    // Settling is recorded on the turn so a late update cannot reopen it.
    const markSettled = (): void => {
      turn.settled = true;
    };
    const originalSettle = turn.settle;
    turn.settle = (reason: SeatStopReason) => {
      markSettled();
      originalSettle(reason);
    };
    const originalFail = turn.fail;
    turn.fail = (err: unknown) => {
      markSettled();
      originalFail(err);
    };

    // Started once for the seat, not per turn: `nextUpdate()` reads a queue that
    // belongs to the session, so a second pump would race the first for messages
    // and a cancelled turn's pump would eat the next turn's opening deltas.
    if (!this.pumpRunning) {
      this.pumpRunning = true;
      this.pumpDone = this.pumpUpdates()
        .catch((err: unknown) => {
          this.streamFailure = err;
        })
        .finally(() => {
          // Every exit path clears it: close() reads it to know the pump is gone,
          // and a flag left true after the pump returned would make a closed seat
          // look like it was still reading.
          this.pumpRunning = false;
        });
    } else if (this.streamFailure !== null) {
      // The stream died while this seat sat idle. Refusing here beats opening a
      // turn that can never receive a completion.
      throw new AcpSeatError(`the harness update stream ended: ${String(this.streamFailure)}`);
    }
    // NO drain timer here. This one was armed at the start of every turn, so any
    // turn slower than 5s was force-settled as "cancelled" with its answer
    // truncated mid-word, and the seat was poisoned for good. It only ever
    // belonged after an abort.
    armDrainOnAbort(turn, () => {
      this.poisonReason = "harness did not stop after a cancel";
      turn.settle("cancelled");
    });

    try {
      // Must go through ActiveSession.prompt, not a raw request: that is what
      // registers the turn with the SDK's update router. A raw ctx.request would
      // leave nextUpdate() hanging forever.
      //
      // The response is the terminal signal, not the pump's `stop` message. The
      // SDK matches a prompt's response to that prompt, so this is the only
      // correlation available; a `stop` read off the shared queue could belong to
      // a turn that was already cancelled.
      void session
        .prompt(blocks, { cancellationSignal: controller.signal })
        .then(
          (response) => {
            // Held rather than applied. ACP lets an agent answer session/prompt
            // and then flush chunks it had already produced, and ending the turn
            // on the response records those chunks after turn.completed, where
            // the transcript cannot use them. The pump keeps deferring while the
            // stream is still talking, so the end lands after the last chunk.
            this.pendingStopReason = normalizeStopReason(response?.stopReason);
            this.deferSettle();
          },
          (err: unknown) => {
            // Same reason as the success path: the wrapper is the only thing that
            // records the turn as ended.
            if (err instanceof RequestError && err.code === -32800) {
              turn.settle("cancelled");
              return;
            }
            if (controller.signal.aborted) {
              turn.settle("cancelled");
              return;
            }
            turn.fail(err);
          },
        );
      return await finished;
    } catch (err) {
      if (err instanceof RequestError && err.code === -32000) {
        throw new AcpAuthRequiredError("provider authentication required mid-turn");
      }
      if (controller.signal.aborted) return "cancelled";
      throw err;
    } finally {
      clearTimeout(timer);
      // A turn that ends by cancel or failure must not leave a pending end
      // behind: it would fire against whatever turn runs next.
      if (this.quietTimer !== null) {
        clearTimeout(this.quietTimer);
        this.quietTimer = null;
      }
      if (this.pendingStopReason !== null && this.activeTurn === turn) {
        this.pendingStopReason = null;
      }
      if (this.activeTurn === turn) this.activeTurn = null;
    }
  }

  /**
   * Cancels the active turn locally and tells the harness to stop.
   *
   * The local settle is the important half: the SDK's cancellation signal only
   * sends a notification, so without it the turn would never reach a terminal
   * state and every later prompt on this seat would be refused.
   */
  cancel(): boolean {
    const turn = this.activeTurn;
    if (!turn || turn.settled) return false;
    // A deadline, not a growing list. The harness is entitled a few seconds to
    // finish what it already sent; past that, anything still arriving is a
    // harness that ignored the cancel and the seat cannot be trusted again.
    this.graceUntilMs = Date.now() + CANCEL_DRAIN_MS;
    turn.controller.abort();
    turn.settle("cancelled");
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    // Order matters, and it is the reverse of what it used to be. The pump is
    // told first and awaited second, so it stops on its own terms while the
    // connection is still intact, rather than being cut off mid-read. Only then
    // is the lifetime released and the child torn down.
    this.closing.signal();
    // A pump wedged behind a read that never returns must not hold the teardown
    // for ever. The bound is what makes awaiting it safe; the child close below
    // is what actually guarantees nothing survives.
    await settleOrTimeout(this.pumpDone, ACP_PUMP_STOP_MS);
    this.releaseLifetime();
    await this.child.close();
  }
}

/**
 * Projects a harness config option onto the wire shape.
 *
 * Labels come from the harness so a user sees the names their own credentials
 * cover, and an option with no usable value carries an empty list rather than a
 * fabricated default.
 */
export function summarizeOptions(
  raw: readonly {
    id: string;
    name?: string;
    type?: string;
    options?: unknown;
    currentValue?: unknown;
  }[],
): ConfigOptionSummary[] {
  return raw.slice(0, MAX_CONFIG_OPTIONS).map((option) => ({
    id: String(option.id).slice(0, 128),
    name: (
      typeof option.name === "string" && option.name ? option.name : String(option.id)
    ).slice(0, 200),
    type: option.type === "boolean" ? ("boolean" as const) : ("select" as const),
    // ACP names this `currentValue`; a boolean option reports a boolean, which
    // the wire models as a string, so it is stringified rather than dropped.
    current:
      typeof option.currentValue === "string"
        ? option.currentValue.slice(0, 256)
        : typeof option.currentValue === "boolean"
          ? String(option.currentValue)
          : null,
    values: flattenValues(option.options),
  }));
}

/** Select options may be flat or grouped; both flatten to value/label pairs. */
function flattenValues(options: unknown): { value: string; label: string }[] {
  if (!Array.isArray(options)) return [];
  const out: { value: string; label: string }[] = [];
  for (const entry of options) {
    if (out.length >= MAX_OPTION_VALUES) break;
    const e = entry as {
      value?: unknown;
      name?: unknown;
      options?: unknown;
    };
    if (Array.isArray(e.options)) {
      out.push(...flattenValues(e.options).slice(0, MAX_OPTION_VALUES - out.length));
      continue;
    }
    if (typeof e.value !== "string" || e.value.length === 0) continue;
    out.push({
      value: e.value.slice(0, 256),
      label: (typeof e.name === "string" && e.name ? e.name : e.value).slice(0, 200),
    });
  }
  return out;
}

function normalizeStopReason(raw: string | undefined): SeatStopReason {
  switch (raw) {
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return raw;
    default:
      // An unrecognised reason means the turn stopped, not that it failed;
      // inventing an error here would misreport a completed turn.
      return "end_turn";
  }
}

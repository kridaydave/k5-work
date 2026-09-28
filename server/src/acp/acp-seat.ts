import {
  client,
  PROTOCOL_VERSION,
  RequestError,
  type ActiveSession,
  type ClientContext,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import type { AcpChild } from "./spawn.js";
import { NO_CAPABILITIES, probeCapabilities, type AcpCapabilities } from "./capabilities.js";
import {
  attachSessionShim,
  MAX_LISTED_HARNESS_SESSIONS,
  toHarnessSessionInfo,
  type HarnessSessionInfo,
} from "./adopt.js";
import { classifySessionUpdate } from "./updates.js";
import type { ConfigOptionSummary } from "@k5-work/shared";

/** ACP caps a value label and the option id; mirrored so the wire stays bounded. */
const MAX_OPTION_VALUES = 64;
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
   * `session/list` is a read, and a read must not create a session: a sidebar
   * that lists tasks would otherwise leave a new harness session behind on every
   * page load. The same headless seat then adopts an existing session id through
   * `adopt`, so there is one seat and one turn pump either way.
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
   * `session/list`, for discovering sessions the harness knows about.
   *
   * Gated on the advertised capability rather than attempted optimistically: the
   * spec is explicit that a client MUST NOT call a method the agent did not
   * advertise, and the failure would otherwise surface as an opaque JSON-RPC
   * error. Only the first page is taken: k5 shows a bounded list and never
   * persists a cursor, because the spec forbids storing one.
   */
  async listSessions(options: { limit?: number } = {}): Promise<HarnessSessionInfo[]> {
    if (this.closed) throw new AcpSeatError("seat is closed");
    if (this.context === null) throw new AcpSeatError("seat has no ACP context");
    if (!this.capabilities.list) {
      throw new AcpCapabilityError("list", "this harness does not offer session/list");
    }
    // A timeout, because the SDK has no default: it registers a pending response
    // that only a response or a cancel settles. Without this a harness that never
    // answers leaves the child alive forever, since the only thing that would tear
    // it down is the teardown that is itself waiting on this call.
    const response = (await this.context.request(
      "session/list",
      // cwd and cursor are the only members of ListSessionsRequest; mcpServers
      // belongs to the lifecycle methods, not to this read.
      { cwd: this.options.cwd },
      { cancellationSignal: AbortSignal.timeout(this.openTimeoutMs) },
    )) as { sessions?: unknown; nextCursor?: unknown };
    const raw = Array.isArray(response.sessions) ? response.sessions : [];
    // The cap is post-hoc: ACP has no page-size field, only a cursor, and the
    // spec forbids persisting one. So this bounds what k5 keeps, not the bytes on
    // the wire.
    const capped = raw.slice(0, options.limit ?? MAX_LISTED_HARNESS_SESSIONS);
    return capped
      .map((entry) => toHarnessSessionInfo(entry))
      .filter((entry): entry is HarnessSessionInfo => entry !== null);
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
        // Bounded, for the same reason session/list is: an unanswered resume
        // would hold the child open and wedge the connection that asked.
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
   * Pumps the SDK's update stream.
   *
   * ACP delivers the `session/prompt` response *before* the trailing
   * notifications, so the response alone cannot be used to end a turn: doing so
   * drops the last chunks. The SDK's `nextUpdate()` is the documented source of
   * truth, yielding updates until a `stop` message carrying the response.
   */
  private async pumpUpdates(turn: ActiveTurn): Promise<void> {
    const session = this.session;
    if (!session) {
      turn.fail(new AcpSeatError("seat has no ACP session"));
      return;
    }
    for (;;) {
      let message: Awaited<ReturnType<ActiveSession["nextUpdate"]>>;
      try {
        message = await session.nextUpdate();
      } catch (err) {
        turn.fail(err);
        return;
      }
      if (message.kind === "stop") {
        turn.settle(normalizeStopReason(message.response?.stopReason));
        return;
      }
      // Once the turn is settled, further updates belong to a harness that did
      // not honour the cancel. The pump keeps draining so the queue is not
      // misattributed, but it stops forwarding and poisons the seat if the
      // harness never stops.
      if (turn.settled) {
        this.poisonReason = "harness kept streaming after a cancel";
        turn.settle = () => {};
        return;
      }
      const verdict = classifySessionUpdate(message.update);
      try {
        if (verdict.kind === "text") {
          this.onEvent?.(turn.turnId, { kind: verdict.stream, text: verdict.text });
        } else if (verdict.kind === "tool") {
          this.onEvent?.(turn.turnId, {
            kind: "tool",
            toolCallId: verdict.toolCallId,
            title: verdict.title,
            status: verdict.status,
          });
        } else if (verdict.kind === "session") {
          // Forwarded with the turn id it arrived under so the service can route
          // it to the right connection; the service drops the id because a title
          // is a session fact, not turn content.
          this.onEvent?.(turn.turnId, {
            kind: "session",
            title: verdict.title,
            updatedAt: verdict.updatedAt,
          });
        }
      } catch (err) {
        // An emit that throws must end the turn, not wedge the pump: otherwise
        // the browser's working dots spin forever with no terminal event.
        turn.fail(err);
        return;
      }
      // ignore and suppress verdicts carry no browser-visible state by design.
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
    // A previous turn's pump may still be draining; a new turn must not steal
    // its updates.
    await this.pumpDone.catch(() => undefined);
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

    this.pumpDone = this.pumpUpdates(turn);
    // Bound the wait so a harness that never acknowledges a cancel cannot pin
    // the seat open forever.
    const drainTimer = setTimeout(() => {
      if (turn.settled) return;
      this.poisonReason = "harness did not stop after a cancel";
      turn.settle("cancelled");
    }, CANCEL_DRAIN_MS);
    drainTimer.unref();

    try {
      // Must go through ActiveSession.prompt, not a raw request: that is what
      // registers the turn with the SDK's update router and queues the `stop`
      // message the pump above is waiting for. A raw ctx.request would leave
      // nextUpdate() hanging forever.
      void session
        .prompt(blocks, { cancellationSignal: controller.signal })
        .catch((err: unknown) => {
          if (err instanceof RequestError && err.code === -32800) {
            settle("cancelled");
            return;
          }
          if (controller.signal.aborted) {
            settle("cancelled");
            return;
          }
          fail(err);
        });
      return await finished;
    } catch (err) {
      if (err instanceof RequestError && err.code === -32000) {
        throw new AcpAuthRequiredError("provider authentication required mid-turn");
      }
      if (controller.signal.aborted) return "cancelled";
      throw err;
    } finally {
      clearTimeout(timer);
      clearTimeout(drainTimer);
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
    turn.controller.abort();
    turn.settle("cancelled");
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    // The pump holds a pending nextUpdate() that no abort can release; waiting
    // for it would hang close, so the connection is torn down underneath it.
    void this.pumpDone.catch(() => undefined);
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
  return raw.slice(0, 32).map((option) => ({
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

import {
  client,
  PROTOCOL_VERSION,
  RequestError,
  type ActiveSession,
  type ClientContext,
} from "@agentclientprotocol/sdk";
import type { AcpChild } from "./spawn.js";
import { classifySessionUpdate } from "./updates.js";
import type { ConfigOptionSummary } from "@k5-work/shared";

/** ACP caps a value label and the option id; mirrored so the wire stays bounded. */
const MAX_OPTION_VALUES = 64;
import { AcpAuthRequiredError, AcpProtocolMismatchError, AcpTerminalAuthUnsupportedError } from "./probe.js";

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
    };

export interface AcpSeatOptions {
  cwd: string;
  clientName?: string;
  openTimeoutMs?: number;
  turnTimeoutMs?: number;
  /**
   * Asks the owner to decide a permission request. Returns the chosen
   * `optionId`, or null to cancel.
   *
   * Without this the seat never answers `session/request_permission`, so a
   * harness that asks before running a tool waits forever and the turn hangs
   * with no visible cause.
   */
  onPermission?: AcpPermissionBroker;
}

/** A permission request in the shape the browser contract already uses. */
export interface AcpPermissionRequest {
  toolCallId: string | null;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
}

export type AcpPermissionBroker = (
  request: AcpPermissionRequest,
) => Promise<string | null>;

export interface AcpSeatInfo {
  sessionId: string;
  /** The harness's own options, including each select value and its label. */
  configOptions: ConfigOptionSummary[];
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
    await seat.handshake();
    return seat;
  }

  private get openTimeoutMs(): number {
    return this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  }

  private async handshake(): Promise<void> {
    const seat = this;
    const app = client({ name: this.options.clientName ?? "k5-work" });
    // Registered before the handshake so a permission request raised during the
    // first turn is answered rather than left hanging on the harness.
    app.onRequest("session/request_permission", async ({ params, signal }) => {
      const offer = params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: String(o.kind),
      }));
      const toolCallId =
        params.toolCall.toolCallId === undefined ? null : String(params.toolCall.toolCallId);
      const title = params.toolCall.title ?? params.toolCall.kind ?? "tool call";
      // A cancel aborts this request, so a decision can never be delivered after
      // the harness stopped waiting. Racing the signal keeps the turn from
      // hanging on a decision the user can no longer make.
      const chosen =
        (await Promise.race([
          this.options.onPermission?.({ toolCallId, title, options: offer }) ??
            Promise.resolve(null),
          new Promise<null>((resolve) => {
            if (signal.aborted) {
              resolve(null);
              return;
            }
            signal.addEventListener("abort", () => resolve(null), { once: true });
          }),
        ])) ?? null;
      // The broker is the only source of a decision, and only an option this
      // harness actually offered may be echoed back.
      if (chosen !== null && !offer.some((o) => o.optionId === chosen)) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome:
          chosen === null
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: chosen },
      };
    });
    const settled = new Promise<AcpSeatInfo>((resolve, reject) => {
      void app
        .connectWith(this.child.stream, async (ctx) => {
          try {
            const init = await ctx.request(
              "initialize",
              {
                protocolVersion: PROTOCOL_VERSION,
                // Nothing is advertised that k5 has no handler behind.
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

            const active = await ctx.buildSession(seat.options.cwd).start({
              cancellationSignal: AbortSignal.timeout(seat.openTimeoutMs),
            });
            const created = active.newSessionResponse;
            seat.context = ctx;
            seat.session = active;
            seat.info = {
              sessionId: created.sessionId,
              configOptions: summarizeOptions(created.configOptions ?? []),
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

  async prompt(turnId: string, text: string): Promise<SeatStopReason> {
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
        .prompt(text, { cancellationSignal: controller.signal })
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

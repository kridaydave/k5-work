import {
  isServableProfile,
  resolveAccessProfile,
  type AccessProfile,
  type CommandFailureReason,
  type ComposerAccessLabel,
  type Harness,
} from "@k5-work/shared";
import {
  AcpCommandError,
  AcpSpawnError,
  acpCommandArgv,
  spawnAcpChild,
  type AcpChild,
} from "./spawn.js";
import {
  PostureTooWeakError,
  PostureUnverifiableError,
  verifyPosture,
} from "./posture.js";
import { describeFinding, findPluginSignals } from "./plugin-guard.js";
import { AcpSeat, type AcpSeatInfo, type SeatStreamEvent } from "./acp-seat.js";
import {
  SeatBusyError,
  SeatCapError,
  SeatPool,
  SESSION_OPEN_DEADLINE_MS,
  type Seat,
} from "./seat-pool.js";

/**
 * Reasons a seat can fail to open. Derived from the wire contract so the two
 * cannot drift: a reason the browser cannot render is a reason that would hang
 * a command.
 */
export type SeatOpenFailure = Extract<
  CommandFailureReason,
  | "live-seats-disabled"
  | "profile-not-servable"
  | "project-has-plugins"
  | "seat-cap"
  | "seat-busy"
  | "harness-unconfigured"
  | "posture-unverifiable"
  | "posture-too-weak"
  | "initialize-failed"
  | "protocol-mismatch"
  | "auth-required"
  | "terminal-auth-unsupported"
  | "session-new-failed"
  | "timeout"
>;

export class SeatOpenError extends Error {
  constructor(
    readonly reason: SeatOpenFailure,
    message: string,
  ) {
    super(message);
    this.name = "SeatOpenError";
  }
}

export interface OpenSeatOptions {
  harness: Harness;
  projectId: string;
  projectPath: string;
  access: ComposerAccessLabel;
}

export interface OpenSeatResult {
  seat: Seat;
  child: AcpChild;
  acp: AcpSeat;
  info: AcpSeatInfo;
  profile: AccessProfile;
}

export interface SeatRunnerOptions {
  pool: SeatPool;
  acpCommand: string | undefined;
  disableLiveSeats: boolean;
  env?: NodeJS.ProcessEnv;
  /** Agent whose merged configuration governs the seat. */
  agent?: string;
  openDeadlineMs?: number;
  postureTimeoutMs?: number;
}

const DEFAULT_AGENT = "build";

/**
 * How many harness processes may exist purely to answer a read at once. Small
 * on purpose: a read is short, and the point of the cap is to stop a loop from
 * spawning unbounded children, not to serve a burst.
 */
const MAX_INFLIGHT_HEADLESS = 2;

/**
 * Owns the seat open path: policy, then a reserved key, then the harness.
 *
 * Every check that can refuse a seat happens before a child is spawned, except
 * the protocol steps, which are the reason the child exists. A failure after
 * `promote` reaps the child; a failure before it releases the reservation, so
 * a cap slot is never leaked by a failed open.
 */
export class SeatRunner {
  /** See `openHeadless`: the read path takes no keyed reservation, so this is
   * the only thing bounding how many harness processes a read can spawn. */
  private headlessInFlight = 0;

  constructor(private readonly options: SeatRunnerOptions) {}

  /**
   * The policy gate, in order: enabled, servable profile, no plugins, a
   * configured command, then a verified posture. Every check that can refuse
   * happens before a child is spawned, and posture is verified before any
   * reservation so a failure cannot consume a cap slot.
   *
   * Extracted because a read needs the same gate: `session/list` runs a command
   * against the harness, and a harness whose permissions cannot be verified is
   * not one to run one against.
   */
  private async gate(input: {
    projectPath: string;
    access: AccessProfile["label"];
    /** Skips the posture resolver, for a read that runs no agent code. */
    skipPosture?: boolean;
  }): Promise<{ profile: AccessProfile; argv: string[]; env: NodeJS.ProcessEnv }> {
    if (this.options.disableLiveSeats) {
      throw new SeatOpenError(
        "live-seats-disabled",
        "K5_DISABLE_LIVE_SEATS is set; no ACP seat will be started",
      );
    }

    // Posture first: a profile k5 cannot keep must be refused before it is even
    // looked up, so a browser cannot select a posture by asking for it.
    if (!isServableProfile(input.access)) {
      throw new SeatOpenError(
        "profile-not-servable",
        `the "${input.access}" access profile cannot be enforced by this harness; ` +
          `only ${"full"} is servable. See docs/posture-and-trust-decisions.md`,
      );
    }
    const profile = resolveAccessProfile(input.access);

    const findings = findPluginSignals(input.projectPath);
    if (findings.length > 0) {
      throw new SeatOpenError(
        "project-has-plugins",
        findings.map(describeFinding).join("; "),
      );
    }

    let argv: string[];
    try {
      argv = acpCommandArgv(this.options.acpCommand);
    } catch (err) {
      if (err instanceof AcpCommandError) {
        throw new SeatOpenError("harness-unconfigured", err.message);
      }
      throw err;
    }

    const env = this.options.env ?? process.env;
    if (input.skipPosture === true) {
      return { profile, argv, env };
    }
    try {
      await verifyPosture({
        command: argv[0],
        cwd: input.projectPath,
        env,
        agent: this.options.agent ?? DEFAULT_AGENT,
        profile,
        ...(this.options.postureTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.postureTimeoutMs }),
      });
    } catch (err) {
      if (err instanceof PostureTooWeakError) {
        throw new SeatOpenError("posture-too-weak", err.message);
      }
      if (err instanceof PostureUnverifiableError) {
        throw new SeatOpenError("posture-unverifiable", err.message);
      }
      throw err;
    }
    return { profile, argv, env };
  }

  async open(
    request: OpenSeatOptions,
    onEvent: ((turnId: string, event: SeatStreamEvent) => void) | null = null,
  ): Promise<OpenSeatResult> {
    const { profile, argv, env } = await this.gate({
      projectPath: request.projectPath,
      access: request.access,
    });
    const key = {
      harness: request.harness,
      projectId: request.projectId,
      profile,
    };

    let seat: Seat;
    try {
      seat = this.options.pool.reserve(key, request.projectPath);
    } catch (err) {
      if (err instanceof SeatCapError) {
        throw new SeatOpenError("seat-cap", err.message);
      }
      if (err instanceof SeatBusyError) {
        throw new SeatOpenError("seat-busy", err.message);
      }
      throw err;
    }

    let child: AcpChild | null = null;
    try {
      child = await spawnAcpChild({ argv, cwd: request.projectPath, env });
      const acp = await AcpSeat.open(
        child,
        {
          cwd: request.projectPath,
          ...(this.options.openDeadlineMs === undefined
            ? {}
            : { openTimeoutMs: this.options.openDeadlineMs }),
        },
        onEvent,
      );
      this.options.pool.promote(seat, acp.sessionId, child);
      return {
        seat,
        child,
        acp,
        info: {
          sessionId: acp.sessionId,
          configOptions: acp.configOptions,
          capabilities: acp.capabilities,
        },
        profile,
      };
    } catch (err) {
      // Release the reservation *and* reap the child on every failure path, or
      // a failed open leaks a cap slot that no later request can reclaim.
      this.options.pool.releaseProvisional(seat);
      this.options.pool.remove(seat);
      if (child) await child.close();
      throw classifyOpenFailure(err);
    }
  }

  /**
   * Opens a connection with no ACP session, for a read that must not create one.
   *
   * `session/list` needs a live agent, and the workspace's promise is that an
   * empty hero costs no lasting harness process. So a list gets a seat of its own
   * and is reaped as soon as the read is done.
   *
   * It deliberately takes no keyed reservation — that is what would let a read
   * block a real session. But a keyed reservation is not the only bound, and
   * without any bound this is an unbounded process spawn: measured at 320 MiB
   * per headless opencode, one tab looping on a refresh reached twenty children
   * in under ten seconds while the pool reported zero seats. So in-flight reads
   * are counted against their own small cap.
   */
  async openHeadless(input: {
    projectId: string;
    projectPath: string;
    access?: AccessProfile["label"];
    /**
     * True for a read that runs no agent code. A continuation must leave it
     * false, because from that point the harness will run a prompt.
     */
    readOnly?: boolean;
  }): Promise<{ child: AcpChild; acp: AcpSeat; profile: AccessProfile }> {
    if (this.headlessInFlight >= MAX_INFLIGHT_HEADLESS) {
      throw new SeatOpenError(
        "seat-cap",
        `already listing sessions in ${String(this.headlessInFlight)} places; try again shortly`,
      );
    }
    this.headlessInFlight += 1;
    try {
      const { profile, argv, env } = await this.gate({
        projectPath: input.projectPath,
        access: input.access ?? "full",
        // The posture resolver is a subprocess that measured 3.5 s on this
        // machine, and it exists to bound what agent code may do. `session/list`
        // runs no agent code: it spawns the harness, handshakes, and reads back
        // metadata the harness already holds. Paying 3.5 s of that per sidebar
        // refresh bought nothing. A continuation still pays it, because from that
        // point the harness will run a prompt.
        skipPosture: input.readOnly === true,
      });
      const child = await spawnAcpChild({ argv, cwd: input.projectPath, env });
      try {
        const acp = await AcpSeat.openHeadless(
          child,
          {
            cwd: input.projectPath,
            ...(this.options.openDeadlineMs === undefined
              ? {}
              : { openTimeoutMs: this.options.openDeadlineMs }),
          },
          null,
        );
        return { child, acp, profile };
      } catch (err) {
        // The child is the only thing that can leak; there is no reservation.
        await child.close();
        throw classifyOpenFailure(err);
      }
    } finally {
      this.headlessInFlight -= 1;
    }
  }

  /**
   * Turns a read seat into a live one, for a session that already exists.
   *
   * The reservation happens here, after the adopt succeeded, so a failed
   * continuation never consumed a cap slot. The gate is not re-run: the
   * headless open already did it, and a second posture verification would be a
   * second thing that can fail after the harness is already attached to a
   * session.
   */
  promoteAdopted(input: {
    harness: Harness;
    projectId: string;
    projectPath: string;
    child: AcpChild;
    acp: AcpSeat;
    sessionId: string;
  }): Seat {
    const profile = resolveAccessProfile("full");
    let seat: Seat;
    try {
      seat = this.options.pool.reserve(
        { harness: input.harness, projectId: input.projectId, profile },
        input.projectPath,
      );
    } catch (err) {
      // Classified the same way a fresh open classifies them, so "another tab
      // already has this project" is not reported as a server fault.
      if (err instanceof SeatCapError) throw new SeatOpenError("seat-cap", err.message);
      if (err instanceof SeatBusyError) throw new SeatOpenError("seat-busy", err.message);
      throw err;
    }
    this.options.pool.promote(seat, input.sessionId, input.child);
    return seat;
  }
}

function classifyOpenFailure(err: unknown): SeatOpenError {
  if (err instanceof SeatOpenError) return err;

  // A command that cannot be executed is a configuration problem, not an
  // initialize failure, and saying so keeps the two distinguishable in the UI.
  if (err instanceof AcpSpawnError) {
    return new SeatOpenError("harness-unconfigured", err.message);
  }

  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "AcpAuthRequiredError":
      return new SeatOpenError("auth-required", message(err));
    case "AcpTerminalAuthUnsupportedError":
      return new SeatOpenError("terminal-auth-unsupported", message(err));
    case "AcpProtocolMismatchError":
      return new SeatOpenError("protocol-mismatch", message(err));
    case "AcpRequestTimeoutError":
      return new SeatOpenError("timeout", message(err));
    default:
      return new SeatOpenError("initialize-failed", message(err));
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

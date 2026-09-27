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
import {
  AcpSeat,
  type AcpPermissionBroker,
  type AcpSeatInfo,
  type SeatStreamEvent,
} from "./acp-seat.js";
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
 * Owns the seat open path: policy, then a reserved key, then the harness.
 *
 * Every check that can refuse a seat happens before a child is spawned, except
 * the protocol steps, which are the reason the child exists. A failure after
 * `promote` reaps the child; a failure before it releases the reservation, so
 * a cap slot is never leaked by a failed open.
 */
export class SeatRunner {
  constructor(private readonly options: SeatRunnerOptions) {}

  async open(
    request: OpenSeatOptions,
    onEvent: ((turnId: string, event: SeatStreamEvent) => void) | null = null,
    onPermission: AcpPermissionBroker | undefined = undefined,
  ): Promise<OpenSeatResult> {
    if (this.options.disableLiveSeats) {
      throw new SeatOpenError(
        "live-seats-disabled",
        "K5_DISABLE_LIVE_SEATS is set; no ACP seat will be started",
      );
    }

    // Posture first: a profile k5 cannot keep must be refused before it is even
    // looked up, so a browser cannot select a posture by asking for it.
    if (!isServableProfile(request.access)) {
      throw new SeatOpenError(
        "profile-not-servable",
        `the "${request.access}" access profile cannot be enforced by this harness; ` +
          `only ${"full"} is servable. See docs/posture-and-trust-decisions.md`,
      );
    }
    const profile = resolveAccessProfile(request.access);

    const findings = findPluginSignals(request.projectPath);
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
    const key = {
      harness: request.harness,
      projectId: request.projectId,
      profile,
    };

    // Verified before the reservation so a posture failure cannot consume a cap
    // slot, and re-checked nowhere else: this is the single gate.
    try {
      await verifyPosture({
        command: argv[0],
        cwd: request.projectPath,
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
          ...(onPermission === undefined ? {} : { onPermission }),
        },
        onEvent,
      );
      this.options.pool.promote(seat, acp.sessionId, child);
      return {
        seat,
        child,
        acp,
        info: { sessionId: acp.sessionId, configOptions: acp.configOptions },
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

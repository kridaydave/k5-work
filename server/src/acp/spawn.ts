import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

export class AcpCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpCommandError";
  }
}

/** The harness process could not be started at all (missing binary, no exec). */
export class AcpSpawnError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "AcpSpawnError";
  }
}

// A cold `session/new` against a real harness routinely takes tens of seconds,
// so this is a floor rather than a tight budget.
export const ACP_REQUEST_TIMEOUT_MS = 30_000;
export const ACP_EXIT_GRACE_MS = 5_000;
export const ACP_EXIT_HARD_MS = 5_000;
const STDERR_RING_BYTES = 64 * 1024;

// Shell-style tokenizer, then spawn without a shell. ACP_COMMAND is operator
// input, so a shell string would let quoting smuggle in extra commands.
export function parseArgv(raw: string): string[] {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
        current += raw[++i];
        started = true;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      current += raw[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote !== null) {
    throw new AcpCommandError(
      `unterminated ${quote} quote in ACP_COMMAND: ${raw}`,
    );
  }
  if (started) argv.push(current);
  return argv;
}

// Read at seat-creation time, never at import time: a missing command must be
// a typed error on the first session, not a crash on server boot. The value is
// passed in from ServerConfig so there is a single source of truth.
export function acpCommandArgv(
  source: string | undefined | NodeJS.ProcessEnv = process.env,
): string[] {
  const raw =
    typeof source === "string" || source === undefined
      ? source
      : source.ACP_COMMAND;
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new AcpCommandError(
      'ACP_COMMAND is unset. Set it to the harness argv, e.g. ACP_COMMAND="opencode acp".',
    );
  }
  const argv = parseArgv(trimmed);
  if (argv.length === 0) {
    throw new AcpCommandError(`ACP_COMMAND parsed to zero argv entries: ${trimmed}`);
  }
  return argv;
}

export interface AcpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: NodeJS.ErrnoException | null;
}

export interface AcpCloseResult {
  reaped: boolean;
  exit: AcpExit | null;
}

export interface AcpChild {
  readonly argv: readonly string[];
  readonly pid: number | undefined;
  readonly stream: Stream;
  readonly exited: Promise<AcpExit>;
  stderrTail(): string;
  close(): Promise<AcpCloseResult>;
}

export interface SpawnAcpChildOptions {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  exitGraceMs?: number;
  exitHardMs?: number;
}

// stderr is drained continuously into a bounded ring: an unread pipe blocks the
// harness mid-turn, and an unbounded one would grow without limit.
class StderrRing {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > STDERR_RING_BYTES) {
      const oldest = this.chunks[0];
      const excess = this.size - STDERR_RING_BYTES;
      if (oldest.length <= excess) {
        this.chunks.shift();
        this.size -= oldest.length;
        continue;
      }
      this.chunks[0] = oldest.subarray(excess);
      this.size -= excess;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function settleWithin<T>(
  pending: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
    timer.unref();
  });
  try {
    return await Promise.race([
      pending.then((value) => ({ ok: true as const, value })),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Only ever signals the group we captured at spawn. Pattern matching is
// forbidden: other worktrees and dev servers share this host.
function signalCapturedGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/**
 * Starts the harness and returns only once the process exists.
 *
 * The promise matters: on ENOENT the child has no usable stdio, so building a
 * stream from it would fail with an opaque TypeError and lose the real cause.
 * Resolving after 'spawn' and rejecting on 'error' keeps that distinction.
 */
export function spawnAcpChild(options: SpawnAcpChildOptions): Promise<AcpChild> {
  const [command, ...args] = options.argv;
  if (!command) {
    throw new AcpCommandError("ACP_COMMAND produced no executable to spawn");
  }
  const graceMs = options.exitGraceMs ?? ACP_EXIT_GRACE_MS;
  const hardMs = options.exitHardMs ?? ACP_EXIT_HARD_MS;
  const stderr = new StderrRing();

  // detached gives the harness its own process group on POSIX so grandchildren
  // can be reaped without name matching. We never unref: the parent must keep
  // tracking the seat.
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => {
    // A harness that exits first makes this EPIPE. Teardown reports the real cause.
  });

  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        new AcpSpawnError(
          err.code,
          `harness command ${JSON.stringify(command)} could not be started: ${err.message}`,
        ),
      );
    });
  });

  const exited = new Promise<AcpExit>((resolve) => {
    let spawnError: NodeJS.ErrnoException | null = null;
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
    });
    const settle = (): void => {
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        error: spawnError,
      });
    };
    child.once("close", settle);
    child.once("error", settle);
  });

  let closePromise: Promise<AcpCloseResult> | null = null;

  return started.then(() => ({
    argv: options.argv,
    pid: child.pid,
    // The SDK's ndJsonStream takes WHATWG byte streams, not Node Duplexes.
    stream: ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    exited,
    stderrTail: () => stderr.text(),
    close() {
      closePromise ??= (async () => {
        child.stdin.end();
        const onEof = await settleWithin(exited, graceMs);
        if (onEof.ok) return { reaped: true, exit: onEof.value };

        signalCapturedGroup(child.pid, "SIGTERM");
        const onTerm = await settleWithin(exited, hardMs);
        if (onTerm.ok) return { reaped: true, exit: onTerm.value };

        signalCapturedGroup(child.pid, "SIGKILL");
        const onKill = await settleWithin(exited, hardMs);
        return onKill.ok
          ? { reaped: true, exit: onKill.value }
          : { reaped: false, exit: null };
      })();
      return closePromise;
    },
  }));
}

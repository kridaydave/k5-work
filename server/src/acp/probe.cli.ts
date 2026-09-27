// Maintainer-machine probe runner. Prints the negotiated ACP facts and exits
// non-zero on failure, so a real-harness proof is a visible command rather than
// a claim. CI runs the same path through probe.test.ts and may report a skip.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AcpAuthRequiredError,
  AcpProtocolMismatchError,
  AcpTerminalAuthUnsupportedError,
  runAcpProbe,
} from "./probe.js";
import { acpCommandArgv, spawnAcpChild } from "./spawn.js";
import { SeatRegistry } from "./seat-registry.js";

function describeFailure(err: unknown): string {
  if (err instanceof AcpAuthRequiredError) return "auth-required";
  if (err instanceof AcpTerminalAuthUnsupportedError) return "terminal-auth-unsupported";
  if (err instanceof AcpProtocolMismatchError) return `protocol-mismatch(${err.offered})`;
  return "error";
}

export async function main(): Promise<number> {
  let argv: string[];
  try {
    argv = acpCommandArgv();
  } catch (err) {
    process.stderr.write(`SKIP ${(err as Error).message}\n`);
    return 0;
  }

  const cwd = mkdtempSync(path.join(tmpdir(), "k5-acp-cli-"));
  const child = await spawnAcpChild({ argv, cwd });
  const seats = new SeatRegistry();
  seats.register(child);
  try {
    const result = await runAcpProbe({
      stream: child.stream,
      cwd,
      requestTimeoutMs: 60_000,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          command: argv.join(" "),
          protocolVersion: result.protocolVersion,
          agentInfo: result.agentInfo,
          authOffers: result.authOffers,
          authenticatedWith: result.authenticatedWith,
          sessionId: result.sessionId,
          configOptionIds: result.configOptionIds,
          modeIds: result.modeIds,
          agentCapabilities: result.agentCapabilities,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (err) {
    const kind = describeFailure(err);
    const detail = err instanceof Error ? err.message : String(err);
    if (kind === "auth-required") {
      process.stderr.write(`SKIP ${detail}\n`);
      return 0;
    }
    process.stderr.write(`FAIL ${kind}: ${detail}\n`);
    if (child.stderrTail().trim().length > 0) {
      process.stderr.write(`--- harness stderr tail ---\n${child.stderrTail()}\n`);
    }
    return 1;
  } finally {
    const survivors = await seats.closeAll();
    const closed =
      survivors.length === 0
        ? { reaped: true, exit: await child.exited }
        : { reaped: false, exit: null };
    rmSync(cwd, { recursive: true, force: true });
    if (!closed.reaped) {
      process.stderr.write(
        `FAIL harness pid ${String(child.pid)} was not reaped within the deadline\n`,
      );
      process.exitCode = 1;
    } else {
      process.stderr.write(
        `reaped harness pid ${String(child.pid)} exit=${String(closed.exit?.code)}\n`,
      );
    }
  }
}

// Runs only when executed directly. A module that probes a live harness on
// import would make every consumer of this file spawn a seat, which is a
// side effect no test or module loader is asking for.
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main();
}

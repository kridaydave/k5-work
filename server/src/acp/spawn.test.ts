import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AcpCommandError,
  AcpSpawnError,
  acpCommandArgv,
  parseArgv,
  spawnAcpChild,
  type AcpChild,
  type SpawnAcpChildOptions,
} from "./spawn.js";

const NODE = process.execPath;

// Keeps the child's event loop alive so that only a signal can reap it.
const KEEP_ALIVE = "setInterval(() => {}, 1000);";

// Emitted by the child on stdout once its SIGTERM handler is installed. The
// backslashes are escaped so the child receives a literal newline escape rather
// than a real newline inside its own string literal.
const REPORT =
  "const report = () => process.stdout.write('{\"k5Ready\":true}\\n');";

/**
 * Spawns a child and returns only once it has reported that its own signal
 * handler is installed.
 *
 * Both escalation tests are about what happens to a child that is already
 * running, so they must not race the child's startup. A SIGTERM that arrives
 * while node is still booting hits the default disposition and kills it
 * outright, which makes the test assert the wrong thing: this pair failed
 * intermittently under load, reporting SIGTERM where SIGKILL was expected,
 * purely because a loaded machine took longer than the grace window to boot.
 *
 * The receipt is a real message on the child's own stream, awaited as an event
 * rather than slept for, so the precondition is established instead of hoped
 * for.
 */
async function spawnReportingReady(
  options: SpawnAcpChildOptions,
): Promise<AcpChild> {
  const child = await spawnAcpChild(options);
  const reader = (
    child.stream.readable as ReadableStream<unknown>
  ).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error("the child exited before reporting that it was ready");
    }
    if (JSON.stringify(value) === '{"k5Ready":true}') break;
  }
  reader.releaseLock();
  return child;
}

describe("ACP_COMMAND parsing", () => {
  it("splits plain argv and collapses runs of whitespace", () => {
    assert.deepEqual(parseArgv("opencode acp"), ["opencode", "acp"]);
    assert.deepEqual(parseArgv("  opencode   acp  "), ["opencode", "acp"]);
  });

  it("honours single and double quotes, keeping quoted spaces in one arg", () => {
    assert.deepEqual(parseArgv("node 'my agent.js' acp"), [
      "node",
      "my agent.js",
      "acp",
    ]);
    assert.deepEqual(parseArgv('node "my agent.js" acp'), [
      "node",
      "my agent.js",
      "acp",
    ]);
  });

  it("escapes spaces and quotes, and preserves an explicitly empty arg", () => {
    assert.deepEqual(parseArgv("agent --flag=a\\ b"), ["agent", "--flag=a b"]);
    assert.deepEqual(parseArgv("agent ''"), ["agent", ""]);
  });

  it("keeps backslashes literal inside single quotes", () => {
    assert.deepEqual(parseArgv("agent 'a\\b'"), ["agent", "a\\b"]);
  });

  it("refuses an unterminated quote instead of guessing", () => {
    assert.throws(() => parseArgv("agent 'unterminated"), AcpCommandError);
  });

  it("reports a missing or blank ACP_COMMAND as a typed error", () => {
    assert.throws(() => acpCommandArgv({}), AcpCommandError);
    assert.throws(() => acpCommandArgv({ ACP_COMMAND: "   " }), AcpCommandError);
  });

  it("reads the command out of the environment as argv", () => {
    assert.deepEqual(acpCommandArgv({ ACP_COMMAND: "opencode acp" }), [
      "opencode",
      "acp",
    ]);
  });
});

describe("spawnAcpChild", () => {
  it("captures a real exit code and reaps the group", async () => {
    const child = await spawnAcpChild({
      argv: [NODE, "-e", "process.exit(3)"],
      cwd: process.cwd(),
    });
    const result = await child.close();
    assert.equal(result.reaped, true);
    assert.equal(result.exit?.code, 3);
    assert.equal(result.exit?.error, null);
  });

  it("rejects with the real cause when the binary does not exist", async () => {
    // Previously this built a stream from null stdio and surfaced an opaque
    // TypeError, losing the ENOENT that actually explained the failure.
    await assert.rejects(
      spawnAcpChild({
        argv: ["definitely-not-a-real-acp-binary-xyz"],
        cwd: process.cwd(),
      }),
      (err: unknown) =>
        err instanceof AcpSpawnError &&
        err.code === "ENOENT" &&
        /could not be started/.test(err.message),
    );
  });

  it("bounds the stderr ring so a chatty harness cannot grow it forever", async () => {
    const child = await spawnAcpChild({
      argv: [NODE, "-e", "process.stderr.write('x'.repeat(200000))"],
      cwd: process.cwd(),
    });
    const exited = await child.exited;
    const tail = child.stderrTail();
    assert.equal(exited.code, 0);
    assert.ok(tail.length > 0, "stderr must still be captured");
    assert.ok(
      tail.length <= 64 * 1024,
      `stderr ring must stay bounded, got ${tail.length}`,
    );
  });

  it("close is idempotent and returns the same result", async () => {
    const child = await spawnAcpChild({
      argv: [NODE, "-e", "process.exit(0)"],
      cwd: process.cwd(),
    });
    const first = await child.close();
    const second = await child.close();
    assert.equal(first, second);
  });

  it("escalates to SIGTERM when the child outlives stdin EOF", async () => {
    // The interval keeps the child's loop alive, so only a signal reaps it.
    const child = await spawnReportingReady({
      argv: [
        NODE,
        "-e",
        `${KEEP_ALIVE}; ${REPORT}; process.on('SIGTERM', () => process.exit(7)); report();`,
      ],
      cwd: process.cwd(),
      exitGraceMs: 200,
      exitHardMs: 2_000,
    });
    const result = await child.close();
    assert.equal(result.reaped, true);
    assert.equal(result.exit?.code, 7);
  });

  it("escalates to SIGKILL when SIGTERM is ignored, and reports the signal", async () => {
    const child = await spawnReportingReady({
      argv: [NODE, "-e", `${KEEP_ALIVE}; ${REPORT}; process.on('SIGTERM', () => {}); report();`],
      cwd: process.cwd(),
      exitGraceMs: 200,
      exitHardMs: 300,
    });
    const result = await child.close();
    assert.equal(result.reaped, true);
    assert.equal(result.exit?.code, null);
    assert.equal(result.exit?.signal, "SIGKILL");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AcpCommandError,
  AcpSpawnError,
  acpCommandArgv,
  parseArgv,
  spawnAcpChild,
} from "./spawn.js";

const NODE = process.execPath;

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
    const child = await spawnAcpChild({
      argv: [
        NODE,
        "-e",
        "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(7));",
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
    const child = await spawnAcpChild({
      argv: [NODE, "-e", "setInterval(() => {}, 1000); process.on('SIGTERM', () => {});"],
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

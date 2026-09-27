import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AcpAuthRequiredError,
  AcpProbeResult,
  AcpProtocolMismatchError,
  AcpTerminalAuthUnsupportedError,
  runAcpProbe,
} from "./probe.js";
import { acpCommandArgv, spawnAcpChild } from "./spawn.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.js", import.meta.url));

// Each scenario needs its own child and its own disposable cwd; a real seat is
// never shared, so the fixture mirrors that instead of faking reuse.
async function withFakeAgent(
  scenario: string,
  body: (cwd: string, result: AcpProbeResult) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(path.join(tmpdir(), "k5-fake-acp-"));
  const child = await spawnAcpChild({
    argv: [process.execPath, FAKE_AGENT, scenario],
    cwd,
  });
  try {
    const result = await runAcpProbe({ stream: child.stream, cwd });
    await body(cwd, result);
  } finally {
    const closed = await child.close();
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(closed.reaped, true, "fake agent must be reaped");
  }
}

async function expectProbeRejection(
  scenario: string,
  predicate: (err: unknown) => boolean,
): Promise<void> {
  const cwd = mkdtempSync(path.join(tmpdir(), "k5-fake-acp-"));
  const child = await spawnAcpChild({
    argv: [process.execPath, FAKE_AGENT, scenario],
    cwd,
  });
  try {
    await assert.rejects(runAcpProbe({ stream: child.stream, cwd }), predicate);
  } finally {
    await child.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("acp probe against the deterministic fake agent", () => {
  it("completes initialize and session/new, then the child is reaped", async () => {
    await withFakeAgent("ok", async (_cwd, result) => {
      assert.equal(result.protocolVersion, 1);
      assert.equal(result.sessionId, "fake-session-1");
      assert.deepEqual(result.authOffers, []);
      assert.equal(result.authenticatedWith, null);
      // The fake advertises both a model and a mode, as a real harness does.
      assert.deepEqual(result.configOptionIds, ["model", "mode"]);
      assert.deepEqual(result.modeIds, ["build"]);
      assert.equal(result.agentInfo?.name, "FakeAgent");
    });
  });

  it("treats an auth method with no type as agent-kind and authenticates it", async () => {
    await withFakeAgent("agent-auth", async (_cwd, result) => {
      assert.deepEqual(result.authOffers, [
        { id: "fake-login", name: "Login with fake", kind: "agent" },
      ]);
      assert.equal(result.authenticatedWith, "fake-login");
    });
  });

  it("maps authenticate -32000 to a typed auth-required error", async () => {
    await expectProbeRejection(
      "auth-required",
      (err) => err instanceof AcpAuthRequiredError,
    );
  });

  it("maps provider auth reported at session/new to auth-required", async () => {
    await expectProbeRejection(
      "session-new-auth-required",
      (err) => err instanceof AcpAuthRequiredError,
    );
  });

  it("refuses a terminal auth method instead of skipping login", async () => {
    await expectProbeRejection(
      "terminal-auth",
      (err) =>
        err instanceof AcpTerminalAuthUnsupportedError && err.methodId === "fake-tty",
    );
  });

  it("refuses a protocol version it does not speak", async () => {
    await expectProbeRejection(
      "protocol-mismatch",
      (err) => err instanceof AcpProtocolMismatchError && err.offered === 99,
    );
  });
});

// The only tests permitted to touch a live seat. They skip loudly rather than
// mocking a pass when the harness binary or its provider auth is unavailable.
describe("acp probe against a real harness", () => {
  const command = process.env.ACP_COMMAND?.trim() || "opencode acp";

  function requireHarness(t: TestContext): string[] {
    let argv: string[];
    try {
      argv = acpCommandArgv({ ACP_COMMAND: command });
    } catch (err) {
      t.skip(`ACP_COMMAND unusable: ${(err as Error).message}`);
      return [];
    }
    try {
      execFileSync(argv[0], ["--version"], { stdio: "ignore", timeout: 20_000 });
    } catch (err) {
      t.skip(`${argv.join(" ")} not runnable here: ${(err as Error).message}`);
      return [];
    }
    return argv;
  }

  async function probeOnce(argv: string[]): Promise<AcpProbeResult> {
    const cwd = mkdtempSync(path.join(tmpdir(), "k5-acp-real-"));
    const child = await spawnAcpChild({ argv, cwd });
    try {
      const result = await runAcpProbe({
        stream: child.stream,
        cwd,
        requestTimeoutMs: 60_000,
      });
      return result;
    } finally {
      const closed = await child.close();
      rmSync(cwd, { recursive: true, force: true });
      assert.equal(
        closed.reaped,
        true,
        `harness child was not reaped: ${JSON.stringify(closed)}`,
      );
    }
  }

  it("initializes, creates a session, and exits", async (t) => {
    const argv = requireHarness(t);
    if (argv.length === 0) return;

    const result = await probeOnce(argv);
    assert.equal(result.protocolVersion, 1);
    assert.ok(result.sessionId.length > 0, "session/new must return a session id");
    assert.ok(result.agentInfo !== null, "initialize must report agentInfo");
    assert.equal(
      result.authenticatedWith,
      result.authOffers.find((o) => o.kind === "agent")?.id ?? null,
      "every advertised agent auth method must be attempted",
    );
  });

  it("issues distinct session ids for distinct seats", async (t) => {
    const argv = requireHarness(t);
    if (argv.length === 0) return;

    const first = await probeOnce(argv);
    const second = await probeOnce(argv);
    assert.ok(
      first.sessionId !== second.sessionId,
      `session ids must differ across seats, got ${first.sessionId} twice`,
    );
  });
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import type { BrowserCommand, ServerEvent } from "@k5-work/shared";
import { createGateway, type ConnectionHandlers } from "../ws/gateway.js";
import { SeatPool } from "./seat-pool.js";
import { SeatRunner } from "./seat-runner.js";
import { createSessionHandlers } from "./session-service.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.js", import.meta.url));
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const servers: Server[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_000);
      server.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
});

interface Harness {
  url: string;
  events: ServerEvent[];
  commands: BrowserCommand[];
  pool: SeatPool;
  projectDir: string;
  connect(origin: string | null): Promise<WebSocket>;
  close(): Promise<void>;
}

async function start(options: {
  access?: "read" | "review" | "full";
  pluginBearing?: boolean;
  disableLiveSeats?: boolean;
  projectId?: string;
  missingHarness?: boolean;
  scenario?: string;
  idleTtlMs?: number;
} = {}): Promise<Harness> {
  const projectDir = mkdtempSync(path.join(tmpdir(), "k5-session-"));
  if (options.pluginBearing) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(projectDir, ".opencode", "plugin"), { recursive: true });
  }

  const pool = new SeatPool({
    maxSeats: 4,
    idleTtlMs: options.idleTtlMs ?? 60_000,
  });
  const runner = new SeatRunner({
    pool,
    // A real command string, quoted as the parser expects: ACP_COMMAND is
    // tokenised shell-style and spawned without a shell, never JSON.
    acpCommand: options.missingHarness
      ? "definitely-not-a-real-harness-xyz"
      : `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} ${options.scenario ?? "ok"}`,
    disableLiveSeats: options.disableLiveSeats ?? false,
  });

  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  const events: ServerEvent[] = [];
  const commands: BrowserCommand[] = [];

  const gateway = createGateway({
    server,
    allowedOrigins: ["http://127.0.0.1:5173"],
    onConnect: (connection): ConnectionHandlers => {
      const handlers = createSessionHandlers(connection, {
        runner,
        pool,
        projects: {
          resolve: (id) => (id === (options.projectId ?? "p-1") ? projectDir : null),
        },
      });
      return {
        command: (c) => {
          commands.push(c);
          handlers.command(c);
        },
        overflow: () => handlers.overflow(),
        closed: () => handlers.closed(),
      };
    },
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  // Capture outbound events by wrapping the connection.
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    events,
    commands,
    pool,
    projectDir,
    async connect(origin) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws`,
        origin === null ? {} : { headers: { Origin: origin } },
      );
      await once(ws, "open");
      ws.on("message", (d) => events.push(JSON.parse(d.toString()) as ServerEvent));
      return ws;
    },
    async close() {
      await gateway.close();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

function openCommand(commandId = "c-1") {
  return JSON.stringify({ commandId, type: "session.open", projectId: "p-1" });
}

async function waitFor(
  events: ServerEvent[],
  type: ServerEvent["type"],
  timeoutMs = 30_000,
): Promise<ServerEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find((e) => e.type === type);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${type}; saw ${events.map((e) => e.type).join(", ")}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Polls the live event list. `waitFor` searches the array it is handed, so
 * passing an already-filtered snapshot would poll a frozen array taken before
 * the reply existed and time out no matter what the server sent.
 */
async function waitForCommand(
  events: ServerEvent[],
  commandId: string,
  timeoutMs = 30_000,
): Promise<Extract<ServerEvent, { type: "command.result" }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(
      (e): e is Extract<ServerEvent, { type: "command.result" }> =>
        e.type === "command.result" && e.commandId === commandId,
    );
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for command.result ${commandId}; saw ${events
          .map((e) => (e.type === "command.result" ? `${e.type}(${e.commandId})` : e.type))
          .join(", ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("session open over the gateway", () => {
  it("opens a seat and reports the reverse state on close", async () => {
    const h = await start();
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      const opened = await waitFor(h.events, "session.opened");
      assert.equal(opened.type, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");
      assert.equal(opened.projectId, "p-1");
      assert.equal(opened.cwd, h.projectDir);
      assert.deepEqual(
        opened.configOptions.map((o) => o.id),
        ["model", "mode"],
      );
      // Values carry the harness's own labels, so a user recognises a model
      // their credentials actually cover.
      assert.deepEqual(
        opened.configOptions[0].values.map((v) => v.value),
        ["opencode/space-bunny-free", "opencode/big-pickle"],
      );
      assert.equal(h.pool.activeCount, 1);

      ws.send(JSON.stringify({ commandId: "c-2", type: "session.close", sessionId: opened.sessionId }));
      await waitFor(h.events, "seat.reaped");
      await waitFor(h.events, "session.closed");
    } finally {
      await h.close();
    }
  });

  // The regression that mattered: a closing socket used to null the session
  // state and leave the harness process running with open stdio pipes.
  it("reaps the harness child when the socket closes", async () => {
    const h = await start();
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");

      const seat = h.pool.get(`opencode:p-1:full`);
      assert.ok(seat, "the seat must be tracked while the socket is open");
      const child = seat.child;
      const pid = child?.pid;
      assert.equal(typeof pid, "number");
      assert.equal(isAlive(pid as number), true);

      ws.terminate();
      // The child's own exit is the receipt. The pool key is released when
      // teardown *starts*, which is deliberately before the process is gone, so
      // polling for the pid to disappear would be racing the teardown it is
      // meant to observe.
      await child?.exited;
      assert.equal(h.pool.size, 0, "the seat key must be released after reaping");
      assert.equal(
        isAlive(pid as number),
        false,
        `harness pid ${String(pid)} must not outlive the socket`,
      );
    } finally {
      await h.close();
    }
  });

  it("refuses a plugin-bearing project and names the reason", async () => {
    const h = await start({ pluginBearing: true });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      const failed = await waitFor(h.events, "session.failed");
      assert.equal(failed.type, "session.failed");
      if (failed.type !== "session.failed") throw new Error("unreachable");
      assert.equal(failed.reason, "project-has-plugins");
      assert.match(failed.message ?? "", /OpenCode plugins/);
      assert.equal(h.pool.size, 0, "a refused project must not reserve a cap slot");
    } finally {
      await h.close();
    }
  });

  it("refuses every session when live seats are disabled", async () => {
    const h = await start({ disableLiveSeats: true });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      const failed = await waitFor(h.events, "session.failed");
      if (failed.type !== "session.failed") throw new Error("unreachable");
      assert.equal(failed.reason, "live-seats-disabled");
    } finally {
      await h.close();
    }
  });

  it("reports a missing harness as a typed failure, not a hang", async () => {
    const h = await start({ missingHarness: true });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      const failed = await waitFor(h.events, "session.failed");
      if (failed.type !== "session.failed") throw new Error("unreachable");
      assert.equal(failed.reason, "harness-unconfigured");
    } finally {
      await h.close();
    }
  });

  it("refuses an unknown project id rather than resolving a path", async () => {
    const h = await start({ projectId: "someone-elses-project" });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      const result = await waitFor(h.events, "command.result");
      if (result.type !== "command.result") throw new Error("unreachable");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "not-found");
    } finally {
      await h.close();
    }
  });

  it("refuses a second session on the same connection instead of queueing it", async () => {
    const h = await start();
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      await waitFor(h.events, "session.opened");
      ws.send(openCommand("c-2"));
      await new Promise((r) => setTimeout(r, 300));
      const busy = h.events.filter((e) => e.type === "command.result" && e.reason === "seat-busy");
      assert.equal(busy.length, 1, "the second open must be refused visibly");
    } finally {
      await h.close();
    }
  });

  it("rejects a forged permission decision and never reaches the agent", async () => {
    const h = await start();
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(
        JSON.stringify({
          commandId: "c-1",
          type: "permission.decide",
          sessionId: "s-1",
          requestId: "r-nope",
          optionId: "allow",
        }),
      );
      const resolved = await waitFor(h.events, "permission.resolved");
      if (resolved.type !== "permission.resolved") throw new Error("unreachable");
      assert.equal(resolved.reason, "forged");
    } finally {
      await h.close();
    }
  });
});

describe("session.configure", () => {
  it("applies an offered value and republishes the refreshed options", async () => {
    const h = await start();
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");

      ws.send(
        JSON.stringify({
          commandId: "c-2",
          type: "session.configure",
          sessionId: opened.sessionId,
          configOptionId: "model",
          value: "opencode/big-pickle",
        }),
      );
      const configured = await waitFor(h.events, "session.configured");
      if (configured.type !== "session.configured") throw new Error("unreachable");
      assert.equal(
        configured.configOptions.find((o) => o.id === "model")?.current,
        "opencode/big-pickle",
      );
      // Scoped to c-2: an unscoped find would match the session.open result.
      const result = await waitForCommand(h.events, "c-2");
      assert.equal(result.ok, true);
      assert.equal(result.reason, "ok");
    } finally {
      await h.close();
    }
  });

  it("refuses a model change while a turn is running", async () => {
    // The harness may reject a config change mid-turn, and that failure is
    // indistinguishable from a turn failure on the wire. Refusing up front keeps
    // the two apart, so a working turn is never reported as broken.
    const h = await start({ scenario: "slow" });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");

      ws.send(
        JSON.stringify({
          commandId: "c-turn",
          type: "session.prompt",
          sessionId: opened.sessionId,
          turnId: "t-1",
          text: "hello",
        }),
      );
      await waitFor(h.events, "turn.delta");

      ws.send(
        JSON.stringify({
          commandId: "c-cfg",
          type: "session.configure",
          sessionId: opened.sessionId,
          configOptionId: "model",
          value: "opencode/big-pickle",
        }),
      );
      const refused = await waitForCommand(h.events, "c-cfg");
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, "busy");
      // The turn must be untouched: still streaming, not failed.
      assert.notEqual(
        h.events.some((e) => e.type === "command.result" && e.commandId === "c-turn" && !e.ok),
        true,
      );
    } finally {
      await h.close();
    }
  });

  it("reports a value the harness never offered as a payload problem", async () => {
    const h = await start();
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");

      ws.send(
        JSON.stringify({
          commandId: "c-bad",
          type: "session.configure",
          sessionId: opened.sessionId,
          configOptionId: "model",
          value: "not-a-real-model",
        }),
      );
      const bad = await waitForCommand(h.events, "c-bad");
      assert.equal(bad.ok, false);
      // Not "internal": the browser sent something the harness never offered.
      assert.equal(bad.reason, "invalid-payload");
    } finally {
      await h.close();
    }
  });
});

describe("seat idle timeout", () => {
  it("closes an abandoned session and reaps the harness child", async () => {
    // The leak this closes: a tab left open after its last turn used to hold a
    // harness process forever. The child must actually die, not just leave the
    // pool table.
    const h = await start({ idleTtlMs: 400 });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");
      const child = h.pool.list()[0]?.child;
      const pid = child?.pid;
      assert.equal(typeof pid, "number");

      ws.send(
        JSON.stringify({
          commandId: "c-turn",
          type: "session.prompt",
          sessionId: opened.sessionId,
          turnId: "t-1",
          text: "hello",
        }),
      );
      await waitFor(h.events, "turn.completed");

      const closed = await waitFor(h.events, "session.closed");
      if (closed.type !== "session.closed") throw new Error("unreachable");
      // The reason has to be specific, or the user just sees a mystery
      // disconnect and cannot tell the session was closed on purpose.
      assert.equal(closed.reason, "idle-timeout");
      assert.equal(h.pool.activeCount, 0);

      // The real proof: the OS process is gone. Awaiting the child's own exit is
      // the receipt for that, rather than polling a pid that teardown has
      // already been asked to reap.
      await child?.exited;
      assert.equal(isAlive(pid as number), false, "the harness child outlived its idle timeout");
    } finally {
      await h.close();
    }
  });

  it("keeps the session alive while the user is still working", async () => {
    const h = await start({ idleTtlMs: 1_500 });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");

      ws.send(
        JSON.stringify({
          commandId: "c-turn",
          type: "session.prompt",
          sessionId: opened.sessionId,
          turnId: "t-1",
          text: "hello",
        }),
      );
      await waitFor(h.events, "turn.completed");

      // Keep sending well inside the TTL. A countdown that is not reset on
      // activity would close a session the user is actively using.
      for (const [i, turnId] of ["t-2", "t-3", "t-4", "t-5"].entries()) {
        await new Promise((r) => setTimeout(r, 400));
        ws.send(
          JSON.stringify({
            commandId: `c-keep-${turnId}`,
            type: "session.prompt",
            sessionId: opened.sessionId,
            turnId,
            text: `again ${i}`,
          }),
        );
        await waitFor(h.events, "turn.completed");
      }
      assert.equal(
        h.events.some((e) => e.type === "session.closed"),
        false,
        "an in-use session was closed as idle",
      );
      assert.equal(h.pool.activeCount, 1);
    } finally {
      await h.close();
    }
  });
});

describe("permission requests", () => {

  it("puts a harness permission request to the browser", async () => {
    // Before this handler existed the seat never answered
    // session/request_permission, so the harness waited forever and the turn
    // hung with nothing on screen to explain it.
    const h = await start({ scenario: "permission" });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");
      ws.send(
        JSON.stringify({
          commandId: "c-turn",
          type: "session.prompt",
          sessionId: opened.sessionId,
          turnId: "t-1",
          text: "do the thing",
        }),
      );
      const asked = await waitFor(h.events, "permission.requested");
      if (asked.type !== "permission.requested") throw new Error("unreachable");
      // The browser is told what is being asked for, not just that something is.
      assert.equal(asked.title, "write a file");
      assert.equal(asked.toolCallId, "tool-1");
      assert.deepEqual(
        asked.options.map((o) => o.optionId),
        ["allow-once", "reject"],
      );
      assert.equal(asked.turnId, "t-1");

      ws.send(
        JSON.stringify({
          commandId: "c-allow",
          type: "permission.decide",
          sessionId: opened.sessionId,
          requestId: asked.requestId,
          optionId: "allow-once",
        }),
      );
      const result = await waitForCommand(h.events, "c-allow");
      assert.equal(result.ok, true);
      // The turn must actually finish, proving the harness got its answer.
      await waitFor(h.events, "turn.completed");
      const delta = h.events.find(
        (e) => e.type === "turn.delta" && e.text.includes("ran the tool"),
      );
      assert.ok(delta, "the harness was not told the permission was granted");
    } finally {
      await h.close();
    }
  });

  it("passes a cancelled decision to the harness", async () => {
    const h = await start({ scenario: "permission" });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");
      ws.send(
        JSON.stringify({
          commandId: "c-turn",
          type: "session.prompt",
          sessionId: opened.sessionId,
          turnId: "t-1",
          text: "do the thing",
        }),
      );
      const asked = await waitFor(h.events, "permission.requested");
      if (asked.type !== "permission.requested") throw new Error("unreachable");

      ws.send(
        JSON.stringify({
          commandId: "c-no",
          type: "permission.decide",
          sessionId: opened.sessionId,
          requestId: asked.requestId,
          optionId: null,
        }),
      );
      const result = await waitForCommand(h.events, "c-no");
      assert.equal(result.ok, true);
      await waitFor(h.events, "turn.completed");
      // The point of the test: a refusal is never reported to the agent as
      // consent.
      const delta = h.events.find(
        (e) => e.type === "turn.delta" && e.text.includes("skipped the tool"),
      );
      assert.ok(delta, "a cancelled decision was not passed to the harness");
    } finally {
      await h.close();
    }
  });

  it("refuses an option the harness never offered", async () => {
    const h = await start({ scenario: "permission" });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");
      ws.send(
        JSON.stringify({
          commandId: "c-turn",
          type: "session.prompt",
          sessionId: opened.sessionId,
          turnId: "t-1",
          text: "do the thing",
        }),
      );
      const asked = await waitFor(h.events, "permission.requested");
      if (asked.type !== "permission.requested") throw new Error("unreachable");

      ws.send(
        JSON.stringify({
          commandId: "c-forged",
          type: "permission.decide",
          sessionId: opened.sessionId,
          requestId: asked.requestId,
          optionId: "allow-everything",
        }),
      );
      const result = await waitForCommand(h.events, "c-forged");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "invalid-payload");
      // The question is still live, so the user can still answer properly.
      assert.equal(
        h.events.some((e) => e.type === "permission.resolved" && e.reason === "forged"),
        true,
      );
    } finally {
      await h.close();
    }
  });

  it("resolves an outstanding permission when the turn is cancelled", async () => {
    // Cancelling must not leave the question hanging. A harness blocked on
    // session/request_permission waits forever, and the browser keeps a prompt
    // for a turn that no longer exists.
    const h = await start({ scenario: "permission" });
    try {
      const ws = await h.connect("http://127.0.0.1:5173");
      ws.send(openCommand("c-1"));
      const opened = await waitFor(h.events, "session.opened");
      if (opened.type !== "session.opened") throw new Error("unreachable");
      ws.send(
        JSON.stringify({
          commandId: "c-turn",
          type: "session.prompt",
          sessionId: opened.sessionId,
          turnId: "t-1",
          text: "go",
        }),
      );
      const asked = await waitFor(h.events, "permission.requested");
      if (asked.type !== "permission.requested") throw new Error("unreachable");

      ws.send(
        JSON.stringify({
          commandId: "c-cancel",
          type: "session.cancel",
          sessionId: opened.sessionId,
        }),
      );
      const resolved = await waitFor(h.events, "permission.resolved", 3_000);
      if (resolved.type !== "permission.resolved") throw new Error("unreachable");
      assert.equal(resolved.requestId, asked.requestId);
      assert.equal(resolved.reason, "cancelled");
      // The turn still ends normally rather than being left marked running.
      await waitFor(h.events, "turn.completed");
    } finally {
      await h.close();
    }
  });
});

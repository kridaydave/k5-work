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
import { projectTranscript } from "@k5-work/shared";
import { createGateway, type ConnectionHandlers } from "../ws/gateway.js";
import { SeatPool } from "./seat-pool.js";
import { SeatRunner } from "./seat-runner.js";
import { createSessionHandlers } from "./session-service.js";
import { SessionStore } from "../store/session-store.js";
import type { AcpChild } from "./spawn.js";

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
  /** Present only when the harness was started with `record: true`. */
  store: SessionStore | null;
  /** Every harness process spawned so far, so a reap can be asserted by pid. */
  children: AcpChild[];
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
  /** Wires a real durable store, so recording is exercised end to end. */
  record?: boolean;
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
  const store = options.record === true ? new SessionStore({ root: path.join(projectDir, "store") }) : null;
  const children: AcpChild[] = [];
  if (store !== null) await store.open();

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
        onChild: (child) => children.push(child),
        ...(store === null
          ? {}
          : {
              recorder: {
                create: (input) => store.create(input),
                append: (storeId, event) => store.append(storeId, event),
                flush: (storeId) => store.flushMeta(storeId),
                setTitle: (storeId, title) => store.setTitle(storeId, title),
                titleFromPrompt: (storeId, prompt) => store.titleFromPrompt(storeId, prompt),
                remove: (storeId) => store.remove(storeId),
                stored: (storeId) => store.stored(storeId),
              },
            }),
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
      if (store !== null) await store.close();
      rmSync(projectDir, { recursive: true, force: true });
    },
    store,
    children,
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

describe("a harness that asks for permission", () => {
  it("is refused and its turn still ends, rather than being left waiting", async () => {
    // There is no permission screen, so the seat answers cancelled. The property
    // that matters is both halves: the harness is not left blocked on a request
    // nobody will answer, and a refusal is never reported to it as consent.
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

      // The turn terminates, so the harness was not left blocked.
      await waitFor(h.events, "turn.completed");
      const delta = h.events.find(
        (e) => e.type === "turn.delta" && e.text.includes("skipped the tool"),
      );
      assert.ok(
        delta,
        "the harness must be told the permission was refused, not granted",
      );
      assert.equal(
        h.events.some((e) => e.type === "turn.delta" && e.text.includes("ran the tool")),
        false,
        "a permission the user never gave must never look granted",
      );
    } finally {
      await h.close();
    }
  });
});

// --- durable recording ---
// k5 owns the transcript, so every event the service emits is recorded before it
// is sent. These run the real store against the fake harness, so they exercise
// the whole path rather than a mock's idea of it.

describe("durable session recording", () => {
  async function recordedTranscript(
    harness: Harness,
    opts: { scenario?: string } = {},
  ): Promise<{ turns: ReturnType<typeof projectTranscript>["turns"]; titles: string[] }> {
    const ws = await harness.connect("http://127.0.0.1:5173");
    try {
      ws.send(openCommand());
      await waitFor(harness.events, "session.opened");
      ws.send(
        JSON.stringify({
          commandId: "c-2",
          type: "session.prompt",
          sessionId: "fake-session-1",
          turnId: "t-1",
          text: "make the sidebar remember things",
        }),
      );
      await waitFor(harness.events, "turn.completed");
      const store = harness.store;
      assert.ok(store !== null, "the harness must have been started with record: true");
      // The browser is told the turn ended as soon as it is emitted, but the
      // append is still queued, so wait on the store's own receipt rather than
      // reading a half-written log.
      await store.flushMeta(store.list()[0]!.storeId);
      const summaries = store.list();
      assert.equal(summaries.length, 1, "exactly one task was recorded");
      const page = await store.read(summaries[0]!.storeId, null);
      // Paging is bounded, so a helper that ignored hasMore would silently read
      // a prefix and pass a half-tested turn.
      assert.equal(page.hasMore, false, "the whole turn must fit in one page for this test");
      assert.equal(page.dropped, 0, "and nothing may be skipped");
      const transcript = projectTranscript(
        page.events.map((e) => ({ v: 1 as const, seq: e.seq, ts: e.ts, event: e.event })),
      );
      return { turns: transcript.turns, titles: summaries.map((s) => s.title) };
    } finally {
      ws.close();
    }
  }

  it("records a whole turn so a reloaded session shows both halves", async () => {
    const harness = await start({ record: true });
    try {
      const { turns } = await recordedTranscript(harness);
      assert.equal(turns.length, 1);
      // Without the prompt on turn.started the reloaded transcript showed only
      // the assistant's half of the exchange.
      assert.equal(turns[0]?.userText, "make the sidebar remember things");
      assert.equal(turns[0]?.assistantText, "first second third");
      assert.equal(turns[0]?.stopReason, "end_turn");
    } finally {
      await harness.close();
    }
  });

  it("records tool cards, with the same correction a live view applies", async () => {
    const harness = await start({ record: true });
    try {
      const { turns } = await recordedTranscript(harness);
      assert.equal(turns[0]?.tools.length, 1);
      assert.equal(turns[0]?.tools[0]?.title, "read file");
      // The fake reports the card completed, so it must stay completed rather
      // than being rewritten as cancelled.
      assert.equal(turns[0]?.tools[0]?.status, "completed");
      assert.equal(turns[0]?.tools[0]?.lifecycle, "active");
    } finally {
      await harness.close();
    }
  });

  it("does not record command.result, which is not session history", async () => {
    const harness = await start({ record: true });
    try {
      const ws = await harness.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      await waitFor(harness.events, "session.opened");
      const store = harness.store;
      assert.ok(store !== null);
      const page = await store.read(store.list()[0]!.storeId, null);
      const types = page.events.map((e) => e.event.type);
      assert.ok(!types.includes("command.result"), `recorded: ${types.join(", ")}`);
      assert.ok(types.includes("session.opened"));
      ws.close();
    } finally {
      await harness.close();
    }
  });

  it("falls back to the first prompt when the harness never names the session", async () => {
    const harness = await start({ record: true });
    try {
      const { titles } = await recordedTranscript(harness);
      assert.equal(titles[0], "make the sidebar remember things");
    } finally {
      await harness.close();
    }
  });

  it("prefers the harness's own title over the prompt fallback", async () => {
    const harness = await start({ record: true, scenario: "session-title" });
    try {
      const { titles } = await recordedTranscript(harness);
      assert.equal(titles[0], "Refactor the session store");
    } finally {
      await harness.close();
    }
  });

  it("emits session.updated for the harness title and keeps the fallback when there is none", async () => {
    const named = await start({ record: true, scenario: "session-title" });
    try {
      const ws = await named.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      await waitFor(named.events, "session.opened");
      ws.send(
        JSON.stringify({
          commandId: "c-2",
          type: "session.prompt",
          sessionId: "fake-session-1",
          turnId: "t-1",
          text: "hello",
        }),
      );
      const updated = await waitFor(named.events, "session.updated");
      assert.equal(
        updated.type === "session.updated" ? updated.title : null,
        "Refactor the session store",
      );
      ws.close();
    } finally {
      await named.close();
    }

    // A timestamp with no title must reach the service and apply the ordering
    // hint without blanking the fallback title. The previous fake sent an update
    // with no fields at all, which the classifier ignored, so this asserted
    // nothing.
    const bare = await start({ record: true, scenario: "meta-update" });
    try {
      const { titles } = await recordedTranscript(bare);
      assert.equal(titles[0], "make the sidebar remember things");
    } finally {
      await bare.close();
    }
  });

  it("leaves the transcript an ending when the socket dies mid-turn", async () => {
    // Without a terminator the log stops mid-turn and a reloaded session shows
    // tool cards that spin forever. Waited on an explicit receipt, not a poll:
    // AGENTS.md forbids sleep-based waits, and this file already uses the child's
    // own exit for exactly this reason.
    const harness = await start({ record: true, scenario: "slow" });
    try {
      const reapRecorded = new Deferred<void>();
      const store = harness.store;
      assert.ok(store !== null);
      // The receipt is durability, not the append call: appends are queued, so
      // resolving when the wrapper is entered let the read run against a log the
      // terminator had not reached yet, which failed about one run in three.
      const originalAppend = store.append.bind(store);
      store.append = (storeId: string, event: Parameters<typeof originalAppend>[1]): void => {
        originalAppend(storeId, event);
        const terminates = event.type === "turn.completed" && event.stopReason === "k5-cancelled";
        if (!terminates) return;
        void store.flushMeta(storeId).then(() => reapRecorded.resolve(), () => reapRecorded.resolve());
      };

      const ws = await harness.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      await waitFor(harness.events, "session.opened");
      ws.send(
        JSON.stringify({
          commandId: "c-2",
          type: "session.prompt",
          sessionId: "fake-session-1",
          turnId: "t-1",
          text: "a long task",
        }),
      );
      await waitFor(harness.events, "turn.delta");
      // Drop the socket with the turn still running.
      ws.terminate();
      await reapRecorded.wait(20_000);

      const page = await store.read(store.list()[0]!.storeId, null);
      const types = page.events.map((e) => e.event.type);
      assert.ok(types.includes("seat.reaped"), `expected a reap; saw ${types.join(", ")}`);
      const transcript = projectTranscript(
        page.events.map((e) => ({ v: 1 as const, seq: e.seq, ts: e.ts, event: e.event })),
      );
      // The turn is terminated, so it has a stop reason rather than staying open.
      const turn = transcript.turns[0];
      assert.equal(turn?.stopReason, "k5-cancelled", "the open turn must reach a stop reason");
      // And nothing may look like it is still running.
      for (const card of turn?.tools ?? []) {
        assert.notEqual(card.lifecycle, "active", `card ${card.toolCallId} still looks live`);
      }
    } finally {
      await harness.close();
    }
  });

  it("counts the recorded turn in the stored summary", async () => {
    const harness = await start({ record: true });
    try {
      await recordedTranscript(harness);
      const store = harness.store;
      assert.ok(store !== null);
      const summary = store.list()[0]!;
      assert.equal(summary.turnCount, 1);
      // A recorded turn is not a truncated one, and the harness is the only
      // source of a title, so the flag must say "prompt" rather than "none".
      assert.equal(summary.truncated, false);
      assert.equal(store.meta(summary.storeId)?.titleSource, "prompt");
      assert.equal(store.meta(summary.storeId)?.endedMidTurn, false);
    } finally {
      await harness.close();
    }
  });

  it("refuses a second concurrent open rather than leaking a harness child", async () => {
    // state.seat is only assigned after the open resolves, so a second command
    // arriving in that window used to read a null seat and start a second
    // harness. The loser stayed tracked and was never reaped.
    const harness = await start({ record: true });
    try {
      const ws = await harness.connect("http://127.0.0.1:5173");
      // Both commands go out before either can have finished spawning.
      ws.send(openCommand("c-1"));
      ws.send(openCommand("c-2"));
      const results = await waitForAll(
        harness.events,
        (e) => e.type === "command.result",
        2,
      );
      const refused = results.filter(
        (e): e is Extract<ServerEvent, { type: "command.result" }> =>
          e.type === "command.result" && !e.ok && e.reason === "seat-busy",
      );
      assert.equal(refused.length, 1, `expected exactly one refusal, saw ${refused.length}`);
      const opened = harness.events.filter((e) => e.type === "session.opened");
      assert.equal(opened.length, 1, "only one session may be opened");
      // And the loser left no ghost record behind.
      await harness.pool.sweepProvisional();
      const store = harness.store;
      assert.ok(store !== null);
      assert.equal(store.list().length, 1, "only one stored task may exist");
      ws.close();
    } finally {
      await harness.close();
    }
  });
});

/** A one-shot promise, so a test can wait on a real receipt rather than a poll. */
class Deferred<T> {
  private resolveFn: (value: T) => void = () => {};
  readonly promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  resolve(value: T): void {
    this.resolveFn(value);
  }

  async wait(timeoutMs: number): Promise<T> {
    const timer = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      t.unref();
    });
    return Promise.race([this.promise, timer]);
  }
}

/** Waits for `count` events matching `predicate`, on the live event list. */
async function waitForAll(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  count: number,
  timeoutMs = 30_000,
): Promise<ServerEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.filter(predicate);
    if (found.length >= count) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} matching events; saw ${found.length}. ${events
          .map((e) => e.type)
          .join(", ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// --- discovery and continuation ---

describe("session discovery and continuation", () => {
  it("lists harness sessions without creating one, and reaps the read seat", async () => {
    // The workspace's promise is that an empty hero costs no harness process, so
    // a list gets its own short-lived seat and leaves nothing behind.
    const harness = await start({ record: true });
    try {
      const ws = await harness.connect("http://127.0.0.1:5173");
      ws.send(JSON.stringify({ commandId: "c-1", type: "session.list", projectId: "p-1" }));
      const listed = await waitFor(harness.events, "session.listed");
      assert.equal(listed.type, "session.listed");
      if (listed.type !== "session.listed") return;
      assert.equal(listed.unsupported, false);
      assert.ok(listed.sessions.length > 0, "the fake reports sessions for this cwd");
      // No session was created by a read.
      assert.equal(
        harness.events.some((e) => e.type === "session.opened"),
        false,
        "listing must not open a session",
      );
      // The read seat must be reaped, asserted on the process rather than on the
      // pool: a read takes no slot, so pool.activeCount is 0 whether or not the
      // child died. The reviewer removed the reap from the built output and this
      // assertion still passed.
      assert.ok(harness.children.length > 0, "a list must have spawned a harness");
      for (const child of harness.children) {
        if (child.pid === undefined) continue;
        await child.exited;
        assert.equal(isAlive(child.pid), false, `read seat pid ${child.pid} is still running`);
      }
      ws.close();
    } finally {
      await harness.close();
    }
  });

  it("reports an unsupportable harness as unsupported, not as an empty list", async () => {
    // Only one of these two is a real answer, and the difference matters to a user.
    const harness = await start({ scenario: "no-session-caps" });
    try {
      const ws = await harness.connect("http://127.0.0.1:5173");
      ws.send(JSON.stringify({ commandId: "c-1", type: "session.list", projectId: "p-1" }));
      const listed = await waitFor(harness.events, "session.listed");
      assert.equal(listed.type, "session.listed");
      if (listed.type !== "session.listed") return;
      assert.equal(listed.unsupported, true);
      assert.deepEqual(listed.sessions, []);
      const result = await waitForCommand(harness.events, "c-1");
      assert.equal(result.ok, true, "an unsupported capability is not a command failure");
      for (const child of harness.children) {
        if (child.pid === undefined) continue;
        await child.exited;
        assert.equal(isAlive(child.pid), false, `read seat pid ${child.pid} is still running`);
      }
      ws.close();
    } finally {
      await harness.close();
    }
  });

  it("continues a stored task and refuses one whose project has moved", async () => {
    const harness = await start({ record: true });
    try {
      // Record a real task first, so there is a store id to continue.
      const ws = await harness.connect("http://127.0.0.1:5173");
      ws.send(openCommand());
      await waitFor(harness.events, "session.opened");
      ws.send(
        JSON.stringify({
          commandId: "c-2",
          type: "session.prompt",
          sessionId: "fake-session-1",
          turnId: "t-1",
          text: "a task worth keeping",
        }),
      );
      await waitFor(harness.events, "turn.completed");
      const store = harness.store;
      assert.ok(store !== null);
      const stored = store.list()[0]!;
      ws.close();

      // A new connection continues it by k5 store id.
      harness.events.length = 0;
      const second = await harness.connect("http://127.0.0.1:5173");
      second.send(
        JSON.stringify({ commandId: "c-3", type: "session.load", storeId: stored.storeId }),
      );
      const loaded = await waitFor(harness.events, "session.loaded");
      assert.equal(loaded.type, "session.loaded");
      if (loaded.type !== "session.loaded") return;
      assert.equal(loaded.storeId, stored.storeId);
      // The harness session id came from the store, never from the browser.
      assert.equal(loaded.sessionId, "fake-session-1");
      assert.equal(loaded.cwd, harness.projectDir);
      const opened = await waitFor(harness.events, "session.opened");
      assert.equal(opened.type === "session.opened" ? opened.sessionId : null, "fake-session-1");
      second.close();
    } finally {
      await harness.close();
    }
  });

  it("refuses to continue a task whose recorded cwd is not the project it is opened from", async () => {
    // ACP requires the request cwd to match the session's own, so a task whose
    // project moved must fail loudly rather than resume against another directory.
    const harness = await start({ record: true });
    try {
      const store = harness.store;
      assert.ok(store !== null);
      const created = await store.create({
        harness: "opencode",
        harnessSessionId: "fake-session-1",
        projectId: "p-1",
        projectName: null,
        cwd: harness.projectDir,
        title: "moved task",
      });
      // The stored record claims a different directory.
      const meta = store.meta(created.storeId);
      assert.ok(meta !== null);
      await store.remove(created.storeId);
      const moved = await store.create({
        harness: "opencode",
        harnessSessionId: "fake-session-1",
        projectId: "p-1",
        projectName: null,
        cwd: harness.projectDir,
        title: "moved task",
      });
      const summary = store.meta(moved.storeId);
      assert.ok(summary !== null);
      // Rewrite the stored cwd by hand, as a moved project would look on disk,
      // then rescan: the index is authoritative until it is reloaded.
      const raw = { ...summary, cwd: "/somewhere/else" };
      await fspWriteMeta(harness.projectDir, moved.storeId, raw);
      await store.rescan();
      assert.equal(store.stored(moved.storeId)?.cwd, "/somewhere/else");

      const ws = await harness.connect("http://127.0.0.1:5173");
      ws.send(
        JSON.stringify({ commandId: "c-9", type: "session.load", storeId: moved.storeId }),
      );
      const result = await waitForCommand(harness.events, "c-9");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "cwd-mismatch");
      assert.equal(
        harness.events.some((e) => e.type === "session.loaded"),
        false,
        "and nothing may be opened",
      );
      ws.close();
    } finally {
      await harness.close();
    }
  });

  it("refuses a store id it has never issued", async () => {
    const harness = await start({ record: true });
    try {
      const ws = await harness.connect("http://127.0.0.1:5173");
      ws.send(
        JSON.stringify({
          commandId: "c-1",
          type: "session.load",
          storeId: "11111111-1111-4111-8111-111111111111",
        }),
      );
      const result = await waitForCommand(harness.events, "c-1");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "session-unknown");
      ws.close();
    } finally {
      await harness.close();
    }
  });
});

/** Rewrites a stored session's meta, to model a record that no longer matches. */
async function fspWriteMeta(
  projectDir: string,
  storeId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const { createHash } = await import("node:crypto");
  const { readdir, writeFile } = await import("node:fs/promises");
  const dirName = `s-${createHash("sha256").update(storeId, "utf8").digest("hex").slice(0, 32)}`;
  const storeRoot = path.join(projectDir, "store");
  const dir = path.join(storeRoot, dirName);
  const entries = await readdir(dir).catch(() => []);
  void entries;
  await writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta)}\n`, "utf8");
}

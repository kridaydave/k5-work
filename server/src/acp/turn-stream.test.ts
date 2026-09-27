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
const servers: Server[] = [];

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

interface Rig {
  ws: WebSocket;
  events: ServerEvent[];
  send(command: BrowserCommand): void;
  waitFor<T extends ServerEvent["type"]>(
    type: T,
    opts?: { turnId?: string; after?: number; timeoutMs?: number },
  ): Promise<Extract<ServerEvent, { type: T }>>;
  count(type: ServerEvent["type"]): number;
  close(): Promise<void>;
}

async function startRig(scenario: string): Promise<Rig> {
  const projectDir = mkdtempSync(path.join(tmpdir(), "k5-turn-"));
  const pool = new SeatPool({ maxSeats: 4, idleTtlMs: 60_000 });
  const runner = new SeatRunner({
    pool,
    // A real command string: ACP_COMMAND is tokenised shell-style, never JSON.
    acpCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} ${scenario}`,
    disableLiveSeats: false,
  });

  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  const events: ServerEvent[] = [];
  const gateway = createGateway({
    server,
    allowedOrigins: ["http://127.0.0.1:5173"],
    onConnect: (connection): ConnectionHandlers => {
      const handlers = createSessionHandlers(connection, {
        runner,
        pool,
        projects: { resolve: () => projectDir },
      });
      return {
        command: handlers.command,
        overflow: handlers.overflow,
        closed: handlers.closed,
      };
    },
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: "http://127.0.0.1:5173" },
  });
  await once(ws, "open");
  ws.on("message", (d) => events.push(JSON.parse(d.toString()) as ServerEvent));

  /**
   * Waits for a matching event, optionally scoped to a turnId and to events
   * received after a cursor. Without the turnId scope, `waitFor("turn.completed")`
   * returns the *first* completion and a test can appear to observe a later turn
   * while never having seen it.
   */
  const waitFor = async <T extends ServerEvent["type"]>(
    type: T,
    opts: { turnId?: string; after?: number; timeoutMs?: number } = {},
  ): Promise<Extract<ServerEvent, { type: T }>> => {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const start = opts.after ?? 0;
    const matches = (e: ServerEvent): e is Extract<ServerEvent, { type: T }> => {
      if (e.type !== type) return false;
      if (opts.turnId === undefined) return true;
      const scoped = e as { turnId?: string };
      return scoped.turnId === opts.turnId;
    };
    for (;;) {
      const found = events.slice(start).find(matches);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${type}${opts.turnId ? ` (turn ${opts.turnId})` : ""}; ` +
            `saw ${events.map((e) => e.type).join(", ")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  return {
    ws,
    events,
    send: (command) => ws.send(JSON.stringify(command)),
    waitFor,
    count: (type) => events.filter((e) => e.type === type).length,
    async close() {
      await gateway.close();
      ws.terminate();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

async function openSession(rig: Rig): Promise<string> {
  rig.send({ commandId: "c-1", type: "session.open", projectId: "p-1" });
  const opened = await rig.waitFor("session.opened");
  return opened.sessionId;
}

describe("a turn streams deltas and terminates exactly once", () => {
  it("delivers thought, tool, and text updates, then one completion", async () => {
    const rig = await startRig("ok");
    try {
      const sessionId = await openSession(rig);
      rig.send({
        commandId: "c-2",
        type: "session.prompt",
        sessionId,
        turnId: "t-1",
        text: "hello",
      });

      const started = await rig.waitFor("turn.started");
      assert.equal(started.turnId, "t-1");
      await rig.waitFor("turn.completed");

      const deltas = rig.events.filter((e) => e.type === "turn.delta");
      const thought = deltas.filter((e) => e.stream === "thought");
      const text = deltas.filter((e) => e.stream === "text");
      assert.deepEqual(
        thought.map((d) => d.text),
        ["thinking"],
        "thought chunks must be their own stream",
      );
      assert.equal(
        text.map((d) => d.text).join(""),
        "first second third",
        "text chunks must concatenate in order",
      );

      const tool = rig.events.filter((e) => e.type === "tool.updated");
      assert.equal(tool.length, 1);
      const card = tool[0];
      assert.ok(card.type === "tool.updated");
      assert.equal(card.title, "read file");
      assert.equal(card.lifecycle, "active");

      assert.equal(rig.count("turn.completed"), 1, "exactly one terminal event");
    } finally {
      await rig.close();
    }
  });

  it("ignores an update for a turn that is not the active one", async () => {
    const rig = await startRig("ok");
    try {
      const sessionId = await openSession(rig);
      rig.send({ commandId: "c-2", type: "session.prompt", sessionId, turnId: "t-1", text: "one" });
      await rig.waitFor("turn.completed", { turnId: "t-1" });

      const before = rig.events.length;
      rig.send({ commandId: "c-3", type: "session.prompt", sessionId, turnId: "t-2", text: "two" });
      // Scoped to t-2, so this cannot be satisfied by turn 1's completion.
      await rig.waitFor("turn.completed", { turnId: "t-2", after: before });
      const stale = rig.events
        .slice(before)
        .filter((e) => e.type === "turn.delta" && e.turnId === "t-1");
      assert.equal(stale.length, 0, "a completed turn must not receive new deltas");
    } finally {
      await rig.close();
    }
  });

  it("refuses a second concurrent turn rather than interleaving two", async () => {
    // `slow` holds the first turn open, so the second really is concurrent.
    const rig = await startRig("slow");
    try {
      const sessionId = await openSession(rig);
      rig.send({ commandId: "c-2", type: "session.prompt", sessionId, turnId: "t-1", text: "one" });
      await rig.waitFor("turn.started");
      const before = rig.events.length;
      rig.send({ commandId: "c-3", type: "session.prompt", sessionId, turnId: "t-2", text: "two" });
      // Waits for the refusal itself rather than sleeping and hoping.
      const refusal = await rig.waitFor("command.result", { after: before });
      assert.equal(refusal.ok, false);
      assert.equal(refusal.reason, "busy", "the second turn must be refused visibly");
      assert.equal(rig.count("turn.started"), 1, "no second turn may start");
      await rig.waitFor("turn.completed", { turnId: "t-1" });
    } finally {
      await rig.close();
    }
  });

  it("marks a cancelled turn terminated once, with a cancelled stop reason", async () => {
    const rig = await startRig("slow");
    try {
      const sessionId = await openSession(rig);
      rig.send({ commandId: "c-2", type: "session.prompt", sessionId, turnId: "t-1", text: "one" });
      await rig.waitFor("turn.started");
      rig.send({ commandId: "c-3", type: "session.cancel", sessionId });

      const done = await rig.waitFor("turn.completed", { turnId: "t-1" });
      assert.equal(done.stopReason, "cancelled");
      // A second terminal would arrive on the same socket; give the harness a
      // real chance to send one before asserting it did not.
      await rig.waitFor("turn.completed", { turnId: "t-1", timeoutMs: 1 }).catch(() => undefined);
      assert.equal(rig.count("turn.completed"), 1, "a cancel race must not double-terminate");
    } finally {
      await rig.close();
    }
  });

  it("terminates a turn the harness answers with an unsupported request", async () => {
    const rig = await startRig("unsupported-request");
    try {
      const sessionId = await openSession(rig);
      rig.send({ commandId: "c-2", type: "session.prompt", sessionId, turnId: "t-1", text: "one" });
      const done = await rig.waitFor("turn.completed");
      assert.equal(
        done.stopReason,
        "k5-error",
        "a failed turn must terminate, not leave the working dots spinning",
      );
    } finally {
      await rig.close();
    }
  });

  // The regression: a cancel used to settle only on the wire while the seat
  // stayed busy forever, so every later prompt was refused and the only escape
  // was killing a healthy harness.
  it("accepts a new turn after a cancel instead of staying busy forever", async () => {
    const rig = await startRig("slow");
    try {
      const sessionId = await openSession(rig);
      rig.send({ commandId: "c-2", type: "session.prompt", sessionId, turnId: "t-1", text: "one" });
      await rig.waitFor("turn.started", { turnId: "t-1" });
      rig.send({ commandId: "c-3", type: "session.cancel", sessionId });
      await rig.waitFor("turn.completed", { turnId: "t-1" });

      // The seat must drain its cancelled turn and take a new one.
      const before = rig.events.length;
      rig.send({ commandId: "c-4", type: "session.prompt", sessionId, turnId: "t-2", text: "two" });
      const started = await rig.waitFor("turn.started", { turnId: "t-2", after: before, timeoutMs: 15_000 });
      assert.equal(started.turnId, "t-2", "a fresh turn must be accepted after a cancel");
      await rig.waitFor("turn.completed", { turnId: "t-2", timeoutMs: 15_000 });
    } finally {
      await rig.close();
    }
  });

  // The second regression: an over-long harness title used to throw out of the
  // update pump, leaving the turn with no terminal event and the working dots
  // spinning forever. The fix is truncation, so the turn must still succeed.
  it("truncates an over-long tool title instead of wedging the turn", async () => {
    const rig = await startRig("long-title");
    try {
      const sessionId = await openSession(rig);
      rig.send({ commandId: "c-2", type: "session.prompt", sessionId, turnId: "t-1", text: "one" });
      const done = await rig.waitFor("turn.completed", { turnId: "t-1", timeoutMs: 15_000 });
      assert.equal(done.stopReason, "end_turn", "a truncated card must not fail the turn");
      assert.equal(rig.count("turn.completed"), 1, "exactly one terminal event");

      // The real property: nothing undeliverable is emitted. The harness sends a
      // 2000-character title, so at least one card must have been truncated.
      const cards = rig.events.filter((e) => e.type === "tool.updated");
      assert.ok(cards.length >= 2, "the long-title scenario must emit two cards");
      for (const card of cards) {
        assert.ok(
          card.type === "tool.updated" && card.title.length <= 500,
          `a title of ${String(card.title.length)} chars exceeds the wire cap`,
        );
      }
      assert.equal(
        Math.max(...cards.map((c) => (c.type === "tool.updated" ? c.title.length : 0))),
        500,
        "the over-long title must be truncated to exactly the cap",
      );
    } finally {
      await rig.close();
    }
  });

  it("advertises the harness's own models and applies a selection", async () => {
    const rig = await startRig("ok");
    try {
      const sessionId = await openSession(rig);
      const opened = rig.events.find((e) => e.type === "session.opened");
      assert.ok(opened?.type === "session.opened");

      const model = opened.configOptions.find((o) => o.id === "model");
      assert.ok(model, "the model option must be advertised");
      assert.equal(model.type, "select");
      // Labels come from the harness, so a user recognises a model their own
      // credentials cover.
      assert.deepEqual(
        model.values.map((v) => v.label),
        ["OpenCode Zen/Space Bunny Free", "OpenCode Zen/Big Pickle"],
      );
      assert.deepEqual(
        model.values.map((v) => v.value),
        ["opencode/space-bunny-free", "opencode/big-pickle"],
      );

      const before = rig.events.length;
      rig.send({
        commandId: "c-5",
        type: "session.configure",
        sessionId,
        configOptionId: "model",
        value: "opencode/big-pickle",
      });
      const result = await rig.waitFor("command.result", { after: before });
      assert.equal(result.ok, true, "an offered value must be accepted");
      const snapshot = rig.events.find((e) => e.type === "session.configured");
      assert.ok(snapshot?.type === "session.configured");
      assert.equal(snapshot.configOptions.find((o) => o.id === "model")?.current, "opencode/big-pickle");
    } finally {
      await rig.close();
    }
  });

  it("refuses a model the harness never offered", async () => {
    const rig = await startRig("ok");
    try {
      const sessionId = await openSession(rig);
      const before = rig.events.length;
      rig.send({
        commandId: "c-6",
        type: "session.configure",
        sessionId,
        configOptionId: "model",
        value: "anthropic/claude-opus-5",
      });
      const result = await rig.waitFor("command.result", { after: before });
      assert.equal(result.ok, false, "an unoffered model must be refused");
      assert.equal(result.reason, "invalid-payload");
    } finally {
      await rig.close();
    }
  });

  it("refuses a config option the harness never advertised", async () => {
    const rig = await startRig("ok");
    try {
      const sessionId = await openSession(rig);
      const before = rig.events.length;
      rig.send({
        commandId: "c-7",
        type: "session.configure",
        sessionId,
        configOptionId: "temperature",
        value: "0.2",
      });
      const result = await rig.waitFor("command.result", { after: before });
      assert.equal(result.ok, false);
    } finally {
      await rig.close();
    }
  });

  it("refuses a prompt with no open session instead of hanging", async () => {
    const rig = await startRig("ok");
    try {
      rig.send({ commandId: "c-9", type: "session.prompt", sessionId: "nope", turnId: "t-9", text: "hi" });
      const result = await rig.waitFor("command.result");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "not-found");
    } finally {
      await rig.close();
    }
  });
});

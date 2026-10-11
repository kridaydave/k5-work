// The docx tool, as the harness sees it. The spec is built by the seat and
// handed to `session/new` and `session/resume`; this test asserts what the
// fake agent actually received on the wire, recorded to a file by the fake
// itself. A unit assertion on the built spec would miss every step between
// building it and the harness putting it in a request.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAccessProfile,
  type ResolvedPostureReport,
} from "@k5-work/shared";
import { spawnAcpChild, type AcpChild } from "./spawn.js";
import { AcpSeat } from "./acp-seat.js";
import { docxToolSpec } from "../tools/docx-mcp-spec.js";
import { reportPosture } from "./posture.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.js", import.meta.url));

const POSTURE: ResolvedPostureReport = reportPosture({
  allowedTools: ["edit"],
  wildcardAllow: false,
  ruleCount: 1,
  grants: [{ permission: "edit", pattern: "**" }],
});

interface Recorded {
  method: string;
  mcpServers: unknown;
}

function recordedLines(file: string): Recorded[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Recorded);
}

function recordedFor(file: string, method: string): Recorded[] {
  return recordedLines(file).filter((entry) => entry.method === method);
}

async function withSeat(
  fn: (context: {
    cwd: string;
    record: string;
    seat: AcpSeat;
    child: AcpChild;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "k5-docx-seat-"));
  const record = path.join(root, "wire.jsonl");
  writeFileSync(record, "");
  const child = await spawnAcpChild({
    argv: [process.execPath, FAKE_AGENT, "ok"],
    cwd: root,
    env: { ...process.env, K5_FAKE_AGENT_RECORD: record },
  });
  const profile = resolveAccessProfile("full");
  const spec = docxToolSpec({ projectRoot: root, profile: profile.label, posture: POSTURE });
  assert.notEqual(spec, null);
  const seat = await AcpSeat.open(
    child,
    {
      cwd: root,
      // The posture the runner resolved permits writes, so the seat offers the
      // tool; the spec is the same object both the new and the resume path
      // carry.
      mcpServers: spec === null ? [] : [spec],
    },
    null,
  );
  try {
    await fn({ cwd: root, record, seat, child });
  } finally {
    await seat.close().catch(() => {});
    await child.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

test("session/new carries the docx MCP spec the harness will spawn", () =>
  withSeat(async ({ cwd, record }) => {
    const created = recordedFor(record, "session/new");
    assert.equal(created.length, 1, "the session was created once");
    const servers = created[0].mcpServers as {
      type: string;
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    }[];
    assert.equal(servers.length, 1);
    const [server] = servers;
    assert.equal(server.type, "stdio");
    assert.equal(server.name, "k5-docx");
    assert.equal(server.command, process.execPath);
    assert.ok(server.args[0].endsWith("docx-mcp.js"));
    // The project root the harness was opened under, not this test's cwd:
    // the write root is the seat's own.
    assert.equal(
      server.env.find((entry) => entry.name === "K5_DOCX_PROJECT_ROOT")?.value,
      cwd,
    );
    assert.equal(
      server.env.find((entry) => entry.name === "K5_DOCX_PROFILE")?.value,
      "full",
    );
    assert.deepEqual(
      JSON.parse(server.env.find((entry) => entry.name === "K5_DOCX_POSTURE")?.value ?? "null"),
      POSTURE,
    );
  }));

test("session/resume carries the same spec, so an adopted session keeps the tool", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "k5-docx-seat-"));
  const record = path.join(root, "wire.jsonl");
  writeFileSync(record, "");
  const child = await spawnAcpChild({
    argv: [process.execPath, FAKE_AGENT, "ok"],
    cwd: root,
    env: { ...process.env, K5_FAKE_AGENT_RECORD: record },
  });
  const profile = resolveAccessProfile("full");
  const spec = docxToolSpec({ projectRoot: root, profile: profile.label, posture: POSTURE });
  assert.notEqual(spec, null);
  // Headless: the continuation path is exactly the one a live session's
  // resume takes, and a seat that already created a session cannot adopt
  // another.
  const seat = await AcpSeat.openHeadless(
    child,
    { cwd: root, mcpServers: spec === null ? [] : [spec] },
    null,
  );
  try {
    // The fake knows this session id under any cwd.
    await seat.adopt("fake-session-1");
    const resumed = recordedFor(record, "session/resume");
    assert.equal(resumed.length, 1, "the session was adopted once");
    const servers = resumed[0].mcpServers as { name: string; command: string }[];
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, "k5-docx");
    assert.equal(servers[0].command, process.execPath);
  } finally {
    await seat.close().catch(() => {});
    await child.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

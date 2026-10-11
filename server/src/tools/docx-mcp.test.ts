// The child, exercised over a real stdio pipe. Nothing here mocks the
// transport: a real process is spawned, real JSON-RPC lines cross a real
// pipe, and the assertions check the bytes on disk and the refusal the
// harness would read. A tool that only works when its transport is faked is
// a tool that has not been tested.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCX_TOOL_ENV, DOCX_TOOL_RATE_LIMIT, type DocxDocument, type ResolvedPostureReport } from "@k5-work/shared";
import { buildDocx } from "../docx/driver.js";

const CHILD = fileURLToPath(new URL("./docx-mcp.js", import.meta.url));

const DOCUMENT: DocxDocument = {
  title: "Over the wire",
  blocks: [{ type: "paragraph", style: "normal", runs: [{ text: "spoken MCP", marks: [] }] }],
};

const POSTURE: ResolvedPostureReport = {
  verified: true,
  allowedTools: ["edit"],
  wildcardAllow: false,
  ruleCount: 1,
  grants: [{ permission: "edit", pattern: "**" }],
};

/** A JSON-RPC line client over one child's stdio. */
class McpPipe {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, (value: JsonRpcMessage) => void>();
  private buffer = "";
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe"], env });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    this.child.stdin?.write(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} never answered`)), 15_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Attaches the line reader. Call once, before the first request. */
  listen(): void {
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (line === "") continue;
        const message = JSON.parse(line) as JsonRpcMessage;
        const settle = this.pending.get(message.id as number);
        if (settle !== undefined) {
          this.pending.delete(message.id as number);
          settle(message);
        }
      }
    });
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.killed) return resolve();
      this.child.once("exit", () => resolve());
      // A child that ignores stdin EOF is killed by its captured pid, never
      // by a name match: this test spawned it, so it owns it.
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
      }, 5_000);
      this.child.once("exit", () => clearTimeout(timer));
    });
  }
}

interface JsonRpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function toolEnv(root: string): NodeJS.ProcessEnv {
  return {
    [DOCX_TOOL_ENV.projectRoot]: root,
    [DOCX_TOOL_ENV.profile]: "full",
    [DOCX_TOOL_ENV.posture]: JSON.stringify(POSTURE),
  };
}

async function handshake(pipe: McpPipe): Promise<void> {
  await pipe.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "k5-test", version: "0.0.0" },
  });
  pipe.notify("notifications/initialized");
}

test("the tool is listed and writes real bytes over stdio", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "k5-docx-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pipe = new McpPipe(toolEnv(root));
  t.after(() => pipe.close());
  pipe.listen();
  await handshake(pipe);

  const listed = await pipe.request("tools/list", {});
  const tools = (listed.result?.tools ?? []) as { name: string }[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["create_docx"],
  );

  const called = await pipe.request("tools/call", {
    name: "create_docx",
    arguments: { filename: "notes.docx", document: DOCUMENT },
  });
  assert.equal(called.error, undefined);
  const result = called.result ?? {};
  assert.notEqual(result.isError, true, JSON.stringify(result));
  // The structured result the harness acts on: where the file is and that
  // this call, not a repeat, wrote it.
  assert.deepEqual(result.structuredContent, {
    path: "notes.docx",
    byteLength: buildDocx(DOCUMENT).byteLength,
    reused: false,
  });
  // The bytes on disk are the engine's, not a buffer the test wrote itself.
  assert.deepEqual(readFileSync(path.join(root, "notes.docx")), Buffer.from(buildDocx(DOCUMENT)));
});

test("a traversal filename is an MCP error the harness can read", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "k5-docx-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pipe = new McpPipe(toolEnv(root));
  t.after(() => pipe.close());
  pipe.listen();
  await handshake(pipe);

  const called = await pipe.request("tools/call", {
    name: "create_docx",
    arguments: { filename: "../escape.docx", document: DOCUMENT },
  });
  const result = called.result ?? {};
  assert.equal(result.isError, true);
  const text = ((result.content ?? []) as { text?: string }[])[0]?.text ?? "";
  assert.match(text, /path, not a filename/);
  // The refusal is only real if nothing landed outside the project root.
  assert.equal(existsSync(path.join(path.dirname(root), "escape.docx")), false);
});

test("the served path counts calls: the 21st in one window is refused", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "k5-docx-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pipe = new McpPipe(toolEnv(root));
  t.after(() => pipe.close());
  pipe.listen();
  await handshake(pipe);

  // The gate's rate limit is 20 calls per 10 seconds, and the counter lives
  // in the child for the life of the process. A gate that defaulted to a
  // fresh counter per call would serve all 21 — this is the test that
  // distinguishes them. The same filename repeats, so calls 2..20 are
  // served as reuses: a repeat is still a call, and it still counts.
  for (let i = 1; i <= DOCX_TOOL_RATE_LIMIT; i += 1) {
    const served = await pipe.request("tools/call", {
      name: "create_docx",
      arguments: { filename: "notes.docx", document: DOCUMENT },
    });
    assert.notEqual(served.result?.isError, true, `call ${String(i)} must be served`);
  }
  // One past the window's limit: the counter lives in the child, so this
  // call is the 21st the process has admitted.
  const refused = await pipe.request("tools/call", {
    name: "create_docx",
    arguments: { filename: "notes.docx", document: DOCUMENT },
  });
  const result = refused.result ?? {};
  assert.equal(result.isError, true, "the 21st call must be refused");
  const text = ((result.content ?? []) as { text?: string }[])[0]?.text ?? "";
  assert.match(text, /capped at 20 calls per 10000 ms/);
  // The served file is intact after the burst.
  assert.deepEqual(readFileSync(path.join(root, "notes.docx")), Buffer.from(buildDocx(DOCUMENT)));
});

test("a child with no posture dies loudly instead of guessing", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "k5-docx-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CHILD], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { [DOCX_TOOL_ENV.projectRoot]: root, [DOCX_TOOL_ENV.profile]: "full" },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  assert.notEqual(exit, 0, "a tool that cannot state its policy must not look healthy");
  assert.match(stderr, /posture/);
});

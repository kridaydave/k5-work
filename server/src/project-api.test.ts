import { createServer, request } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROJECT_BODY_BYTES,
  handleProjectApiRequest,
  readJsonBody,
} from "./project-api.js";

async function withApiServer(
  workspaceRoot: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    handleProjectApiRequest(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    }, workspaceRoot);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postChunked(
  url: string,
  chunks: readonly Uint8Array[],
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        const body: Buffer[] = [];
        response.on("data", (chunk: Buffer) => body.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(body).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end();
  });
}

describe("project API boundary", () => {
  it("enforces JSON, body, route, and path limits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "k5-project-api-test-"));
    try {
      const project = path.join(root, "project");
      fs.mkdirSync(project);
      await withApiServer(root, async (baseUrl) => {
        const list = await fetch(`${baseUrl}/api/projects`);
        assert.equal(list.status, 200);
        const listBody = (await list.json()) as { projects?: unknown };
        assert.ok(Array.isArray(listBody.projects));

        const valid = await fetch(`${baseUrl}/api/projects/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: project }),
        });
        assert.equal(valid.status, 200);
        assert.match(valid.headers.get("content-type") ?? "", /^application\/json/);

        const malformed = await fetch(`${baseUrl}/api/projects/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        });
        assert.equal(malformed.status, 400);

        const wrongType = await fetch(`${baseUrl}/api/projects/open`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ path: project }),
        });
        assert.equal(wrongType.status, 415);

        const oversized = await fetch(`${baseUrl}/api/projects/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.alloc(MAX_PROJECT_BODY_BYTES + 1, 0x20),
        });
        assert.equal(oversized.status, 413);

        const chunked = await postChunked(`${baseUrl}/api/projects/open`, [
          Buffer.alloc(MAX_PROJECT_BODY_BYTES + 1, 0x20),
        ]);
        assert.equal(chunked.status, 413);

        const extraKey = await fetch(`${baseUrl}/api/projects/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: project, extra: true }),
        });
        assert.equal(extraKey.status, 400);

        const queryRoute = await fetch(`${baseUrl}/api/projects/open?x=1`);
        assert.equal(queryRoute.status, 405);
        assert.match(queryRoute.headers.get("content-type") ?? "", /^application\/json/);

        const unknownRoute = await fetch(`${baseUrl}/api/projects/unknown`);
        assert.equal(unknownRoute.status, 404);
        assert.match(unknownRoute.headers.get("content-type") ?? "", /^application\/json/);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds streaming bodies and stalled requests", async () => {
    const streamed = Readable.from([Buffer.alloc(MAX_PROJECT_BODY_BYTES + 1, 0x20)]);
    assert.deepEqual(await readJsonBody(streamed), {
      ok: false,
      reason: "too_large",
    });

    const stalled = new Readable({ read() {} });
    assert.deepEqual(await readJsonBody(stalled, MAX_PROJECT_BODY_BYTES, 20), {
      ok: false,
      reason: "timeout",
    });
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { createPptx, FixedWindow } from "./create-pptx.js";

test("creates a pptx file", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "k5-pptx-tool-"));
  const outcome = await createPptx(
    { filename: "deck.pptx", presentation: { slides: [{ title: "Hi" }] } },
    { projectRoot: root, posturePermitsWrites: true, postureVerified: true, rateLimit: 20, rateWindowMs: 10000 },
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.reused, false);
    assert.ok((await fsp.stat(path.join(root, "deck.pptx"))).isFile());
  }
  await fsp.rm(root, { recursive: true, force: true });
});

test("refuses unsafe filename", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "k5-pptx-tool-"));
  const outcome = await createPptx(
    { filename: "../x.pptx", presentation: { slides: [{ title: "Hi" }] } },
    { projectRoot: root, posturePermitsWrites: true, postureVerified: true, rateLimit: 20, rateWindowMs: 10000 },
  );
  assert.equal(outcome.ok, false);
  await fsp.rm(root, { recursive: true, force: true });
});

test("FixedWindow admits up to limit", () => {
  const w = new FixedWindow(2, 10000);
  assert.equal(w.admit(), true);
  assert.equal(w.admit(), true);
  assert.equal(w.admit(), false);
});

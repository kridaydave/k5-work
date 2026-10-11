// The gate, exercised against a real directory. Every refusal here is
// behavioral: the test states the input, then checks the disk for what did
// or did not land. A refusal is only proven by the absence of the write.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  posturePermitsWrites,
  type DocxDocument,
  type ResolvedPostureReport,
} from "@k5-work/shared";
import { createDocx, type DocxToolLimits } from "./create-docx.js";
import { buildDocx } from "../docx/driver.js";

function posture(overrides: Partial<ResolvedPostureReport> = {}): ResolvedPostureReport {
  const base: ResolvedPostureReport = {
    verified: true,
    allowedTools: ["edit"],
    wildcardAllow: false,
    ruleCount: 1,
    grants: [{ permission: "edit", pattern: "**" }],
  };
  return { ...base, ...overrides };
}

function limits(root: string, overrides: Partial<DocxToolLimits> = {}): DocxToolLimits {
  const resolved = posture();
  return {
    projectRoot: root,
    posturePermitsWrites: posturePermitsWrites(resolved),
    postureVerified: resolved.verified,
    rateLimit: 20,
    rateWindowMs: 10_000,
    ...overrides,
  };
}

const DOCUMENT: DocxDocument = {
  title: "Field notes",
  blocks: [
    { type: "heading", level: 1, runs: [{ text: "Field notes", marks: [] }] },
    { type: "paragraph", style: "normal", runs: [{ text: "The gate ran against a real directory.", marks: [] }] },
  ],
};

function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "k5-docx-gate-"));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("writes a real .docx and reports what it wrote", () =>
  withRoot(async (root) => {
    const outcome = await createDocx({ filename: "notes.docx", document: DOCUMENT }, limits(root));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.path, "notes.docx");
    assert.equal(outcome.result.reused, false);

    const onDisk = readFileSync(path.join(root, "notes.docx"));
    // Evidence the engine ran, not that a buffer was written: the bytes are
    // the engine's own, and a .docx is a ZIP, so it starts with the magic.
    assert.deepEqual(onDisk, Buffer.from(buildDocx(DOCUMENT)));
    assert.equal(onDisk.subarray(0, 2).toString("latin1"), "PK");
    assert.equal(outcome.result.byteLength, onDisk.byteLength);
  }));

test("a repeat call reuses the file and leaves the disk alone", () =>
  withRoot(async (root) => {
    const target = path.join(root, "notes.docx");
    const first = await createDocx({ filename: "notes.docx", document: DOCUMENT }, limits(root));
    assert.equal(first.ok, true);
    const before = readFileSync(target);

    const second = await createDocx({ filename: "notes.docx", document: DOCUMENT }, limits(root));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.result.reused, true);
    assert.deepEqual(readFileSync(target), before);
  }));

test("refuses a filename that is not one safe segment", () =>
  withRoot(async (root) => {
    for (const filename of ["../escape.docx", "nested/dir.docx", ".hidden.docx"]) {
      const outcome = await createDocx({ filename, document: DOCUMENT }, limits(root));
      assert.equal(outcome.ok, false, `${filename} must be refused`);
      if (outcome.ok) return;
      assert.equal(outcome.code, "unsafe-filename");
    }
    assert.equal(existsSync(path.join(path.dirname(root), "escape.docx")), false);
  }));

test("refuses arguments that are not a document", () =>
  withRoot(async (root) => {
    const bad: unknown[] = [
      { filename: "notes.txt", document: DOCUMENT },
      { filename: "notes.docx", document: { ...DOCUMENT, blocks: [] } },
      { filename: "notes.docx", document: { ...DOCUMENT, extra: true } },
      { document: DOCUMENT },
    ];
    for (const args of bad) {
      const outcome = await createDocx(args, limits(root));
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.code, "invalid-arguments");
    }
    assert.equal(existsSync(path.join(root, "notes.docx")), false);
  }));

test("a posture with no file-write permission closes the tool", () =>
  withRoot(async (root) => {
    const readOnly = posture({ allowedTools: ["read"], wildcardAllow: false });
    assert.equal(posturePermitsWrites(readOnly), false);
    const outcome = await createDocx(
      { filename: "notes.docx", document: DOCUMENT },
      limits(root, {
        posturePermitsWrites: posturePermitsWrites(readOnly),
      }),
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, "posture-refused");
    assert.equal(existsSync(path.join(root, "notes.docx")), false);
  }));

test("a zero rate limit refuses before anything is written", () =>
  withRoot(async (root) => {
    const outcome = await createDocx(
      { filename: "notes.docx", document: DOCUMENT },
      limits(root, { rateLimit: 0 }),
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, "rate-limited");
    assert.equal(existsSync(path.join(root, "notes.docx")), false);
  }));

test("never overwrites a file this tool did not write", () =>
  withRoot(async (root) => {
    const target = path.join(root, "notes.docx");
    writeFileSync(target, "someone else's document");
    const outcome = await createDocx({ filename: "notes.docx", document: DOCUMENT }, limits(root));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, "file-exists");
    assert.equal(readFileSync(target).toString("utf8"), "someone else's document");
  }));

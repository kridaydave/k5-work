import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  xlsxPosturePermitsWrites,
  type ResolvedPostureReport,
  type XlsxWorkbook,
} from "@k5-work/shared";
import { createXlsx, type XlsxToolLimits } from "./create-xlsx.js";
import { buildXlsx } from "../xlsx/driver.js";

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

function limits(root: string): XlsxToolLimits {
  const resolved = posture();
  return {
    projectRoot: root,
    posturePermitsWrites: xlsxPosturePermitsWrites(resolved),
    postureVerified: resolved.verified,
    rateLimit: 20,
    rateWindowMs: 10000,
  };
}

const WORKBOOK: XlsxWorkbook = {
  title: "Sheet",
  sheets: [{ name: "Sheet1", rows: [[{ value: "hello" }], [{ value: 42 }]] }],
};

function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "k5-xlsx-gate-"));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("writes a real .xlsx and reports what it wrote", () =>
  withRoot(async (root) => {
    const outcome = await createXlsx({ filename: "book.xlsx", workbook: WORKBOOK }, limits(root));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.path, "book.xlsx");
    assert.equal(outcome.result.reused, false);
    const onDisk = readFileSync(path.join(root, "book.xlsx"));
    assert.deepEqual(onDisk, Buffer.from(buildXlsx(WORKBOOK)));
    assert.equal(onDisk.subarray(0, 2).toString("latin1"), "PK");
  }));
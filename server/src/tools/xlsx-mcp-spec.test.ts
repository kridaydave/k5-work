import test from "node:test";
import assert from "node:assert/strict";
import {
  XLSX_TOOL_ENV,
  xlsxPosturePermitsWrites,
  type ResolvedPostureReport,
} from "@k5-work/shared";
import { XLSX_MCP_SERVER_NAME, xlsxToolSpec } from "./xlsx-mcp-spec.js";

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

test("a posture with write permission produces a stdio spawn spec", () => {
  const report = posture();
  const spec = xlsxToolSpec({ projectRoot: "/repo", profile: "full", posture: report });
  assert.notEqual(spec, null);
  if (spec === null) return;
  assert.equal(spec.type, "stdio");
  assert.equal(spec.name, XLSX_MCP_SERVER_NAME);
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args?.length, 1);
  assert.ok(spec.args?.[0].endsWith("xlsx-mcp.js"), `entry was ${spec.args?.[0]}`);

  const env = new Map((spec.env ?? []).map((entry) => [entry.name, entry.value]));
  assert.equal(env.get(XLSX_TOOL_ENV.projectRoot), "/repo");
  assert.equal(env.get(XLSX_TOOL_ENV.profile), "full");
  assert.deepEqual(JSON.parse(env.get(XLSX_TOOL_ENV.posture) ?? "null"), report);
});

test("a posture with no write permission offers nothing", () => {
  const readOnly = posture({ allowedTools: ["read"], wildcardAllow: false });
  assert.equal(xlsxPosturePermitsWrites(readOnly), false);
  assert.equal(xlsxToolSpec({ projectRoot: "/repo", profile: "read", posture: readOnly }), null);
});
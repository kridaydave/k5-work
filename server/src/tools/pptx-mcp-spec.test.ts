import test from "node:test";
import assert from "node:assert/strict";
import { PPTX_TOOL_ENV, pptxPosturePermitsWrites, type ResolvedPostureReport } from "@k5-work/shared";
import { PPTX_MCP_SERVER_NAME, pptxToolSpec } from "./pptx-mcp-spec.js";

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
  const spec = pptxToolSpec({ projectRoot: "/repo", profile: "full", posture: report });
  assert.notEqual(spec, null);
  if (spec === null) return;
  assert.equal(spec.type, "stdio");
  assert.equal(spec.name, PPTX_MCP_SERVER_NAME);
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args?.length, 1);
  assert.ok(spec.args?.[0].endsWith("pptx-mcp.js"));
});

test("a posture with no write permission offers nothing", () => {
  const readOnly = posture({ allowedTools: ["read"], wildcardAllow: false });
  assert.equal(pptxPosturePermitsWrites(readOnly), false);
  assert.equal(pptxToolSpec({ projectRoot: "/repo", profile: "read", posture: readOnly }), null);
});

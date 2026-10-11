// The parent-side decision, tested as policy: when the tool is offered,
// what the spec says, and what the child will be handed.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCX_TOOL_ENV,
  posturePermitsWrites,
  type ResolvedPostureReport,
} from "@k5-work/shared";
import { DOCX_MCP_SERVER_NAME, docxToolSpec } from "./docx-mcp-spec.js";

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
  const spec = docxToolSpec({ projectRoot: "/repo", profile: "full", posture: report });
  assert.notEqual(spec, null);
  if (spec === null) return;
  assert.equal(spec.type, "stdio");
  assert.equal(spec.name, DOCX_MCP_SERVER_NAME);
  // The parent's own node and a sibling module: the harness must not depend
  // on how the server was started, and there is no second runtime to install.
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args?.length, 1);
  assert.ok(spec.args?.[0].endsWith("docx-mcp.js"), `entry was ${spec.args?.[0]}`);

  const env = new Map((spec.env ?? []).map((entry) => [entry.name, entry.value]));
  assert.equal(env.get(DOCX_TOOL_ENV.projectRoot), "/repo");
  assert.equal(env.get(DOCX_TOOL_ENV.profile), "full");
  // The posture arrives as JSON the child parses with the shared schema, so
  // the value must survive the round trip exactly.
  assert.deepEqual(JSON.parse(env.get(DOCX_TOOL_ENV.posture) ?? "null"), report);
});

test("a posture with no write permission offers nothing", () => {
  const readOnly = posture({ allowedTools: ["read"], wildcardAllow: false });
  assert.equal(posturePermitsWrites(readOnly), false);
  assert.equal(docxToolSpec({ projectRoot: "/repo", profile: "read", posture: readOnly }), null);
});

test("a wildcard posture is a write posture, verified or not", () => {
  for (const verified of [true, false]) {
    const report = posture({ wildcardAllow: true, ruleCount: verified ? 3 : 0, verified });
    const spec = docxToolSpec({ projectRoot: "/repo", profile: "full", posture: report });
    assert.notEqual(spec, null);
    if (spec === null) return;
    const env = new Map((spec.env ?? []).map((entry) => [entry.name, entry.value]));
    // The child reads `verified` only to say whether the posture it enforced
    // was observed or assumed, so the flag must reach it untouched.
    assert.equal(
      (JSON.parse(env.get(DOCX_TOOL_ENV.posture) ?? "null") as ResolvedPostureReport).verified,
      verified,
    );
  }
});

// The parent side of the docx tool: what a seat hands its harness.
//
// The tool itself lives in `docx-mcp.ts`, a separate process the harness
// spawns from the spec this file builds. This module owns one decision —
// whether the tool is offered at all — and produces the `McpServerStdio`
// spawn spec when it is. It is pure: no process is started, no port opened,
// so the policy it states can be tested without a harness in the loop.
//
// The gate it applies is the same one the child enforces, via the shared
// `posturePermitsWrites`. It is checked here so a harness whose posture
// grants no file-write permission never sees the tool at all, and again in
// the child because the environment the harness hands the child is the
// harness's to shape and the child must not trust what it is told about
// itself. Two independent checks of the same fact is not duplication; it is
// the difference between "not offered" and "cannot succeed".

import {
  DOCX_TOOL_ENV,
  posturePermitsWrites,
  type DocxToolProfile,
  type ResolvedPostureReport,
} from "@k5-work/shared";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";

/** The name the harness sees this MCP server under. */
export const DOCX_MCP_SERVER_NAME = "k5-docx";

export interface DocxToolSpecInput {
  /** Absolute path of the project the session is open in. The write root. */
  readonly projectRoot: string;
  /** The access profile the seat was opened under, as a label. */
  readonly profile: DocxToolProfile;
  /** The resolved posture, in report form, `verified` included. */
  readonly posture: ResolvedPostureReport;
}

/**
 * The spawn spec for the docx MCP child, or null when the tool is closed.
 *
 * Null is the honest answer when the posture permits no writes: the harness
 * cannot use the tool, so offering it would only produce a refusal the
 * harness would have to interpret as a fault. The child still re-checks the
 * posture from its own environment — see the file header.
 */
export function docxToolSpec(input: DocxToolSpecInput): (McpServerStdio & { type: "stdio" }) | null {
  if (!posturePermitsWrites(input.posture)) return null;
  return {
    type: "stdio",
    name: DOCX_MCP_SERVER_NAME,
    // The server's own node: the child is a sibling module of this one, so
    // it needs no runtime the parent does not already have, and the harness
    // spawning it must not depend on how the parent was started.
    command: process.execPath,
    args: [docxMcpEntry()],
    env: [
      { name: DOCX_TOOL_ENV.projectRoot, value: input.projectRoot },
      { name: DOCX_TOOL_ENV.profile, value: input.profile },
      { name: DOCX_TOOL_ENV.posture, value: JSON.stringify(input.posture) },
    ],
  };
}

/**
 * Absolute path of the child entry, resolved against this module.
 *
 * `import.meta.url` rather than a relative string: this module is compiled
 * with the rest of the server, so the child lands beside it in `dist/tools/`
 * and the URL survives both the dev tree and the built one.
 */
function docxMcpEntry(): string {
  return fileURLToPath(new URL("./docx-mcp.js", import.meta.url));
}

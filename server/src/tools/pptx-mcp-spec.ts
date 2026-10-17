import {
  PPTX_TOOL_ENV,
  pptxPosturePermitsWrites,
  type ResolvedPostureReport,
} from "@k5-work/shared";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";

export const PPTX_MCP_SERVER_NAME = "k5-pptx";

export interface PptxToolSpecInput {
  readonly projectRoot: string;
  readonly profile: string;
  readonly posture: ResolvedPostureReport;
}

export function pptxToolSpec(input: PptxToolSpecInput): (McpServerStdio & { type: "stdio" }) | null {
  if (!pptxPosturePermitsWrites(input.posture)) return null;
  return {
    type: "stdio",
    name: PPTX_MCP_SERVER_NAME,
    command: process.execPath,
    args: [pptxMcpEntry()],
    env: [
      { name: PPTX_TOOL_ENV.projectRoot, value: input.projectRoot },
      { name: PPTX_TOOL_ENV.profile, value: input.profile },
      { name: PPTX_TOOL_ENV.posture, value: JSON.stringify(input.posture) },
    ],
  };
}

function pptxMcpEntry(): string {
  return fileURLToPath(new URL("./pptx-mcp.js", import.meta.url));
}

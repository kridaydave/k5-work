import {
  XLSX_TOOL_ENV,
  xlsxPosturePermitsWrites,
  type ResolvedPostureReport,
} from "@k5-work/shared";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";

export const XLSX_MCP_SERVER_NAME = "k5-xlsx";

export interface XlsxToolSpecInput {
  readonly projectRoot: string;
  readonly profile: string;
  readonly posture: ResolvedPostureReport;
}

export function xlsxToolSpec(input: XlsxToolSpecInput): (McpServerStdio & { type: "stdio" }) | null {
  if (!xlsxPosturePermitsWrites(input.posture)) return null;
  return {
    type: "stdio",
    name: XLSX_MCP_SERVER_NAME,
    command: process.execPath,
    args: [xlsxMcpEntry()],
    env: [
      { name: XLSX_TOOL_ENV.projectRoot, value: input.projectRoot },
      { name: XLSX_TOOL_ENV.profile, value: input.profile },
      { name: XLSX_TOOL_ENV.posture, value: JSON.stringify(input.posture) },
    ],
  };
}

function xlsxMcpEntry(): string {
  return fileURLToPath(new URL("./xlsx-mcp.js", import.meta.url));
}
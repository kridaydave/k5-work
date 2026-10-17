import {
  CREATE_XLSX_TOOL,
  CreateXlsxArgsSchema,
  CreateXlsxResultSchema,
  XLSX_TOOL_ENV,
  XLSX_TOOL_RATE_LIMIT,
  XLSX_TOOL_RATE_WINDOW_MS,
  XlsxToolRuntimeSchema,
  xlsxPosturePermitsWrites,
  type CreateXlsxArgs,
  type XlsxToolRuntime,
} from "@k5-work/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createXlsx, FixedWindow } from "./create-xlsx.js";

export function parseToolRuntime(env: NodeJS.ProcessEnv): XlsxToolRuntime {
  const postureJson = env[XLSX_TOOL_ENV.posture];
  const posture = postureJson === undefined ? undefined : (JSON.parse(postureJson) as unknown);
  return XlsxToolRuntimeSchema.parse({
    projectRoot: env[XLSX_TOOL_ENV.projectRoot],
    profile: env[XLSX_TOOL_ENV.profile],
    posture,
  });
}

export function createXlsxToolServer(runtime: XlsxToolRuntime): McpServer {
  const server = new McpServer(
    { name: "k5-xlsx", version: "0.1.0" },
    { instructions: "create_xlsx writes one .xlsx from a JSON workbook model into the project root." },
  );
  const window = new FixedWindow(XLSX_TOOL_RATE_LIMIT, XLSX_TOOL_RATE_WINDOW_MS);
  server.registerTool(
    CREATE_XLSX_TOOL,
    {
      title: "Create a spreadsheet",
      description: "Write an .xlsx from a JSON workbook model (sheets, rows, cells) into the project root.",
      inputSchema: CreateXlsxArgsSchema,
      outputSchema: CreateXlsxResultSchema,
    },
    async (args: CreateXlsxArgs) => {
      const outcome = await createXlsx(
        args,
        {
          projectRoot: runtime.projectRoot,
          posturePermitsWrites: xlsxPosturePermitsWrites(runtime.posture),
          postureVerified: runtime.posture.verified,
          rateLimit: XLSX_TOOL_RATE_LIMIT,
          rateWindowMs: XLSX_TOOL_RATE_WINDOW_MS,
        },
        window,
      );
      if (!outcome.ok) {
        return { isError: true, content: [{ type: "text" as const, text: outcome.message }] };
      }
      return {
        content: [{ type: "text" as const, text: `${outcome.result.reused ? "reused" : "wrote"} ${outcome.result.path}` }],
        structuredContent: outcome.result,
      };
    },
  );
  return server;
}

export async function runXlsxMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = parseToolRuntime(env);
  const server = createXlsxToolServer(runtime);
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runXlsxMcpServer().catch((err: unknown) => {
    process.stderr.write(`k5-xlsx: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
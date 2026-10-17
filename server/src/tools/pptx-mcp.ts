import {
  CREATE_PPTX_TOOL,
  CreatePptxArgsSchema,
  CreatePptxResultSchema,
  PPTX_TOOL_ENV,
  PPTX_TOOL_RATE_LIMIT,
  PPTX_TOOL_RATE_WINDOW_MS,
  PptxToolRuntimeSchema,
  pptxPosturePermitsWrites,
  type CreatePptxArgs,
  type PptxToolRuntime,
} from "@k5-work/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPptx, FixedWindow } from "./create-pptx.js";

export function parseToolRuntime(env: NodeJS.ProcessEnv): PptxToolRuntime {
  const postureJson = env[PPTX_TOOL_ENV.posture];
  const posture = postureJson === undefined ? undefined : (JSON.parse(postureJson) as unknown);
  return PptxToolRuntimeSchema.parse({
    projectRoot: env[PPTX_TOOL_ENV.projectRoot],
    profile: env[PPTX_TOOL_ENV.profile],
    posture,
  });
}

export function createPptxToolServer(runtime: PptxToolRuntime): McpServer {
  const server = new McpServer(
    { name: "k5-pptx", version: "0.1.0" },
    {
      instructions:
        "create_pptx writes one .pptx from a JSON presentation model into the " +
        "project root. It never overwrites a file it did not write.",
    },
  );
  const window = new FixedWindow(PPTX_TOOL_RATE_LIMIT, PPTX_TOOL_RATE_WINDOW_MS);
  server.registerTool(
    CREATE_PPTX_TOOL,
    {
      title: "Create a PowerPoint presentation",
      description:
        "Write a .pptx from a JSON presentation model (slides with title and text) into the project root. Refuses a name that is not a single safe segment and never overwrites an existing file this tool did not write.",
      inputSchema: CreatePptxArgsSchema,
      outputSchema: CreatePptxResultSchema,
    },
    async (args: CreatePptxArgs) => {
      const outcome = await createPptx(
        args,
        {
          projectRoot: runtime.projectRoot,
          posturePermitsWrites: pptxPosturePermitsWrites(runtime.posture),
          postureVerified: runtime.posture.verified,
          rateLimit: PPTX_TOOL_RATE_LIMIT,
          rateWindowMs: PPTX_TOOL_RATE_WINDOW_MS,
        },
        window,
      );
      if (!outcome.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: outcome.message }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `${outcome.result.reused ? "reused" : "wrote"} ${outcome.result.path}`,
          },
        ],
        structuredContent: outcome.result,
      };
    },
  );
  return server;
}

export async function runPptxMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = parseToolRuntime(env);
  const server = createPptxToolServer(runtime);
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runPptxMcpServer().catch((err: unknown) => {
    process.stderr.write(
      `k5-pptx: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

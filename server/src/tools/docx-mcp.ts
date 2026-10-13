// The one tool k5 offers a harness, as the child process that serves it.
//
// The harness spawns this program itself, from the spec
// `docx-mcp-spec.ts` builds, and speaks MCP over stdio. The transport lives
// here and nowhere else: `create-docx.ts` is the gate and stays
// transport-free, so the same gate serves any future caller without an MCP
// server in the middle of the policy.
//
// Everything the child knows about itself arrives through its environment:
// the parent and the child are separate processes with no shared memory, so
// a fact the child trusts must be parsed here with the shared schema rather
// than read as a raw string. A child that starts with a malformed or absent
// environment exits non-zero with the reason on stderr — the harness watches
// this process die, and a tool that cannot state its own policy must fail
// loudly rather than serve refusals it cannot justify.

import {
  CREATE_DOCX_TOOL,
  CreateDocxArgsSchema,
  CreateDocxResultSchema,
  DOCX_TOOL_ENV,
  DOCX_TOOL_RATE_LIMIT,
  DOCX_TOOL_RATE_WINDOW_MS,
  DocxToolRuntimeSchema,
  posturePermitsWrites,
  type CreateDocxArgs,
  type DocxToolRuntime,
} from "@k5-work/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDocx, FixedWindow } from "./create-docx.js";

/**
 * The child's configuration, parsed from its environment.
 *
 * The posture arrives as JSON and is parsed with the shared schema, so a
 * harness that hands this child a malformed posture gets a refusal at
 * startup rather than a gate reading whatever the JSON happened to contain.
 */
export function parseToolRuntime(env: NodeJS.ProcessEnv): DocxToolRuntime {
  const postureJson = env[DOCX_TOOL_ENV.posture];
  const posture = postureJson === undefined ? undefined : (JSON.parse(postureJson) as unknown);
  return DocxToolRuntimeSchema.parse({
    projectRoot: env[DOCX_TOOL_ENV.projectRoot],
    profile: env[DOCX_TOOL_ENV.profile],
    posture,
  });
}

/**
 * The MCP server: one registered tool, backed by the gate.
 *
 * The tool's refusal is an MCP error result, not an exception: a harness
 * calling a tool expects to read a structured failure it can act on (a name
 * collision, a traversal), and a JSON-RPC fault reads to it as a broken
 * tool. The success case returns the result shape from shared as structured
 * content, so the harness can act on `path` and `reused` without parsing
 * prose.
 */
export function createDocxToolServer(runtime: DocxToolRuntime): McpServer {
  const server = new McpServer(
    { name: "k5-docx", version: "0.1.0" },
    {
      instructions:
        "create_docx writes one .docx from a JSON document model into the " +
        "project root. It never overwrites a file it did not write.",
    },
  );
  // One window for the life of this process. The gate's default is a window
  // per call, which is only correct for a caller that calls once: this child
  // serves every call the harness makes to it, so the counter has to outlive
  // a single call or gate 4 never fires and a harness in a loop fills the
  // disk. The process is the session scope — see FixedWindow.
  const window = new FixedWindow(DOCX_TOOL_RATE_LIMIT, DOCX_TOOL_RATE_WINDOW_MS);
  server.registerTool(
    CREATE_DOCX_TOOL,
    {
      title: "Create a Word document",
      description:
        "Write a .docx from a JSON document model (paragraphs, headings, " +
        "tables, lists, page breaks) into the project root. Refuses a name " +
        "that is not a single safe segment and never overwrites an existing " +
        "file this tool did not write.",
      inputSchema: CreateDocxArgsSchema,
      outputSchema: CreateDocxResultSchema,
    },
    async (args: CreateDocxArgs) => {
      const outcome = await createDocx(
        args,
        {
          projectRoot: runtime.projectRoot,
          posturePermitsWrites: posturePermitsWrites(runtime.posture),
          postureVerified: runtime.posture.verified,
          rateLimit: DOCX_TOOL_RATE_LIMIT,
          rateWindowMs: DOCX_TOOL_RATE_WINDOW_MS,
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

/** Parses the environment and serves the tool until the harness closes stdio. */
export async function runDocxMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = parseToolRuntime(env);
  const server = createDocxToolServer(runtime);
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runDocxMcpServer().catch((err: unknown) => {
    // The harness spawns this process and watches it die. A tool that cannot
    // start must say why on stderr and exit non-zero, so the harness sees a
    // dead MCP server rather than one that answers everything with a refusal.
    process.stderr.write(
      `k5-docx: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

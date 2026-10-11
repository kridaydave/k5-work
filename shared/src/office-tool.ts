import { z } from "zod";
import { ComposerAccessLabelSchema, type ComposerAccessLabel } from "./access.js";
import { DocxDocumentSchema } from "./office.js";
import { ResolvedPostureSchema } from "./contracts.js";

// The contract for the one tool k5 offers a harness, and the contract for the
// child process that serves it.
//
// The tool is delivered over MCP stdio: the harness spawns this child itself,
// from a `McpServerStdio` spec the seat hands it at `session/new` and
// `session/resume`. That has a consequence the whole file is shaped around.
// The parent and the child are separate processes with no shared memory, so
// every fact the child needs to enforce a gate arrives as either an
// environment variable or a JSON-RPC argument. Both are payloads from another
// process, so both are parsed with Zod here rather than trusted.
//
// `OoxmlPackageSpec` is deliberately absent. A tool argument names a document,
// never a package: the moment parts and relationships are reachable from a
// tool call, JSON-in/engine-out is gone and the harness is assembling OOXML
// by hand.

/** The tool's name on the wire. Also the name the parent registers it under. */
export const CREATE_DOCX_TOOL = "create_docx";

/**
 * Where the child looks for its configuration.
 *
 * Prefixed and closed: an env namespace that is not spelled out is an env
 * namespace a future variable can silently join, and this child reads nothing
 * it was not given here.
 */
export const DOCX_TOOL_ENV = {
  /** Absolute path of the project the session is open in. The write root. */
  projectRoot: "K5_DOCX_PROJECT_ROOT",
  /** The access profile the seat was opened under, as a label. */
  profile: "K5_DOCX_PROFILE",
  /** The resolved posture, as JSON in `ResolvedPostureSchema` shape. */
  posture: "K5_DOCX_POSTURE",
} as const;

/**
 * Same shape as the `/ws` gateway's command cap: 20 calls per 10 seconds.
 *
 * Restated here rather than imported because the gateway is server-side code
 * and this file is shared, and the number is policy the tool states for itself.
 * The window is a fixed bucket, not a sliding one: the same choice the gateway
 * makes, for the same reason, which is that a burst that ends is not a burst
 * that is still happening.
 */
export const DOCX_TOOL_RATE_LIMIT = 20;
export const DOCX_TOOL_RATE_WINDOW_MS = 10_000;

/** Longest output filename, in characters. Bounds one path segment. */
export const MAX_DOCX_FILENAME_CHARS = 128;

/**
 * What the harness sends.
 *
 * `filename` is a single segment, not a path. The child resolves it under the
 * project root and refuses anything that is not one safe segment, so a
 * traversal in this field is a client error rather than a write outside the
 * project. The `.docx` suffix is required rather than appended: a tool that
 * silently renames its output produces a file the caller did not ask for.
 */
export const CreateDocxArgsSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(MAX_DOCX_FILENAME_CHARS)
      .regex(/\.docx$/i, "the filename must end in .docx"),
    document: DocxDocumentSchema,
  })
  .strict();
export type CreateDocxArgs = z.infer<typeof CreateDocxArgsSchema>;

/**
 * What the child reports back.
 *
 * `path` is relative to the project root, never absolute: the harness is
 * running with that root as its cwd, so a relative path is the one it can use,
 * and an absolute one would put this machine's directory layout into a
 * transcript that is stored and searched.
 */
export const CreateDocxResultSchema = z
  .object({
    path: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    /**
     * True when the call was a repeat of one already served and the existing
     * file was returned untouched. The tool is idempotent by construction
     * rather than by key: see `createDocx` in server/src/tools/create-docx.ts.
     */
    reused: z.boolean(),
  })
  .strict();
export type CreateDocxResult = z.infer<typeof CreateDocxResultSchema>;

/**
 * The child's configuration, parsed from its environment.
 *
 * `posture` is the full report form, `verified` included, because the parent
 * already has `reportPosture` to produce it and a second shape for the same
 * fact is a second thing to keep in step. The child gates on the grants, and
 * reads `verified` only to say in its audit line whether the posture it
 * enforced was observed or assumed.
 */
export const DocxToolRuntimeSchema = z
  .object({
    projectRoot: z.string().min(1),
    profile: ComposerAccessLabelSchema,
    posture: ResolvedPostureSchema,
  })
  .strict();
export type DocxToolRuntime = z.infer<typeof DocxToolRuntimeSchema>;

/**
 * Permissions that let a harness change a file, under either name the resolver
 * speaks. `edit` is the OpenCode 2.x name and `write` the older one, and a
 * posture resolved by an older harness still has to be readable.
 */
export const DOCX_WRITE_PERMISSIONS = ["edit", "write"] as const;

/**
 * Whether a resolved posture lets the harness write files at all.
 *
 * This is a coarse gate and deliberately so. It answers "may this harness
 * change anything on disk", which is the question that decides whether the
 * tool is offered; it does not try to match the output path against the grant
 * patterns, because the patterns are the harness's own and the harness is the
 * component that resolves them. Matching a glob here would be k5 inventing a
 * second resolver and claiming it agreed with the first.
 */
export function posturePermitsWrites(posture: DocxToolRuntime["posture"]): boolean {
  if (posture.wildcardAllow) return true;
  return posture.allowedTools.some((tool) =>
    (DOCX_WRITE_PERMISSIONS as readonly string[]).includes(tool),
  );
}

/** The access label the parent passes down, restated for the child. */
export type DocxToolProfile = ComposerAccessLabel;

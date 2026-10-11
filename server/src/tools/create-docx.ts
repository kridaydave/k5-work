// The one tool k5 offers a harness: a document in, a .docx on disk.
//
// This module is the gate, and it is deliberately not an MCP server. It takes
// parsed arguments and a parsed runtime and returns either a result or a
// refusal, so the same code serves the MCP child today and any other caller
// later without a transport in the middle of the policy.
//
// Four gates, in this order, because the order is what makes each one cheap:
//
//   1. arguments, by Zod. A bad document is a loud error naming the field,
//      never a .docx that opens wrong.
//   2. the filename, as one safe segment under the project root.
//   3. the posture, which decides whether this harness may write at all.
//   4. the rate, so a harness in a loop cannot fill the disk.
//
// Idempotency and non-destructiveness are the same rule here, not two: a call
// that repeats one already served returns the file it wrote and leaves the
// disk alone, and a call that would overwrite a file this tool did not write
// is refused rather than resolved. A create tool that silently clobbers a user's
// edits is a destructive action wearing a create tool's clothes.

import {
  CreateDocxArgsSchema,
  type CreateDocxResult,
} from "@k5-work/shared";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildDocx } from "../docx/driver.js";
import { unsafeNameReason } from "../store/safe-name.js";

/** Enough of a runtime to enforce every gate. Parsed by the caller. */
export interface DocxToolLimits {
  readonly projectRoot: string;
  readonly posturePermitsWrites: boolean;
  /** When false, the posture the gate read was assumed rather than observed. */
  readonly postureVerified: boolean;
  readonly rateLimit: number;
  readonly rateWindowMs: number;
}

export type DocxToolOutcome =
  | { ok: true; result: CreateDocxResult }
  | { ok: false; code: DocxToolRefusalCode; message: string };

export type DocxToolRefusalCode =
  | "invalid-arguments"
  | "unsafe-filename"
  | "posture-refused"
  | "rate-limited"
  | "file-exists"
  | "write-failed";

/**
 * Why an unsafe filename was refused, as a message a harness can act on.
 *
 * `unsafeNameReason` already names the hazard, so this only wraps it. The
 * separator check is separate and comes first, because that predicate is
 * written for single path segments and does not reject a slash: "../etc" is a
 * segment it considers safe.
 */
function refuseFilename(filename: string): string | null {
  // A separator is refused before the predicate runs, because `unsafeNameReason`
  // is written for a single path segment and does not reject a slash: taken
  // literally, "../etc" is a segment it considers safe.
  if (/[/\\]/.test(filename)) {
    return `"${filename}" is a path, not a filename; name one file in the project root`;
  }
  if (filename.startsWith(".")) {
    return `"${filename}" starts with a dot, which names a hidden file or a traversal`;
  }
  const reason = unsafeNameReason(filename);
  if (reason !== null) return `"${filename}" is not a safe filename (${reason})`;
  return null;
}

/**
 * A fixed-window counter, one per tool instance.
 *
 * Deliberately per process rather than per session id: the MCP child is
 * spawned by the harness for one seat and dies with it, so the process *is*
 * the session scope. Keying on an id would mean inventing one and then
 * believing it.
 *
 * Exported so a caller that serves many calls from one process can build
 * one window and hand it to every call. The default a lone call gets is a
 * window of its own, which is only correct for a caller that calls once.
 */
export class FixedWindow {
  private windowStart = Date.now();
  private accepted = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True when the call is inside the window, and counts it. */
  admit(): boolean {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.accepted = 0;
    }
    this.accepted += 1;
    return this.accepted <= this.limit;
  }
}

/**
 * Creates the document, or says precisely why it did not.
 *
 * The build runs before the existence check, not after. That is the honest
 * order for a deterministic writer: the bytes this call would write are the
 * only way to know whether the file on disk is the same document, so comparing
 * first would mean guessing and comparing nothing.
 */
export async function createDocx(
  args: unknown,
  limits: DocxToolLimits,
  window: FixedWindow = new FixedWindow(limits.rateLimit, limits.rateWindowMs),
): Promise<DocxToolOutcome> {
  const parsed = CreateDocxArgsSchema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.join(".") ?? "";
    return {
      ok: false,
      code: "invalid-arguments",
      message: `create_docx arguments were refused${at === "" ? "" : ` at ${at}`}: ${first?.message ?? "unknown"}`,
    };
  }

  const unsafe = refuseFilename(parsed.data.filename);
  if (unsafe !== null) return { ok: false, code: "unsafe-filename", message: unsafe };

  if (!limits.posturePermitsWrites) {
    return {
      ok: false,
      code: "posture-refused",
      message:
        "the harness's resolved posture grants no file-write permission, " +
        "so this tool is closed to it. Re-open the seat under a posture that " +
        `allows edit${limits.postureVerified ? "" : " (the posture was assumed, not observed)"}`,
    };
  }

  if (!window.admit()) {
    return {
      ok: false,
      code: "rate-limited",
      message: `create_docx is capped at ${String(limits.rateLimit)} calls per ${String(limits.rateWindowMs)} ms`,
    };
  }

  const root = path.resolve(limits.projectRoot);
  const target = path.resolve(root, parsed.data.filename);
  // Defence in depth, and the reason `refuseFilename` rejected a separator
  // first: a predicate plus a join is not proof that the join stayed inside.
  if (target !== path.join(root, parsed.data.filename)) {
    return {
      ok: false,
      code: "unsafe-filename",
      message: `"${parsed.data.filename}" does not resolve inside the project root`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = buildDocx(parsed.data.document);
  } catch (err) {
    // The engine's own refusals land here: a document that crosses an element
    // cap, or a package that fails a gate. They are client errors, so they are
    // reported as the invalid document they are rather than as a server fault.
    return {
      ok: false,
      code: "invalid-arguments",
      message: `the document was refused by the engine: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let existing: Buffer | null = null;
  try {
    existing = await fsp.readFile(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Anything but "not there" is a real read problem and stops the call.
    if (code !== "ENOENT") {
      return {
        ok: false,
        code: "write-failed",
        message: `could not read ${parsed.data.filename}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (existing !== null) {
    if (!existing.equals(Buffer.from(bytes))) {
      return {
        ok: false,
        code: "file-exists",
        message:
          `${parsed.data.filename} already exists and was not written by this call. ` +
          "create_docx never overwrites a file it did not write; choose another name",
      };
    }
    return {
      ok: true,
      result: { path: parsed.data.filename, byteLength: bytes.byteLength, reused: true },
    };
  }

  // Written through a temp file and renamed, so a reader never sees a half
  // document and an interrupted call cannot leave a truncated .docx behind.
  // Dot-prefixed: it lives in the project root for the moment it takes to
  // write, and a harness listing that directory must not see a file it did
  // not ask for and cannot account for. The name is derived from the
  // validated filename plus this process's pid, so it stays one segment.
  const temp = path.join(path.dirname(target), `.${parsed.data.filename}.${process.pid}.tmp`);
  try {
    await fsp.writeFile(temp, bytes);
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    return {
      ok: false,
      code: "write-failed",
      message: `could not write ${parsed.data.filename}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    result: { path: parsed.data.filename, byteLength: bytes.byteLength, reused: false },
  };
}

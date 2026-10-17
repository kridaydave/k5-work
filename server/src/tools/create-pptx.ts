import {
  CreatePptxArgsSchema,
  type CreatePptxResult,
} from "@k5-work/shared";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildPptx } from "../pptx/driver.js";
import { unsafeNameReason } from "../store/safe-name.js";
import { FixedWindow as DocxFixedWindow } from "./create-docx.js";

export interface PptxToolLimits {
  readonly projectRoot: string;
  readonly posturePermitsWrites: boolean;
  readonly postureVerified: boolean;
  readonly rateLimit: number;
  readonly rateWindowMs: number;
}

export type PptxToolOutcome =
  | { ok: true; result: CreatePptxResult }
  | { ok: false; code: PptxToolRefusalCode; message: string };

export type PptxToolRefusalCode =
  | "invalid-arguments"
  | "unsafe-filename"
  | "posture-refused"
  | "rate-limited"
  | "file-exists"
  | "write-failed";

function refuseFilename(filename: string): string | null {
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

export class FixedWindow extends DocxFixedWindow {}

export async function createPptx(
  args: unknown,
  limits: PptxToolLimits,
  window: FixedWindow = new FixedWindow(limits.rateLimit, limits.rateWindowMs),
): Promise<PptxToolOutcome> {
  const parsed = CreatePptxArgsSchema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.join(".") ?? "";
    return {
      ok: false,
      code: "invalid-arguments",
      message: `create_pptx arguments were refused${at === "" ? "" : ` at ${at}`}: ${first?.message ?? "unknown"}`,
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
      message: `create_pptx is capped at ${String(limits.rateLimit)} calls per ${String(limits.rateWindowMs)} ms`,
    };
  }

  const root = path.resolve(limits.projectRoot);
  const target = path.resolve(root, parsed.data.filename);
  if (target !== path.join(root, parsed.data.filename)) {
    return {
      ok: false,
      code: "unsafe-filename",
      message: `"${parsed.data.filename}" does not resolve inside the project root`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = buildPptx(parsed.data.presentation);
  } catch (err) {
    return {
      ok: false,
      code: "invalid-arguments",
      message: `the presentation was refused by the engine: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let existing: Buffer | null = null;
  try {
    existing = await fsp.readFile(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
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
          "create_pptx never overwrites a file it did not write; choose another name",
      };
    }
    return {
      ok: true,
      result: { path: parsed.data.filename, byteLength: bytes.byteLength, reused: true },
    };
  }

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

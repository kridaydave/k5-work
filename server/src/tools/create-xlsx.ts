import {
  CreateXlsxArgsSchema,
  type CreateXlsxResult,
} from "@k5-work/shared";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildXlsx } from "../xlsx/driver.js";
import { unsafeNameReason } from "../store/safe-name.js";

export interface XlsxToolLimits {
  readonly projectRoot: string;
  readonly posturePermitsWrites: boolean;
  readonly postureVerified: boolean;
  readonly rateLimit: number;
  readonly rateWindowMs: number;
}

export type XlsxToolOutcome =
  | { ok: true; result: CreateXlsxResult }
  | { ok: false; code: XlsxToolRefusalCode; message: string };

export type XlsxToolRefusalCode =
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

export class FixedWindow {
  private windowStart = Date.now();
  private accepted = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

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

export async function createXlsx(
  args: unknown,
  limits: XlsxToolLimits,
  window: FixedWindow = new FixedWindow(limits.rateLimit, limits.rateWindowMs),
): Promise<XlsxToolOutcome> {
  const parsed = CreateXlsxArgsSchema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.join(".") ?? "";
    return {
      ok: false,
      code: "invalid-arguments",
      message: `create_xlsx arguments were refused${at === "" ? "" : ` at ${at}`}: ${first?.message ?? "unknown"}`,
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
      message: `create_xlsx is capped at ${String(limits.rateLimit)} calls per ${String(limits.rateWindowMs)} ms`,
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
    bytes = buildXlsx(parsed.data.workbook);
  } catch (err) {
    return {
      ok: false,
      code: "invalid-arguments",
      message: `the workbook was refused by the engine: ${err instanceof Error ? err.message : String(err)}`,
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
          "create_xlsx never overwrites a file it did not write; choose another name",
      };
    }
    return {
      ok: true,
      result: { path: parsed.data.filename, byteLength: bytes.byteLength, reused: true },
    };
  }

  const temp = path.join(
    path.dirname(target),
    `.${parsed.data.filename}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fsp.writeFile(temp, bytes, { flag: "wx" });
    await fsp.link(temp, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        ok: false,
        code: "file-exists",
        message: `${parsed.data.filename} already exists; choose another name`,
      };
    }
    await fsp.rm(temp, { force: true }).catch(() => {});
    return {
      ok: false,
      code: "write-failed",
      message: `could not write ${parsed.data.filename}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }

  return {
    ok: true,
    result: { path: parsed.data.filename, byteLength: bytes.byteLength, reused: false },
  };
}
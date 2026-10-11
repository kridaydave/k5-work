// The second gate: read the built package back with LibreOffice. Gate one is
// the engine, which checks OPC and XML shape but cannot see whether a heading
// took its style. An exit code alone cannot see that either, so the reader is
// run for its markup instead.
//
// The research for this driver proposed `--cat` for the content assertion and a
// second run to `fodt` for the formatting. Measured on LibreOffice 26.2.6.3, the
// plain text path never returns for a document with a table: `--cat`,
// `--convert-to txt:Text (encoded):UTF8`, and every infilter variant all timed
// out at 25s, while `--convert-to fodt` on the same bytes finished in under two
// seconds. Flat ODF carries the text as well as the formatting, so one run
// answers both and the broken path is not depended on.
//
// Shared by the D-5 proof and the driver fixtures so there is one place where
// LibreOffice is invoked, and one definition of what counts as a load failure.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

/** What a reader would object to, as opposed to what it merely dislikes. */
const LOAD_FAILURE = /source file could not be loaded|repair|corrupt/i;

export function findLibreOffice(): string | undefined {
  const candidates = [
    process.env.LIBREOFFICE_BIN,
    process.env.LIBREOFFICE_PATH,
    "libreoffice",
    "soffice",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const command of candidates) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error === undefined && result.status === 0) return command;
    if (
      result.error !== undefined &&
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      continue;
    }
    const detail = result.error?.message ?? result.stderr ?? result.stdout;
    assert.fail(`LibreOffice probe failed for ${command}: ${detail ?? "unknown error"}`);
  }
  return undefined;
}

function run(
  command: string,
  args: readonly string[],
  profile: string,
): { status: number | null; signal: NodeJS.Signals | null; output: string } {
  fs.mkdirSync(profile, { recursive: true });
  const result = spawnSync(
    command,
    [
      "--headless",
      "--nologo",
      "--nodefault",
      "--norestore",
      "--nolockcheck",
      "--nofirststartwizard",
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      ...args,
    ],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error !== undefined) assert.fail(String(result.error));
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
  assert.equal(result.signal, null, output);
  assert.doesNotMatch(output, LOAD_FAILURE);
  return { status: result.status, signal: result.signal, output };
}

export interface ReaderOutput {
  /** The body text a reader would show, taken from the flat ODF. */
  readonly text: string;
  /** Flat ODF markup, for asserting how something actually renders. */
  readonly flatOdf: string;
}

function bodyText(flatOdf: string): string {
  // office:meta carries the title and the creation date, so the text has to
  // come from the body section only.
  const start = flatOdf.indexOf("<office:text");
  const end = flatOdf.lastIndexOf("</office:text>");
  assert.ok(start !== -1 && end > start, "flat ODF carried no office:text body");
  return flatOdf
    .slice(start, end)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Writes the bytes to a throwaway file, reads them back, and cleans up. A
 * refusal here is a real failure, never a skip: the caller decides whether a
 * missing binary is a skip, via findLibreOffice.
 */
export function readDocument(command: string, bytes: Uint8Array): ReaderOutput {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "k5-docx-gate-"));
  try {
    const input = path.join(root, "document.docx");
    const outdir = path.join(root, "out");
    const profile = path.join(root, "profile");
    fs.writeFileSync(input, bytes);
    fs.mkdirSync(outdir, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });

    run(command, ["--convert-to", "fodt", "--outdir", outdir, input], profile);
    const converted = path.join(outdir, "document.fodt");
    assert.ok(fs.existsSync(converted), "LibreOffice reported success but wrote no flat ODF");

    const flatOdf = fs.readFileSync(converted, "utf8");
    return { text: bodyText(flatOdf), flatOdf };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
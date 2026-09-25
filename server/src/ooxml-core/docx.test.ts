import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { PackageBuilder } from "./package.js";
import { validateSpec, validateZipBytes } from "./validate.js";
import type { PackageSpecInput } from "./validate.js";
import { doc, el, escText } from "./xml.js";

const MAIN_PART = "word/document.xml";
const DOC_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PROOF_TEXT = "k5-work D-5 proof: Fish & Chips";

function createProofSpec(): PackageSpecInput {
  const body = [
    el("w:p", [], el("w:r", [], el("w:t", [], escText(PROOF_TEXT)))),
    el(
      "w:sectPr",
      [],
      [
        el("w:pgSz", [
          ["w:w", "12240"],
          ["w:h", "15840"],
        ]),
        el("w:pgMar", [
          ["w:top", "1440"],
          ["w:right", "1440"],
          ["w:bottom", "1440"],
          ["w:left", "1440"],
          ["w:header", "720"],
          ["w:footer", "720"],
          ["w:gutter", "0"],
        ]),
      ].join(""),
    ),
  ].join("");

  return {
    parts: [
      {
        name: MAIN_PART,
        contentType: DOC_MAIN,
        xml: doc(el("w:document", [["xmlns:w", W_NS]], el("w:body", [], body))),
      },
    ],
    packageRels: [
      {
        type: OFFICE_DOC,
        target: MAIN_PART,
        mode: "internal",
      },
    ],
    partRels: {},
  };
}

function buildProof(): Uint8Array {
  const spec = createProofSpec();
  assert.deepEqual(validateSpec(spec, { mainPart: MAIN_PART }), {
    ok: true,
    errors: [],
    warnings: [],
  });
  const bytes = PackageBuilder.parse(spec).build();
  assert.deepEqual(validateZipBytes(bytes, { mainPart: MAIN_PART }), {
    ok: true,
    errors: [],
    warnings: [],
  });
  return bytes;
}

function findLibreOffice(): string | undefined {
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

function runLibreOffice(command: string, input: string, profile: string) {
  return spawnSync(
    command,
    [
      "--headless",
      "--nologo",
      "--nodefault",
      "--norestore",
      "--nolockcheck",
      "--nofirststartwizard",
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      "--infilter=Office Open XML Text",
      "--cat",
      input,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

describe("ooxml-core DOCX proof (D-5)", () => {
  it("builds a real Word document through the package engine", () => {
    const bytes = buildProof();
    const entries = unzipSync(bytes);
    assert.deepEqual(Object.keys(entries).sort(), [
      "[Content_Types].xml",
      "_rels/.rels",
      MAIN_PART,
    ]);
    assert.ok(
      strFromU8(entries[MAIN_PART]).includes(escText(PROOF_TEXT)),
    );
  });

  it("opens the generated DOCX in LibreOffice without load errors", (t) => {
    const command = findLibreOffice();
    if (command === undefined) {
      t.skip("LibreOffice executable not found");
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "k5-ooxml-docx-"));
    try {
      const input = path.join(root, "proof.docx");
      const profile = path.join(root, "profile");
      fs.writeFileSync(input, buildProof());
      const result = runLibreOffice(command, input, profile);
      if (result.error !== undefined) {
        assert.fail(result.error);
      }
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.signal, null, result.stderr || result.stdout);
      assert.ok(result.stdout.includes(PROOF_TEXT));
      assert.doesNotMatch(
        `${result.stdout}\n${result.stderr}`,
        /source file could not be loaded|repair|corrupt/i,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

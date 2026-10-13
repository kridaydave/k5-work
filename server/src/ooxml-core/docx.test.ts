import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { PackageBuilder } from "./package.js";
import { validateSpec, validateZipBytes } from "./validate.js";
import type { PackageSpecInput } from "./validate.js";
import { doc, el, escText } from "./xml.js";
import { findLibreOffice, readDocument } from "./libreoffice.js";

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
    const read = readDocument(command, buildProof());
    assert.ok(read.text.includes(PROOF_TEXT));
  });
});

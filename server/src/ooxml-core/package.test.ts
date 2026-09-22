import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { CONTENT_TYPES_PATH, PackageBuilder } from "./package.js";
import { OoxmlError } from "./errors.js";

const DOC_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const STYLES =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
const OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const STYLES_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";
const HYPERLINK =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const DOC_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document/>`;

function minimalSpec() {
  return {
    parts: [{ name: "word/document.xml", contentType: DOC_MAIN, xml: DOC_XML }],
    packageRels: [
      { type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
    ],
    partRels: {},
  };
}

function entryNames(zip: Uint8Array): string[] {
  return Object.keys(unzipSync(zip)).sort();
}

describe("ooxml-core package builder (D-3)", () => {

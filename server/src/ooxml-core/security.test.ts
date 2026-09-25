import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { OoxmlError } from "./errors.js";
import { MAX_ZIP_ENTRIES } from "./limits.js";
import { PackageBuilder } from "./package.js";
import { ZipWriter } from "./zip.js";
import { validateSpec, validateZipBytes } from "./validate.js";

const DOC_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const RELS_TYPE = "application/vnd.openxmlformats-package.relationships+xml";
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body><w:p/><w:sectPr/></w:body></w:document>`;

function contentTypes(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="${RELS_TYPE}"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="${DOC_MAIN}"/></Types>`;
}

function relationships(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_DOC}" Target="word/document.xml"/></Relationships>`;
}

function hasCode(result: ReturnType<typeof validateZipBytes>, code: string): boolean {
  return result.errors.some((issue) => issue.code === code);
}

function findCentralEntry(zip: Uint8Array, wantedName: string): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let offset = zip.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.ok(eocd >= 0);
  let central = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(central + 28, true);
    const name = new TextDecoder().decode(zip.subarray(central + 46, central + 46 + nameLength));
    if (name === wantedName) return central;
    central +=
      46 + nameLength + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  }
  return -1;
}

describe("ooxml-core security limits (D-5 follow-up)", () => {
  it("rejects high-ratio ZIP bombs before inflation", () => {
    const zip = zipSync({
      "[Content_Types].xml": strToU8(contentTypes()),
      "_rels/.rels": strToU8(relationships()),
      "word/document.xml": strToU8(DOCUMENT_XML),
      "word/bomb.bin": new Uint8Array(2 * 1024 * 1024),
    });
    const result = validateZipBytes(zip, { mainPart: "word/document.xml" });
    assert.equal(result.ok, false);
    assert.ok(hasCode(result, "E_ZIP_LIMIT"));
  });

  it("rejects entry-count floods", () => {
    const entries: Record<string, Uint8Array> = {
      "[Content_Types].xml": strToU8(contentTypes()),
      "_rels/.rels": strToU8(relationships()),
      "word/document.xml": strToU8(DOCUMENT_XML),
    };
    for (let index = 0; index <= MAX_ZIP_ENTRIES; index += 1) {
      entries[`word/f${index}.bin`] = new Uint8Array([index & 255]);
    }
    const result = validateZipBytes(zipSync(entries), { mainPart: "word/document.xml" });
    assert.ok(hasCode(result, "E_ZIP_LIMIT"));
  });

  it("rejects symlink entries in the central directory", () => {
    const zip = zipSync({
      "[Content_Types].xml": strToU8(contentTypes()),
      "_rels/.rels": strToU8(relationships()),
      "word/document.xml": strToU8(DOCUMENT_XML),
    });
    const central = findCentralEntry(zip, "word/document.xml");
    assert.ok(central >= 0);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(central + 38, (0o120777 << 16) >>> 0, true);
    const result = validateZipBytes(zip, { mainPart: "word/document.xml" });
    assert.ok(hasCode(result, "E_ZIP_SYMLINK"));
  });

  it("rejects special Unix filesystem entries", () => {
    const zip = zipSync({
      "[Content_Types].xml": strToU8(contentTypes()),
      "_rels/.rels": strToU8(relationships()),
      "word/document.xml": strToU8(DOCUMENT_XML),
    });
    const central = findCentralEntry(zip, "word/document.xml");
    assert.ok(central >= 0);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(central + 38, (0o010000 << 16) >>> 0, true);
    assert.ok(hasCode(validateZipBytes(zip), "E_ZIP_FORMAT"));
  });

  it("refuses reserved and Unicode-spoofed part names", () => {
    for (const name of [
      "word/CON.xml",
      "word/NUL",
      "word/PRN.txt",
      "word/AUX.xml",
      "word/CON .xml",
      "word/CONIN$.xml",
      "word/\u202e-trojan.xml",
      "word/zero\u200bwidth.xml",
    ]) {
      assert.throws(
        () =>
          PackageBuilder.parse({
            parts: [{ name, contentType: DOC_MAIN, xml: DOCUMENT_XML }],
            packageRels: [{ type: OFFICE_DOC, target: name }],
            partRels: {},
          }).build(),
        (error: unknown) => error instanceof OoxmlError && error.code === "E_ZIP_PATH",
        name,
      );
    }
  });

  it("applies the same unsafe-name rules to existing ZIP entries", () => {
    for (const name of [
      "word/CON.xml",
      "word/NUL",
      "word/CON .xml",
      "word/CONIN$.xml",
      "word/\u202e-trojan.xml",
      "word/zero\u200bwidth.xml",
      "word/.. /evil.xml",
    ]) {
      const zip = zipSync({
        "[Content_Types].xml": strToU8(contentTypes()),
        "_rels/.rels": strToU8(relationships()),
        "word/document.xml": strToU8(DOCUMENT_XML),
        [name]: strToU8("<x/>"),
      });
      assert.ok(hasCode(validateZipBytes(zip), "E_ZIP_PATH"), name);
    }
  });

  it("rejects deeply nested XML without overflowing the validator", () => {
    const depth = 300;
    const xml = DOCUMENT_XML.replace(
      "<w:p/>",
      `${"<w:p>".repeat(depth)}${"</w:p>".repeat(depth)}`,
    );
    const result = validateSpec({
      parts: [{ name: "word/document.xml", contentType: DOC_MAIN, xml }],
      packageRels: [{ type: OFFICE_DOC, target: "word/document.xml" }],
      partRels: {},
    });
    assert.ok(hasCode(result, "E_XML_LIMIT"));
  });

  it("refuses entry-count floods at the writer boundary", () => {
    const writer = new ZipWriter();
    for (let index = 0; index < MAX_ZIP_ENTRIES; index += 1) {
      writer.add(`word/f${index}.bin`, new Uint8Array());
    }
    assert.throws(
      () => writer.add("word/overflow.bin", new Uint8Array()),
      (error: unknown) => error instanceof OoxmlError && error.code === "E_ZIP_LIMIT",
    );
  });
});

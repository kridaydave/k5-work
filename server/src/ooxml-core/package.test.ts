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
  it("packs a minimal create-only package with engine-owned tables", () => {
    const bytes = PackageBuilder.parse(minimalSpec()).build();
    assert.deepEqual(entryNames(bytes), [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
    ]);

    const back = unzipSync(bytes);
    assert.equal(strFromU8(back["word/document.xml"]), DOC_XML);

    const ct = strFromU8(back[CONTENT_TYPES_PATH]);
    assert.ok(
      ct.includes(
        `<Override PartName="/word/document.xml" ContentType="${DOC_MAIN}"/>`,
      ),
    );
    assert.ok(ct.includes('Extension="rels"'));
    assert.ok(ct.includes('Extension="xml"'));

    const rels = strFromU8(back["_rels/.rels"]);
    assert.ok(rels.includes('Id="rId1"'));
    assert.ok(rels.includes(`Type="${OFFICE_DOC}"`));
    assert.ok(rels.includes('Target="word/document.xml"'));
    assert.ok(!rels.includes("TargetMode"), "internal omits TargetMode");

    // Same spec in, same bytes out.
    assert.deepEqual(
      Buffer.from(PackageBuilder.parse(minimalSpec()).build()),
      Buffer.from(bytes),
    );
  });

  it("allocates rIds per scope and keeps authored relative targets", () => {
    const bytes = PackageBuilder.parse({
      parts: [
        { name: "word/document.xml", contentType: DOC_MAIN, xml: DOC_XML },
        { name: "word/styles.xml", contentType: STYLES, xml: DOC_XML },
      ],
      packageRels: [
        { type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
      ],
      partRels: {
        "word/document.xml": [
          { type: STYLES_REL, target: "styles.xml", mode: "internal" },
          {
            type: HYPERLINK,
            target: "https://example.com/x",
            mode: "external",
          },
        ],
      },
    }).build();

    assert.deepEqual(entryNames(bytes), [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/styles.xml",
    ]);
    const back = unzipSync(bytes);
    const partRels = strFromU8(back["word/_rels/document.xml.rels"]);
    assert.ok(partRels.includes('Id="rId1"'));
    assert.ok(partRels.includes('Id="rId2"'));
    assert.ok(partRels.includes('Target="styles.xml"'));
    assert.ok(partRels.includes('TargetMode="External"'));
    // Package scope restarts at rId1: per-scope, never global.
    assert.ok(strFromU8(back["_rels/.rels"]).includes('Id="rId1"'));
  });

  it("stores precompressed extensions instead of deflating them", () => {
    const bytes = PackageBuilder.parse({
      parts: [
        { name: "word/document.xml", contentType: DOC_MAIN, xml: DOC_XML },
        {
          name: "word/media/a.png",
          contentType: "image/png",
          xml: "<x/>",
        },
      ],
      packageRels: [
        { type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
      ],
      partRels: {},
    }).build();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const methods = new Map<string, number>();
    let o = 0;
    while (dv.getUint32(o, true) === 0x04034b50) {
      const nameLen = dv.getUint16(o + 26, true);
      const extraLen = dv.getUint16(o + 28, true);
      const name = Buffer.from(
        bytes.subarray(o + 30, o + 30 + nameLen),
      ).toString("utf8");
      methods.set(name, dv.getUint16(o + 8, true));
      o += 30 + nameLen + extraLen + dv.getUint32(o + 18, true);
    }
    assert.equal(methods.get("word/media/a.png"), 0);
    assert.equal(methods.get("word/document.xml"), 8);
  });

  it("refuses duplicates, engine-path collisions, and unknown rel sources", () => {
    assert.throws(
      () =>
        PackageBuilder.parse({
          parts: [
            { name: "word/document.xml", contentType: DOC_MAIN, xml: DOC_XML },
            { name: "WORD/DOCUMENT.XML", contentType: DOC_MAIN, xml: DOC_XML },
          ],
          packageRels: [],
          partRels: {},
        }).build(),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_PACKAGE_DUP_PART",
    );
    assert.throws(
      () =>
        PackageBuilder.parse({
          parts: [
            {
              name: "[Content_Types].xml",
              contentType: "application/xml",
              xml: DOC_XML,
            },
          ],
          packageRels: [],
          partRels: {},
        }).build(),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_PACKAGE_DUP_PART",
    );
    assert.throws(
      () =>
        PackageBuilder.parse({
          ...minimalSpec(),
          partRels: {
            "word/missing.xml": [
              { type: STYLES_REL, target: "word/document.xml" },
            ],
          },
        }).build(),
      (e: unknown) => e instanceof OoxmlError && e.code === "E_REL_BAD_TARGET",
    );
  });

  it("refuses dangling internal targets but allows external IRIs", () => {
    assert.throws(
      () =>
        PackageBuilder.parse({
          ...minimalSpec(),
          packageRels: [
            { type: OFFICE_DOC, target: "word/ghost.xml", mode: "internal" },
          ],
        }).build(),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_REL_DANGLING_REF",
    );
    assert.throws(
      () =>
        PackageBuilder.parse({
          ...minimalSpec(),
          partRels: {
            "word/document.xml": [
              { type: STYLES_REL, target: "../ghost.xml" },
            ],
          },
        }).build(),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_REL_DANGLING_REF",
    );
    // External targets point outside the package by design: no LF check.
    const bytes = PackageBuilder.parse({
      ...minimalSpec(),
      partRels: {
        "word/document.xml": [
          { type: HYPERLINK, target: "https://example.com", mode: "external" },
        ],
      },
    }).build();
    assert.ok("word/_rels/document.xml.rels" in unzipSync(bytes));
  });

  it("fails loudly on contract drift, bad types, and illegal chars", () => {
    assert.throws(() => PackageBuilder.parse({ parts: [] }), Error);
    assert.throws(
      () => PackageBuilder.parse({ parts: [], extra: 1 }),
      Error,
    );
    assert.throws(
      () =>
        PackageBuilder.parse({
          parts: [
            { name: "word/document.xml", contentType: "not a type", xml: DOC_XML },
          ],
          packageRels: [],
          partRels: {},
        }).build(),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_CONTENTTYPE_BAD_TYPE",
    );
    assert.throws(
      () =>
        PackageBuilder.parse({
          parts: [
            {
              name: "word/document.xml",
              contentType: DOC_MAIN,
              xml: "bad\u0000 char",
            },
          ],
          packageRels: [],
          partRels: {},
        }).build(),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_XML_ILLEGAL_CHAR",
    );
  });

  it("emits a valid empty package rels file when no rels are declared", () => {
    const bytes = PackageBuilder.parse({
      parts: [{ name: "word/document.xml", contentType: DOC_MAIN, xml: DOC_XML }],
      packageRels: [],
      partRels: {},
    }).build();
    const back = unzipSync(bytes);
    assert.ok("_rels/.rels" in back);
    const rels = strFromU8(back["_rels/.rels"]);
    assert.ok(rels.includes("<Relationships"));
    assert.ok(!rels.includes("<Relationship "));
  });

  it("refuses internal mode with an absolute-URL target", () => {
    assert.throws(
      () =>
        PackageBuilder.parse({
          ...minimalSpec(),
          packageRels: [
            { type: HYPERLINK, target: "https://example.com", mode: "internal" },
          ],
        }).build(),
      (e: unknown) => e instanceof OoxmlError && e.code === "E_REL_BAD_TARGET",
    );
  });


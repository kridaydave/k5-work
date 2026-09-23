import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { OoxmlError } from "./errors.js";
import type { OoxmlErrorCode } from "./errors.js";
import { PackageBuilder } from "./package.js";
import {
  assertValid,
  validateSpec,
  validateZipBytes,
} from "./validate.js";
import type { PackageSpecInput, ValidationResult } from "./validate.js";

const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS_TYPE = "application/vnd.openxmlformats-package.relationships+xml";
const DOC_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const IMAGE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly mode?: "Internal" | "External";
}

function xml(root: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${root}`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contentTypes(
  defaults: ReadonlyArray<readonly [string, string]>,
  overrides: ReadonlyArray<readonly [string, string]>,
): string {
  const defaultXml = defaults
    .map(
      ([extension, type]) =>
        `<Default Extension="${extension}" ContentType="${escapeAttribute(type)}"/>`,
    )
    .join("");
  const overrideXml = overrides
    .map(
      ([partName, type]) =>
        `<Override PartName="${escapeAttribute(partName)}" ContentType="${escapeAttribute(type)}"/>`,
    )
    .join("");
  return xml(`<Types xmlns="${CT_NS}">${defaultXml}${overrideXml}</Types>`);
}

function relationships(rels: readonly Relationship[]): string {
  const children = rels
    .map((rel) => {
      const mode = rel.mode === undefined ? "" : ` TargetMode="${rel.mode}"`;
      return `<Relationship Id="${rel.id}" Type="${escapeAttribute(rel.type)}" Target="${escapeAttribute(rel.target)}"${mode}/>`;
    })
    .join("");
  return xml(`<Relationships xmlns="${RELS_NS}">${children}</Relationships>`);
}

type ZipEntries = Record<string, string | Uint8Array>;

function utf16Le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >>> 8;
  }
  return bytes;
}

function zip(entries: ZipEntries): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([name, data]) => [
        name,
        typeof data === "string" ? strToU8(data) : data,
      ]),
    ),
  );
}

function validEntries(): ZipEntries {
  return {
    "[Content_Types].xml": contentTypes(
      [
        ["rels", RELS_TYPE],
        ["xml", "application/xml"],
      ],
      [["/word/document.xml", DOC_MAIN]],
    ),
    "_rels/.rels": relationships([
      { id: "rId1", type: OFFICE_DOC, target: "word/document.xml" },
    ]),
    "word/document.xml": xml(
      `<w:document xmlns:w="${W_NS}"><w:body><w:p/></w:body></w:document>`,
    ),
  };
}

function validSpec(): PackageSpecInput {
  return {
    parts: [
      {
        name: "word/document.xml",
        contentType: DOC_MAIN,
        xml: xml(
          `<w:document xmlns:w="${W_NS}" xmlns:z="${OFFICE_REL_NS}"><w:body><w:drawing z:embed="rId1"/></w:body></w:document>`,
        ),
      },
      {
        name: "word/media/image.png",
        contentType: "image/png",
        xml: "<binary/>",
      },
    ],
    packageRels: [
      { type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
    ],
    partRels: {
      "word/document.xml": [
        { type: IMAGE_REL, target: "media/image.png", mode: "internal" },
      ],
    },
  };
}

function hasCode(result: ValidationResult, code: OoxmlErrorCode): boolean {
  return result.errors.some((issue) => issue.code === code);
}

function firstCentralHeader(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0);
  return view.getUint32(eocd + 16, true);
}

function patchFirstEntry(
  bytes: Uint8Array,
  field: "flags" | "method" | "crc",
  value: number,
): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const central = firstCentralHeader(out);
  const local = view.getUint32(central + 42, true);
  if (field === "flags") {
    view.setUint16(local + 6, value, true);
    view.setUint16(central + 8, value, true);
  } else if (field === "method") {
    view.setUint16(local + 8, value, true);
    view.setUint16(central + 10, value, true);
  } else {
    view.setUint32(local + 14, value, true);
    view.setUint32(central + 16, value, true);
  }
  return out;
}

function shrinkFirstDeclaredSize(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const central = firstCentralHeader(out);
  const local = view.getUint32(central + 42, true);
  const size = view.getUint32(central + 24, true);
  assert.ok(size > 0);
  view.setUint32(local + 22, size - 1, true);
  view.setUint32(central + 24, size - 1, true);
  return out;
}

describe("ooxml-core write-time validator (D-4)", () => {
  it("accepts a valid JSON-in package spec", () => {
    const result = validateSpec(validSpec(), { mainPart: "word/document.xml" });
    assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
    assert.doesNotThrow(() => assertValid(result));
  });

  it("uses relationship namespaces and decoded XML attribute values", () => {
    const result = validateSpec({
      parts: [
        {
          name: "word/a&b.xml",
          contentType: DOC_MAIN,
          xml: xml(
            `<p:document xmlns:p="${W_NS}" xmlns:custom="${OFFICE_REL_NS}"><p:body><p:drawing custom:embed="rId1"/></p:body></p:document>`,
          ),
        },
        {
          name: "word/media/a&b.png",
          contentType: "image/png",
          xml: "<binary/>",
        },
      ],
      packageRels: [{ type: OFFICE_DOC, target: "word/a&b.xml" }],
      partRels: {
        "word/a&b.xml": [
          { type: IMAGE_REL, target: "media/a&b.png", mode: "internal" },
        ],
      },
    });
    assert.ok(result.ok, JSON.stringify(result.errors));
  });

  it("does not treat relationship-looking comments or text as attributes", () => {
    const result = validateSpec({
      parts: [
        {
          name: "word/document.xml",
          contentType: DOC_MAIN,
          xml: xml(
            `<w:document xmlns:w="${W_NS}"><!-- <w:drawing r:id="made-up"/> --><w:body><w:t>r:id=fake</w:t></w:body></w:document>`,
          ),
        },
      ],
    });
    assert.ok(result.ok, JSON.stringify(result.errors));
  });

  it("reports malformed specs instead of packing them", () => {
    const result = validateSpec({
      parts: [
        {
          name: "word/document.xml",
          contentType: DOC_MAIN,
          xml: xml(`<w:document xmlns:w="${W_NS}"><w:body></w:document>`),
        },
        {
          name: "WORD/DOCUMENT.XML",
          contentType: "not-a-media-type",
          xml: "<a/>",
        },
        {
          name: "[Content_Types].xml",
          contentType: "application/xml",
          xml: "<a/>",
        },
        {
          name: "word/bad-type.xml",
          contentType: "not-a-media-type",
          xml: "<a/>",
        },
        {
          name: "../escape.xml",
          contentType: "application/xml",
          xml: "<a/>",
        },
        {
          name: "word/dtd.xml",
          contentType: "application/xml",
          xml: "<!DOCTYPE a><a/>",
        },
        {
          name: "word/control.xml",
          contentType: "application/xml",
          xml: `<a>${String.fromCharCode(0)}</a>`,
        },
      ],
      packageRels: [{ type: OFFICE_DOC, target: "word/missing.xml" }],
      partRels: {
        "word/unknown.xml": [{ type: IMAGE_REL, target: "word/document.xml" }],
      },
    });

    assert.equal(result.ok, false);
    for (const code of [
      "E_XML_MALFORMED",
      "E_CONTENTTYPE_BAD_TYPE",
      "E_PACKAGE_DUP_PART",
      "E_ZIP_PATH",
      "E_XML_ILLEGAL_CHAR",
      "E_REL_BAD_TARGET",
    ] satisfies OoxmlErrorCode[]) {
      assert.ok(hasCode(result, code), code);
    }
    assert.throws(
      () => assertValid(result, "spec"),
      (error: unknown) => error instanceof OoxmlError,
    );
  });

  it("rejects relationship ids the engine cannot allocate", () => {
    const custom = validateSpec({
      parts: [
        {
          name: "word/document.xml",
          contentType: DOC_MAIN,
          xml: xml(
            `<w:document xmlns:w="${W_NS}" xmlns:r="${OFFICE_REL_NS}" r:id="custom"/>`,
          ),
        },
      ],
      partRels: {
        "word/document.xml": [
          { type: IMAGE_REL, target: "media/image.png" },
        ],
      },
    });
    assert.ok(hasCode(custom, "E_REL_DANGLING_REF"));

    const missingScope = validateSpec({
      parts: [
        {
          name: "word/document.xml",
          contentType: DOC_MAIN,
          xml: xml(
            `<w:document xmlns:w="${W_NS}" xmlns:r="${OFFICE_REL_NS}" r:id="rId1"/>`,
          ),
        },
      ],
    });
    assert.ok(hasCode(missingScope, "E_REL_DANGLING_REF"));
  });

  it("runs both gates through PackageBuilder", () => {
    const bytes = PackageBuilder.parse(validSpec()).build();
    assert.ok(validateZipBytes(bytes).ok);

    assert.throws(
      () =>
        PackageBuilder.parse({
          parts: [
            {
              name: "word/document.xml",
              contentType: DOC_MAIN,
              xml: xml(`<w:document xmlns:w="${W_NS}"><w:body></w:document>`),
            },
          ],
          packageRels: [
            { type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
          ],
        }).build(),
      (error: unknown) =>
        error instanceof OoxmlError && error.code === "E_XML_MALFORMED",
    );
  });
});

describe("ooxml-core post-hoc validator (D-4)", () => {
  it("accepts a valid OPC ZIP and reports reader-compatibility warnings", () => {
    const result = validateZipBytes(zip(validEntries()), {
      mainPart: "word/document.xml",
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(result.warnings.every((issue) => issue.kind === "heuristic"));
    assert.doesNotThrow(() => assertValid(result, "ZIP"));
  });

  it("accepts escaped part names and non-r relationship prefixes", () => {
    const bytes = zip({
      "[Content_Types].xml": contentTypes(
        [
          ["rels", RELS_TYPE],
          ["xml", "application/xml"],
          ["png", "image/png"],
        ],
        [["/word/a&b.xml", DOC_MAIN]],
      ),
      "_rels/.rels": relationships([
        { id: "rId1", type: OFFICE_DOC, target: "word/a&b.xml" },
      ]),
      "word/_rels/a&b.xml.rels": relationships([
        { id: "rId1", type: IMAGE_REL, target: "media/a&b.png" },
      ]),
      "word/a&b.xml": xml(
        `<p:document xmlns:p="${W_NS}" xmlns:custom="${OFFICE_REL_NS}"><p:body><p:drawing custom:embed="rId1"/></p:body></p:document>`,
      ),
      "word/media/a&b.png": new Uint8Array([1, 2, 3]),
    });
    const result = validateZipBytes(bytes, { mainPart: "word/a&b.xml" });
    assert.ok(result.ok, JSON.stringify(result.errors));
  });

  it("accepts UTF-16 XML parts", () => {
    const document = xml(
      `<w:document xmlns:w="${W_NS}"><w:body><w:p/></w:body></w:document>`,
    ).replace("UTF-8", "UTF-16");
    const result = validateZipBytes(
      zip({
        ...validEntries(),
        "word/document.xml": utf16Le(document),
      }),
    );
    assert.ok(result.ok, JSON.stringify(result.errors));
  });

  it("rejects malformed and structurally incomplete packages", () => {
    assert.ok(
      hasCode(validateZipBytes(new Uint8Array([1, 2, 3])), "E_ZIP_FORMAT"),
    );
    assert.ok(
      hasCode(
        validateZipBytes(zip({ "word/document.xml": "<x/>" })),
        "E_PACKAGE_MISSING_PART",
      ),
    );
    assert.ok(
      hasCode(
        validateZipBytes(
          zip({
            ...validEntries(),
            "../escape.xml": "<x/>",
          }),
        ),
        "E_ZIP_PATH",
      ),
    );
    const duplicate = validateZipBytes(
      zip({
        ...validEntries(),
        "WORD/DOCUMENT.XML": "<x/>",
      }),
    );
    assert.ok(hasCode(duplicate, "E_PACKAGE_DUP_PART"));
  });

  it("rejects forbidden ZIP methods, flags, ZIP64 fields, and bad CRCs", () => {
    const valid = zip(validEntries());
    const method = validateZipBytes(patchFirstEntry(valid, "method", 12));
    assert.ok(hasCode(method, "E_ZIP_METHOD"));

    const flags = validateZipBytes(patchFirstEntry(valid, "flags", 1));
    assert.ok(hasCode(flags, "E_ZIP_GPBIT"));

    const crc = validateZipBytes(patchFirstEntry(valid, "crc", 0));
    assert.ok(hasCode(crc, "E_ZIP_CRC"));

    const shortSize = validateZipBytes(shrinkFirstDeclaredSize(valid));
    assert.ok(hasCode(shortSize, "E_ZIP_FORMAT"));

    const zip64 = valid.slice();
    const view = new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength);
    const eocd = zip64.byteLength - 22;
    view.setUint32(eocd + 16, 0xffffffff, true);
    assert.ok(hasCode(validateZipBytes(zip64), "E_ZIP_ZIP64"));

    assert.ok(
      hasCode(validateZipBytes(valid.slice(0, -1)), "E_ZIP_FORMAT"),
    );
  });

  it("checks content-type coverage, duplicates, and orphan overrides", () => {
    const result = validateZipBytes(
      zip({
        "[Content_Types].xml": contentTypes(
          [
            ["rels", RELS_TYPE],
            ["xml", "application/xml"],
            ["xml", "text/xml"],
          ],
          [["/word/missing.xml", DOC_MAIN]],
        ),
        "_rels/.rels": relationships([]),
        "word/document.xml": "<unmapped/>",
        "word/unmapped.bin": new Uint8Array([0]),
      }),
      { mainPart: "word/document.xml" },
    );
    assert.ok(hasCode(result, "E_CONTENTTYPE_DUP_DEFAULT"));
    assert.ok(hasCode(result, "E_CONTENTTYPE_ORPHAN_OVERRIDE"));
    assert.ok(hasCode(result, "E_CONTENTTYPE_UNCOVERED"));
  });

  it("rejects identical duplicate content-type rules", () => {
    const result = validateZipBytes(
      zip({
        "[Content_Types].xml": contentTypes(
          [
            ["rels", RELS_TYPE],
            ["xml", "application/xml"],
            ["xml", "application/xml"],
          ],
          [
            ["/word/document.xml", DOC_MAIN],
            ["/word/document.xml", DOC_MAIN],
          ],
        ),
        "_rels/.rels": relationships([]),
        "word/document.xml": xml(
          `<w:document xmlns:w="${W_NS}"><w:body/></w:document>`,
        ),
      }),
    );
    assert.ok(hasCode(result, "E_CONTENTTYPE_DUP_DEFAULT"));
    assert.ok(hasCode(result, "E_CONTENTTYPE_DUP_OVERRIDE"));
  });

  it("checks XML well-formedness, namespaces, and UTF-8", () => {
    const malformed = validateZipBytes(
      zip({
        ...validEntries(),
        "word/document.xml": xml(
          `<w:document xmlns:w="${W_NS}"><w:body></w:document>`,
        ),
      }),
    );
    assert.ok(hasCode(malformed, "E_XML_MALFORMED"));

    const undeclaredPrefix = validateZipBytes(
      zip({
        ...validEntries(),
        "word/document.xml": xml(`<w:document r:id="rId1"/>`),
      }),
    );
    assert.ok(hasCode(undeclaredPrefix, "E_XML_MALFORMED"));

    const invalidUtf8 = validateZipBytes(
      zip({
        ...validEntries(),
        "word/document.xml": new Uint8Array([0xff]),
      }),
    );
    assert.ok(hasCode(invalidUtf8, "E_XML_MALFORMED"));

    const xmlByContentType = validateZipBytes(
      zip({
        "[Content_Types].xml": contentTypes(
          [
            ["rels", RELS_TYPE],
            ["bin", "application/xml"],
          ],
          [],
        ),
        "_rels/.rels": relationships([]),
        "word/data.bin": "<unclosed>",
      }),
    );
    assert.ok(hasCode(xmlByContentType, "E_XML_MALFORMED"));

    const nonXmlParameter = validateZipBytes(
      zip({
        "[Content_Types].xml": contentTypes(
          [
            ["rels", RELS_TYPE],
            ["bin", "application/octet-stream;profile=+xml"],
          ],
          [],
        ),
        "_rels/.rels": relationships([]),
        "word/data.bin": "<not-xml>",
      }),
    );
    assert.ok(nonXmlParameter.ok, JSON.stringify(nonXmlParameter.errors));
  });

  it("checks relationship targets, duplicate ids, and dangling references", () => {
    const result = validateZipBytes(
      zip({
        ...validEntries(),
        "word/_rels/document.xml.rels": relationships([
          { id: "rId1", type: IMAGE_REL, target: "missing.png" },
          { id: "rId1", type: IMAGE_REL, target: "missing-2.png" },
          { id: "1 bad", type: IMAGE_REL, target: "missing-3.png" },
        ]),
        "word/document.xml": xml(
          `<w:document xmlns:w="${W_NS}" xmlns:z="${OFFICE_REL_NS}" z:embed="rId2"><w:body/></w:document>`,
        ),
      }),
    );
    assert.ok(hasCode(result, "E_REL_DANGLING_REF"));
    assert.ok(hasCode(result, "E_REL_DUP_RID"));
    assert.ok(hasCode(result, "E_REL_BAD_TARGET"));
  });

  it("checks known Word child order and table heuristics", () => {
    const result = validateZipBytes(
      zip({
        ...validEntries(),
        "word/document.xml": xml(
          `<w:document xmlns:w="${W_NS}"><w:body><w:sectPr/><w:p/><w:tbl><w:tr/></w:tbl></w:body></w:document>`,
        ),
      }),
    );
    assert.ok(hasCode(result, "E_PACKAGE_ORDER"));
    assert.ok(
      result.warnings.some(
        (issue) => issue.code === "E_PACKAGE_ORDER" && issue.path === "word/document.xml",
      ),
    );
  });
});

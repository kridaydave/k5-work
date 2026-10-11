// Fixtures for the four engine gates added for D-6 (see
// CD_res/implementation/docx-driver/docx-driver-research.md, unit 0). Each one
// is here because a driver sits on top of it and cannot work around a missing
// gate: the driver writes the package, so the engine has to be the one that
// refuses it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OoxmlError } from "./errors.js";
import type { OoxmlErrorCode } from "./errors.js";
import { MAX_XML_DEPTH, MAX_XML_ELEMENTS } from "./index.js";
import { PackageBuilder } from "./package.js";
import { validateSpec, validateZipBytes } from "./validate.js";
import type { PackageSpecInput, ValidationResult } from "./validate.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOC_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const STYLES =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
const OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const STYLES_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";

function xml(root: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${root}`;
}

function hasCode(result: ValidationResult, code: OoxmlErrorCode): boolean {
  return result.errors.some((issue) => issue.code === code);
}

function throwsCode(code: OoxmlErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof OoxmlError && error.code === code;
}

function docSpec(xmlBody: string): PackageSpecInput {
  return {
    parts: [{ name: "word/document.xml", contentType: DOC_MAIN, xml: xmlBody }],
    packageRels: [
      { type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
    ],
    partRels: {},
  };
}

/** A table of `rows` rows of two empty cells, which compresses far past 200:1. */
function emptyCellTable(rows: number): string {
  const row = "<w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>";
  return xml(
    `<w:document xmlns:w="${W_NS}"><w:body><w:tbl><w:tblPr/><w:tblGrid>` +
      `<w:gridCol w:w="4675"/><w:gridCol w:w="4675"/></w:tblGrid>` +
      row.repeat(rows) +
      "</w:tbl></w:body></w:document>",
  );
}

/** `depth` elements nested, the root included, matching how the parser counts. */
function nestedXml(depth: number): string {
  const inner = depth - 1;
  return xml(
    `<w:document xmlns:w="${W_NS}">${"<w:p>".repeat(inner)}${"</w:p>".repeat(inner)}</w:document>`,
  );
}

/** `count` elements in total, the root included. */
function manyElements(count: number): string {
  return xml(
    `<w:document xmlns:w="${W_NS}">${"<w:p/>".repeat(count - 1)}</w:document>`,
  );
}

describe("ooxml-core engine gates for the docx driver (D-6 unit 0)", () => {
  it("builds a 3,000-row table the ratio guard refuses when the bytes come from elsewhere", () => {
    const bytes = PackageBuilder.parse(docSpec(emptyCellTable(3_000))).build();
    assert.ok(bytes.byteLength > 0);

    // The same bytes, read as input from somebody else. This is the guard the
    // engine just stood down on: it has to stay armed here, or the exemption
    // becomes a hole in the zip-bomb check for every future reader.
    const asForeignInput = validateZipBytes(bytes);
    assert.ok(
      hasCode(asForeignInput, "E_ZIP_LIMIT"),
      JSON.stringify(asForeignInput.errors),
    );
    assert.ok(
      asForeignInput.errors.some((issue) => issue.message.includes("compression ratio")),
      "the refusal must still name the ratio, since that is what fired",
    );
  });

  it("refuses a package that never declares the main relationship", () => {
    const mainRelationship = {
      type: OFFICE_DOC,
      target: "word/document.xml",
    } as const;
    const docOnly = docSpec(`<w:document xmlns:w="${W_NS}"/>`);

    // The relationship removed entirely, which is the case a reader cannot
    // survive. The refusal has to name the missing relationship rather than the
    // consequence of it, so this asserts the code and not just that it threw.
    const noRels: PackageSpecInput = { ...docOnly, packageRels: [] };
    assert.throws(
      () => PackageBuilder.parse(noRels).build({ mainRelationship }),
      throwsCode("E_PACKAGE_MAIN_REL"),
    );

    // Declared with the wrong type: the part is reachable, but not as the main
    // document, so this is the same refusal for the other reason.
    const wrongType: PackageSpecInput = {
      ...docOnly,
      packageRels: [{ type: STYLES_REL, target: "word/document.xml" }],
    };
    assert.throws(
      () => PackageBuilder.parse(wrongType).build({ mainRelationship }),
      throwsCode("E_PACKAGE_MAIN_REL"),
    );

    // Declared as a part relationship instead of a package one. Only the
    // package relationships are what a reader follows to find the document.
    const notAtPackageLevel: PackageSpecInput = {
      ...docOnly,
      packageRels: [],
      partRels: {
        "word/document.xml": [{ type: OFFICE_DOC, target: "document.xml" }],
      },
    };
    assert.throws(
      () => PackageBuilder.parse(notAtPackageLevel).build({ mainRelationship }),
      throwsCode("E_PACKAGE_MAIN_REL"),
    );

    // The check is the caller's to ask for. Off, a package that reaches its
    // document some other way builds, because the builder stays generic over
    // OPC content types and cannot know what the caller considers main.
    assert.ok(PackageBuilder.parse(wrongType).build().byteLength > 0);

    // Declared correctly, and the build goes through.
    const declared: PackageSpecInput = {
      ...docOnly,
      packageRels: [{ type: OFFICE_DOC, target: "word/document.xml" }],
    };
    assert.ok(
      PackageBuilder.parse(declared).build({ mainRelationship }).byteLength > 0,
    );

    // A malformed option is refused the same typed way, never as a TypeError
    // from inside a gate.
    for (const bad of [
      null,
      {},
      { type: OFFICE_DOC },
      { target: "word/document.xml" },
      { type: "", target: "word/document.xml" },
    ]) {
      assert.throws(
        () =>
          PackageBuilder.parse(declared).build({
            mainRelationship: bad as typeof mainRelationship,
          }),
        throwsCode("E_REL_BAD_TARGET"),
      );
    }
  });

  it("refuses a part that no relationship points at", () => {
    const styles = xml(`<w:styles xmlns:w="${W_NS}"/>`);
    const withOrphanStyles: PackageSpecInput = {
      parts: [
        { name: "word/document.xml", contentType: DOC_MAIN, xml: `<w:document xmlns:w="${W_NS}"/>` },
        { name: "word/styles.xml", contentType: STYLES, xml: styles },
      ],
      packageRels: [
        { type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
      ],
      partRels: {},
    };

    // word/styles.xml shipped and ignored is the failure this gate exists for.
    assert.throws(
      () => PackageBuilder.parse(withOrphanStyles).build(),
      (error: unknown) =>
        throwsCode("E_PACKAGE_UNREACHABLE")(error) &&
        error instanceof OoxmlError &&
        error.message.includes("word/styles.xml"),
    );

    const wired: PackageSpecInput = {
      ...withOrphanStyles,
      partRels: {
        "word/document.xml": [{ type: STYLES_REL, target: "styles.xml" }],
      },
    };
    assert.ok(PackageBuilder.parse(wired).build().byteLength > 0);
  });

  it("enforces the depth and element caps at exactly the exported numbers", () => {
    // A driver that wants to refuse a document before the engine does needs the
    // engine's own numbers. If an export drifted from the enforcement, the
    // driver would refuse the wrong documents, so both sides are pinned here.
    assert.ok(validateSpec(docSpec(nestedXml(MAX_XML_DEPTH))).ok);
    assert.ok(
      hasCode(
        validateSpec(docSpec(nestedXml(MAX_XML_DEPTH + 1))),
        "E_XML_LIMIT",
      ),
    );

    assert.ok(validateSpec(docSpec(manyElements(MAX_XML_ELEMENTS))).ok);
    assert.ok(
      hasCode(
        validateSpec(docSpec(manyElements(MAX_XML_ELEMENTS + 1))),
        "E_XML_LIMIT",
      ),
    );
  });
});
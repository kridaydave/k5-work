import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRelsXml,
  normalizePartPath,
  PACKAGE_RELS_PATH,
  RELS_NS,
  RelScope,
  relsPathForPart,
  resolvePackageRelTarget,
  resolveRelTarget,
} from "./rels.js";
import type { RelEntry } from "./rels.js";
import { OoxmlError } from "./errors.js";
import { XML_DECL } from "./xml.js";

const OFFICE_DOC = "http://example.com/officeDocument";
const HYPERLINK = "http://example.com/hyperlink";

function isCode(e: unknown, code: string): boolean {
  return e instanceof OoxmlError && e.code === code;
}

describe("ooxml-core rels (D-2)", () => {
  it("allocates rIds per scope, never global", () => {
    const a = new RelScope(relsPathForPart("word/document.xml"));
    const b = new RelScope(relsPathForPart("xl/workbook.xml"));
    assert.equal(a.add("t1", "x.xml").rId, "rId1");
    assert.equal(a.add("t2", "y.xml").rId, "rId2");
    assert.equal(a.add("t3", "z.xml").rId, "rId3");
    assert.equal(b.add("t1", "z.xml").rId, "rId1");
  });

  it("maps part names to .rels paths", () => {
    assert.equal(
      relsPathForPart("word/document.xml"),
      "word/_rels/document.xml.rels",
    );
    assert.equal(relsPathForPart("workbook.xml"), "_rels/workbook.xml.rels");
    assert.equal(PACKAGE_RELS_PATH, "_rels/.rels");
  });

  it("omits TargetMode for internal, emits it for external, rejects dup rIds", () => {
    const rels: RelEntry[] = [
      { rId: "rId1", type: OFFICE_DOC, target: "word/document.xml", mode: "internal" },
      { rId: "rId2", type: HYPERLINK, target: "https://example.com", mode: "external" },
    ];
    const body =
      `<Relationships xmlns="${RELS_NS}">` +
      `<Relationship Id="rId1" Type="${OFFICE_DOC}" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="${HYPERLINK}" Target="https://example.com" TargetMode="External"/>` +
      `</Relationships>`;
    assert.equal(buildRelsXml(rels), XML_DECL + body);
    assert.throws(
      () => buildRelsXml([rels[0], rels[0]]),
      (e: unknown) => isCode(e, "E_REL_DUP_RID"),
    );
  });

  it("resolves relative targets against the source part", () => {
    assert.equal(
      resolveRelTarget("word/document.xml", "media/img.png"),
      "word/media/img.png",
    );
    assert.equal(
      resolveRelTarget("xl/worksheets/sheet1.xml", "../sharedStrings.xml"),
      "xl/sharedStrings.xml",
    );
    assert.equal(
      resolveRelTarget("xl/worksheets/sheet1.xml", "/word/a.xml"),
      "word/a.xml",
    );
    assert.equal(
      resolveRelTarget("word/document.xml", "https://example.com/x"),
      "https://example.com/x",
    );
    assert.throws(
      () => resolveRelTarget("word/document.xml", ""),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
    assert.throws(
      () => resolveRelTarget("word/document.xml", "../../evil.xml"),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
  });

  it("rejects degenerate, drive-letter, and mode-mismatched targets", () => {
    const BS = String.fromCharCode(92);
    assert.throws(
      () => resolveRelTarget("word/document.xml", "/"),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
    assert.throws(
      () => resolveRelTarget("word/document.xml", "C:/x.xml"),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
    assert.throws(
      () => resolveRelTarget("word/document.xml", `C:${BS}x.xml`),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
    assert.throws(
      () =>
        buildRelsXml([
          {
            rId: "rId1",
            type: "t",
            target: "https://example.com",
            mode: "internal",
          },
        ]),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
    const scope = new RelScope(PACKAGE_RELS_PATH);
    assert.throws(
      () => scope.add("t", "https://example.com"),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
  });

  it("treats rIds case-sensitively and nests rel paths", () => {
    assert.equal(relsPathForPart("a/b/c.xml"), "a/b/_rels/c.xml.rels");
    const both: RelEntry[] = [
      { rId: "rId1", type: "t", target: "a.xml", mode: "internal" },
      { rId: "RID1", type: "t", target: "b.xml", mode: "internal" },
    ];
    assert.ok(buildRelsXml(both).includes('Id="RID1"'));
  });

  it("rejects bad part paths and escapes targets in xml", () => {
    for (const bad of ["", "a//b", "a/./b"]) {
      assert.throws(
        () => normalizePartPath(bad),
        (e: unknown) => isCode(e, "E_ZIP_PATH"),
        bad,
      );
    }
    const xml = buildRelsXml([
      { rId: "rId1", type: "t", target: "a&b.xml", mode: "internal" },
    ]);
    assert.ok(xml.includes('Target="a&amp;b.xml"'));
  });

  it("stores scope entries and builds scope xml", () => {
    const scope = new RelScope(relsPathForPart("word/document.xml"));
    scope.add("t1", "a.xml");
    scope.add("t2", "https://example.com/e", "external");
    assert.equal(scope.entries.length, 2);
    assert.ok(scope.buildXml().includes('TargetMode="External"'));
  });

  it("rejects drive-letter targets in external mode", () => {
    const BS = String.fromCharCode(92);
    const scope = new RelScope(PACKAGE_RELS_PATH);
    assert.throws(
      () => scope.add("t", "C:/x.xml", "external"),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
    assert.throws(
      () =>
        buildRelsXml([
          { rId: "rId1", type: "t", target: `C:${BS}x.xml`, mode: "external" },
        ]),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
  });

  it("rejects drive-letter targets in internal mode too", () => {
    const scope = new RelScope(PACKAGE_RELS_PATH);
    assert.throws(
      () => scope.add("t", "C:/x.xml"),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
    assert.throws(
      () =>
        buildRelsXml([
          { rId: "rId1", type: "t", target: "C:/x.xml", mode: "internal" },
        ]),
      (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
    );
  });

  it("rejects drive-relative targets without a slash too", () => {
    const BS = String.fromCharCode(92);
    for (const bad of ["C:foo", "c:bar/baz.xml", `D:${BS}x.xml`]) {
      assert.throws(
        () => resolveRelTarget("word/document.xml", bad),
        (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
        bad,
      );
      assert.throws(
        () => resolvePackageRelTarget(bad),
        (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
        bad,
      );
      assert.throws(
        () => new RelScope(PACKAGE_RELS_PATH).add("t", bad, "external"),
        (e: unknown) => isCode(e, "E_REL_BAD_TARGET"),
        bad,
      );
    }
  });

});

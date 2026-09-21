import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContentTypes, CT_NS } from "./content-types.js";
import { OoxmlError } from "./errors.js";
import { XML_DECL } from "./xml.js";

const DOC_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const CORE =
  "application/vnd.openxmlformats-package.core-properties+xml";
const RELS_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";

describe("ooxml-core content-types (D-2)", () => {
  it("keeps one Default per extension, refuses conflicts", () => {
    const ct = new ContentTypes();
    ct.addDefault("xml", "application/xml");
    ct.addDefault(".XML", "application/xml");
    ct.addDefault("xml", "application/xml");
    assert.throws(
      () => ct.addDefault("xml", "text/xml"),
      (e: unknown) =>
        e instanceof OoxmlError &&
        e.code === "E_CONTENTTYPE_DUP_DEFAULT",
    );
  });

  it("overrides win over defaults, matched case-insensitively", () => {
    const ct = new ContentTypes();
    ct.addDefault("xml", "application/xml");
    ct.addOverride("/word/document.xml", DOC_MAIN);
    assert.equal(ct.resolve("word/document.xml"), DOC_MAIN);
    assert.equal(ct.resolve("/WORD/DOCUMENT.XML"), DOC_MAIN);
    assert.equal(ct.resolve("word/other.xml"), "application/xml");
    assert.equal(ct.resolve("word/noext"), null);
    assert.equal(ct.resolve("media/blob.xyz"), null);
  });

  it("rejects conflicting overrides and orphan overrides", () => {
    const ct = new ContentTypes();
    ct.addOverride("word/document.xml", DOC_MAIN);
    ct.addOverride("/word/document.xml", DOC_MAIN);
    assert.throws(
      () => ct.addOverride("word/document.xml", CORE),
      (e: unknown) =>
        e instanceof OoxmlError &&
        e.code === "E_CONTENTTYPE_DUP_OVERRIDE",
    );
    assert.doesNotThrow(() =>
      ct.assertNoOrphans(["word/document.xml", "docProps/core.xml"]),
    );
    const ct2 = new ContentTypes();
    ct2.addOverride("/word/missing.xml", DOC_MAIN);
    assert.throws(
      () => ct2.assertNoOrphans(["word/document.xml"]),
      (e: unknown) =>
        e instanceof OoxmlError &&
        e.code === "E_CONTENTTYPE_ORPHAN_OVERRIDE",
    );
  });

  it("emits deterministic sorted XML", () => {
    const ct = new ContentTypes();
    ct.addDefault("xml", "application/xml");
    ct.addOverride("/word/document.xml", DOC_MAIN);
    ct.addDefault("rels", RELS_TYPE);
    ct.addOverride("docProps/core.xml", CORE);
    ct.addDefault("jpeg", "image/jpeg");
    const body =
      `<Types xmlns="${CT_NS}">` +
      `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
      `<Default Extension="rels" ContentType="${RELS_TYPE}"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="${CORE}"/>` +
      `<Override PartName="/word/document.xml" ContentType="${DOC_MAIN}"/>` +
      `</Types>`;
    assert.equal(ct.buildXml(), XML_DECL + body);
  });

  it("refuses empty extensions, empty types, and bad part names", () => {
    const ct = new ContentTypes();
    assert.throws(
      () => ct.addDefault("", "application/xml"),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_CONTENTTYPE_BAD_EXT",
    );
    assert.throws(
      () => ct.addDefault("xml", "   "),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_CONTENTTYPE_BAD_TYPE",
    );
    assert.throws(
      () => ct.addOverride("/w/d.xml", ""),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_CONTENTTYPE_BAD_TYPE",
    );
    assert.throws(
      () => ct.addOverride("word/../evil.xml", DOC_MAIN),
      (e: unknown) => e instanceof OoxmlError && e.code === "E_ZIP_PATH",
    );
    assert.throws(
      () => ct.resolve(""),
      (e: unknown) => e instanceof OoxmlError && e.code === "E_ZIP_PATH",
    );
  });

  it("takes the extension from the last segment only", () => {
    const ct = new ContentTypes();
    ct.addDefault("gz", "application/gzip");
    assert.equal(ct.resolve("a/tar.gz"), "application/gzip");
    assert.equal(ct.resolve("/a.b/c"), null);
    assert.equal(ct.resolve("word/foo."), null);
  });

  it("normalizes backslashes and exposes snapshot readers", () => {
    const ct = new ContentTypes();
    ct.addOverride("word\\doc.xml", DOC_MAIN);
    assert.equal(ct.resolve("/word/doc.xml"), DOC_MAIN);
    assert.doesNotThrow(() => ct.assertNoOrphans(["WORD\\DOC.XML"]));
    assert.deepEqual(ct.overrideEntries(), [
      { partName: "/word/doc.xml", contentType: DOC_MAIN },
    ]);
    assert.deepEqual(ct.defaultEntries(), []);
  });

  it("escapes special chars in the emitted table", () => {
    const ct = new ContentTypes();
    ct.addOverride("word/a&b.xml", "t&v");
    assert.ok(
      ct
        .buildXml()
        .includes(
          '<Override PartName="/word/a&amp;b.xml" ContentType="t&amp;v"/>',
        ),
    );
  });
});

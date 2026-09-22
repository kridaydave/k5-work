import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OoxmlError } from "./errors.js";
import { toPartName, toZipPath } from "./paths.js";

function isZipPath(e: unknown): boolean {
  return e instanceof OoxmlError && e.code === "E_ZIP_PATH";
}

describe("ooxml-core paths (review fix)", () => {
  it("normalizes slashes and leading slash", () => {
    assert.equal(toZipPath("word\\doc.xml"), "word/doc.xml");
    assert.equal(toZipPath("/word/doc.xml"), "word/doc.xml");
    assert.equal(toZipPath("word/doc.xml"), "word/doc.xml");
    assert.equal(toPartName("word/doc.xml"), "/word/doc.xml");
    assert.equal(toPartName("/word/doc.xml"), "/word/doc.xml");
  });

  it("rejects empty, dot, dotdot, and empty segments", () => {
    for (const bad of ["", "/", ".", "..", "a//b", "a/./b", "word/"]) {
      assert.throws(() => toZipPath(bad), isZipPath, bad);
    }
    assert.throws(() => toPartName("a/../b.xml"), isZipPath);
  });

  it("rejects drive letters and colons", () => {
    assert.throws(() => toZipPath("C:/word/doc.xml"), isZipPath);
    assert.throws(() => toZipPath("a/b:c.xml"), isZipPath);
    assert.throws(() => toPartName("C:\\word\\doc.xml"), isZipPath);
  });

  it("refuses __proto__ segments (prototype-pollution guard)", () => {
    for (const bad of ["__proto__", "__PROTO__", "word/__proto__/a.xml"]) {
      assert.throws(() => toZipPath(bad), isZipPath, bad);
      assert.throws(() => toPartName(bad), isZipPath, bad);
    }
    // Near-misses stay legal: only the exact segment is reserved.
    assert.equal(toZipPath("word/constructor.xml"), "word/constructor.xml");
    assert.equal(toZipPath("word/prototype.xml"), "word/prototype.xml");
  });

  it("rejects surrounding whitespace instead of trimming it", () => {
    assert.throws(() => toZipPath(" word/doc.xml"), isZipPath);
    assert.throws(() => toZipPath("word/doc.xml "), isZipPath);
    assert.throws(() => toPartName("  word/doc.xml  "), isZipPath);
  });
});

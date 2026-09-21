import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OoxmlError } from "./errors.js";
import { XML_DECL, doc, el, escAttr, escText } from "./xml.js";

const TAB = String.fromCodePoint(9);
const LF = String.fromCodePoint(10);
const CR = String.fromCodePoint(13);
const NUL = String.fromCodePoint(0);
const US = String.fromCodePoint(31);
const FFFE = String.fromCodePoint(65534);

describe("ooxml-core xml builder (D-1)", () => {
  it("escapes the 5 predefined entities in text and attrs", () => {
    assert.equal(escText(`a&b<c>d"e'f`), `a&amp;b&lt;c&gt;d"e'f`);
    assert.equal(escAttr(`a&b<c>d"e'f`), `a&amp;b&lt;c&gt;d&quot;e&apos;f`);
    // & first: no double-escaping of entity prefixes.
    assert.equal(escText(`&amp;`), `&amp;amp;`);
  });

  it("rejects illegal XML chars, passes TAB/LF/CR", () => {
    assert.doesNotThrow(() => escText(`a${TAB}b${LF}c${CR}d`));
    assert.throws(
      () => escText(`a${NUL}b`),
      (e: unknown) => e instanceof OoxmlError,
    );
    assert.throws(
      () => escAttr(`a${US}b`),
      (e: unknown) => e instanceof OoxmlError,
    );
    assert.throws(
      () => escText(`a${FFFE}b`),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_XML_ILLEGAL_CHAR",
    );
  });

  it("emits canonical declaration and preserves attr order", () => {
    assert.ok(XML_DECL.includes('encoding="UTF-8"'));
    assert.ok(XML_DECL.includes('standalone="yes"'));
    const out = el(
      "w:p",
      [
        ["w:val", "2"],
        ["w:id", "1"],
      ],
      "x",
    );
    assert.equal(out, '<w:p w:val="2" w:id="1">x</w:p>');
    assert.equal(el("x"), "<x/>");
    assert.equal(doc("<x/>"), `${XML_DECL}<x/>`);
  });

  it("escapes attr values inside el()", () => {
    assert.equal(
      el("a", [["href", 'x&"y']]),
      '<a href="x&amp;&quot;y"/>',
    );
  });

  it("handles messy real-world text without breaking", () => {
    assert.equal(escText(`Fish && Chips`), `Fish &amp;&amp; Chips`);
    assert.equal(escText(`<<<BETTER>>>`), `&lt;&lt;&lt;BETTER&gt;&gt;&gt;`);
    assert.equal(escText(`a]]>b`), `a]]&gt;b`);
    assert.equal(escText(`"quoted" and 'singles'`), `"quoted" and 'singles'`);
    assert.equal(escText(``), ``);
  });

  it("passes unicode through untouched", () => {
    const ACCENT = String.fromCodePoint(233);
    const CJK = String.fromCodePoint(26085, 26412, 35486);
    const PARTY = String.fromCodePoint(127881);
    const MUSICAL = String.fromCodePoint(119070);
    const REPLACEMENT = String.fromCodePoint(65533);
    const s = `caf${ACCENT} ${CJK} ${PARTY} note${MUSICAL} ok${REPLACEMENT}`;
    assert.equal(escText(s), s);
    assert.equal(escAttr(s), s);
  });

  it("treats input as raw: entity-looking text is escaped, not passed through", () => {
    assert.equal(escText(`Fish &amp; Chips`), `Fish &amp;amp; Chips`);
    assert.equal(escText(`&lt;`), `&amp;lt;`);
  });

  it("distinguishes empty element from empty content", () => {
    assert.equal(el("x"), "<x/>");
    assert.equal(el("x", [], ""), "<x></x>");
  });

  it("rejects lone surrogates", () => {
    const LONE = String.fromCharCode(55296);
    assert.throws(
      () => escText(`a${LONE}b`),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_XML_ILLEGAL_CHAR",
    );
  });

  it("rejects the remaining C0 controls and U+FFFF, passes DEL and FFFD", () => {
    for (const cp of [8, 11, 12, 31, 65535]) {
      const ch = String.fromCodePoint(cp);
      assert.throws(
        () => escText(`a${ch}b`),
        (e: unknown) =>
          e instanceof OoxmlError && e.code === "E_XML_ILLEGAL_CHAR",
      );
    }
    const DEL = String.fromCodePoint(127);
    const FFFD = String.fromCodePoint(65533);
    assert.doesNotThrow(() => escText(`a${DEL}${FFFD}b`));
  });

  it("rejects trail surrogates and checks offsets past astral chars", () => {
    const TRAIL = String.fromCharCode(56320);
    assert.throws(
      () => escText(`a${TRAIL}b`),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_XML_ILLEGAL_CHAR",
    );
    const MUSICAL = String.fromCodePoint(119070);
    const NUL = String.fromCodePoint(0);
    assert.throws(
      () => escText(`${MUSICAL}${NUL}`),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_XML_ILLEGAL_CHAR",
    );
    assert.doesNotThrow(() => escText(`${MUSICAL}ok`));
  });

  it("emits the declaration byte-exact", () => {
    assert.equal(
      XML_DECL.slice(0, XML_DECL.length - 1),
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    );
    assert.equal(XML_DECL.charCodeAt(XML_DECL.length - 1), 10);
  });

  it("leaves element children raw: callers escape text first", () => {
    assert.equal(el("x", [], escText("<")), "<x>&lt;</x>");
    assert.equal(el("x", [], "<"), "<x><</x>");
  });

  it("rejects bad element and attribute names", () => {
    for (const bad of ["a b", "1a", "", "<x>", "a/b"]) {
      assert.throws(
        () => el(bad, [], "t"),
        (e: unknown) =>
          e instanceof OoxmlError && e.code === "E_XML_BAD_NAME",
      );
      assert.throws(
        () => el("ok", [[bad, "v"]], "t"),
        (e: unknown) =>
          e instanceof OoxmlError && e.code === "E_XML_BAD_NAME",
      );
    }
  });
});

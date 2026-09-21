// Safe XML builder for ooxml-core (D-1).
// One rule for everyone (models included): always pass RAW unescaped text.
// The engine escapes it exactly once. Never pre-escape: "Fish && Chips"
// goes in raw and comes out "Fish &amp;&amp; Chips". Text that already
// looks escaped (e.g. "&amp;") is treated as literal text and escaped
// again — by design, so there is exactly one correct way to call this.
// Canonical declaration + self-closing empty elements keep diffs stable.

import { OoxmlError } from "./errors.js";

export const XML_DECL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

// W3C XML 1.0 Char production: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
// Everything else is illegal even as a char ref — reject, never strip silently.
export function assertLegalXmlChars(value: string, field: string): void {
  for (let i = 0; i < value.length; ) {
    const cp = value.codePointAt(i) ?? 0;
    const ok =
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0d ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    if (!ok) {
      throw new OoxmlError(
        "E_XML_ILLEGAL_CHAR",
        `illegal XML char U+${cp.toString(16).toUpperCase().padStart(4, "0")} in ${field}`,
      );
    }
    i += cp > 0xffff ? 2 : 1;
  }
}

export function escText(value: string): string {
  assertLegalXmlChars(value, "text");
  // & first so entity prefixes are not double-escaped.
  // Input is RAW text (see module contract above).
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escAttr(value: string): string {
  assertLegalXmlChars(value, "attr");
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type XmlAttr = readonly [name: string, value: string];

// Names are engine-owned: conservative ASCII subset of the XML Name rule
// (engine prefixes are ASCII). Values are caller-supplied and escaped.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function assertName(name: string, kind: string): void {
  if (!NAME_RE.test(name)) {
    throw new OoxmlError("E_XML_BAD_NAME", `bad XML ${kind} name: ${name}`);
  }
}

// Attrs are an ordered tuple list: engine callers pass canonical order,
// builder preserves it verbatim (no object-key reordering).
export function el(
  name: string,
  attrs: ReadonlyArray<XmlAttr> = [],
  children: string | null = null,
): string {
  assertName(name, "element");
  const attrStr = attrs
    .map(([k, v]) => {
      assertName(k, "attribute");
      return ` ${k}="${escAttr(v)}"`;
    })
    .join("");
  if (children === null) return `<${name}${attrStr}/>`;
  return `<${name}${attrStr}>${children}</${name}>`;
}

export function doc(root: string): string {
  return `${XML_DECL}${root}`;
}

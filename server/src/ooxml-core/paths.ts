// Single shared path canonicalizer for ooxml-core (review fix).
// content-types ("/"-leading part names) and rels/zip (bare ZIP paths)
// previously disagreed on "..", drive letters, and empty segments.
// Now both go through here: toZipPath for ZIP form, toPartName for the
// "/..." Override/PartName form. Anything suspicious is refused loudly.

import { OoxmlError } from "./errors.js";

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])$/i;
const UNSAFE_UNICODE = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

function isWindowsDeviceName(segment: string): boolean {
  const stem = segment.split(".", 1)[0]?.replace(/[ .]+$/g, "") ?? "";
  return WINDOWS_DEVICE_NAME.test(stem);
}

function checkSegments(segs: string[], original: string): void {
  for (const seg of segs) {
    if (seg === "" || seg === ".") {
      throw new OoxmlError("E_ZIP_PATH", `bad segment in path ${original}`);
    }
    if (seg === "..") {
      throw new OoxmlError("E_ZIP_PATH", `.. in segment of ${original}`);
    }
    if (seg.endsWith(".") || seg.endsWith(" ")) {
      throw new OoxmlError("E_ZIP_PATH", `trailing dot or space in ${original}`);
    }
    for (const char of seg) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint < 0x20 || codePoint === 0x7f) {
        throw new OoxmlError("E_ZIP_PATH", `control character in ${original}`);
      }
    }
    if (UNSAFE_UNICODE.test(seg)) {
      throw new OoxmlError("E_ZIP_PATH", `unsafe Unicode in segment of ${original}`);
    }
    if (isWindowsDeviceName(seg)) {
      throw new OoxmlError("E_ZIP_PATH", `reserved device name in ${original}`);
    }
    // "__proto__" is a legal OPC segment but a prototype-pollution vector
    // in plain-object ZIP maps (fflate input, Zod records, unzip output):
    // refuse it here so every consumer (zip, content-types, rels) inherits
    // the guard. "constructor"/"prototype" shadow safely and stay allowed.
    if (seg.toLowerCase() === "__proto__") {
      throw new OoxmlError("E_ZIP_PATH", `reserved segment in path ${original}`);
    }
    if (/^[A-Za-z]:$/.test(seg) || seg.includes(":")) {
      throw new OoxmlError("E_ZIP_PATH", `drive/colon in path ${original}`);
    }
  }
}

// Canonical ZIP form: forward slashes, no leading slash, no ".", no "..",
// no empty segments, no drive letters, no colons.
export function toZipPath(input: string): string {
  if (input !== input.trim()) {
    throw new OoxmlError("E_ZIP_PATH", `surrounding whitespace in path ${input}`);
  }
  const p = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p) throw new OoxmlError("E_ZIP_PATH", "empty part path");
  checkSegments(p.split("/"), input);
  return p;
}

// Canonical PartName form for Overrides: exactly toZipPath with one
// leading slash.
export function toPartName(input: string): string {
  return `/${toZipPath(input)}`;
}

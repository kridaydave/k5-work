// Single shared path canonicalizer for ooxml-core (review fix).
// content-types ("/"-leading part names) and rels/zip (bare ZIP paths)
// previously disagreed on "..", drive letters, and empty segments.
// Now both go through here: toZipPath for ZIP form, toPartName for the
// "/..." Override/PartName form. Anything suspicious is refused loudly.

import { OoxmlError } from "./errors.js";

function checkSegments(segs: string[], original: string): void {
  for (const seg of segs) {
    if (seg === "" || seg === ".") {
      throw new OoxmlError("E_ZIP_PATH", `bad segment in path ${original}`);
    }
    if (seg === "..") {
      throw new OoxmlError("E_ZIP_PATH", `.. in path ${original}`);
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

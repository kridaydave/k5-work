// Content-type table for ooxml-core (D-2).
// The engine owns the whole table: one Default per extension (sorted),
// one Override per part (sorted). Unknown extensions resolve to null —
// the engine never guesses from the OS MIME map, the validator fails
// closed instead (this is the duplicate-Default repair-dialog bug class).
// Part names go through the shared paths.ts canonicalizer, so "..",
// drive letters, and empty segments are refused here exactly as in rels.

import { OoxmlError } from "./errors.js";
import { toPartName } from "./paths.js";
import { doc, el } from "./xml.js";

export const CT_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";

function normExt(extension: string): string {
  const ext = extension.trim().toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

// RFC 2616 media-type shape (OPC M1.13/M1.14): token "/" token with
// optional ";attr=value" params, no whitespace outside quoted param
// values, no comments. OOXML types never need params; quoted values
// stay supported so valid-but-unusual types are not refused.
const TOKEN = `[!#$%&'*+\\-.^_\`|~0-9A-Za-z]+`;
const QUOTED = `"(?:[^"\\\\]|\\\\.)*"`;
const CONTENT_TYPE_RE = new RegExp(
  `^${TOKEN}/${TOKEN}(?:;${TOKEN}=(?:${TOKEN}|${QUOTED}))*$`,
);

function assertContentType(contentType: string, what: string): void {
  if (!CONTENT_TYPE_RE.test(contentType)) {
    throw new OoxmlError(
      "E_CONTENTTYPE_BAD_TYPE",
      `invalid content type for ${what}: ${contentType}`,
    );
  }
}

interface OverrideEntry {
  readonly name: string;
  readonly type: string;
}

export interface ContentTypeDefault {
  readonly extension: string;
  readonly contentType: string;
}

export interface ContentTypeOverride {
  readonly partName: string;
  readonly contentType: string;
}

export class ContentTypes {
  private readonly defaults = new Map<string, string>();
  private readonly overrides = new Map<string, OverrideEntry>();

  addDefault(extension: string, contentType: string): void {
    const ext = normExt(extension);
    if (!ext) {
      throw new OoxmlError("E_CONTENTTYPE_BAD_EXT", "empty extension");
    }
    assertContentType(contentType, `extension ".${ext}"`);
    const prev = this.defaults.get(ext);
    if (prev === undefined) {
      this.defaults.set(ext, contentType);
      return;
    }
    if (prev !== contentType) {
      throw new OoxmlError(
        "E_CONTENTTYPE_DUP_DEFAULT",
        `extension ".${ext}" already maps to ${prev}, refusing ${contentType}`,
      );
    }
  }

  addOverride(partName: string, contentType: string): void {
    const name = toPartName(partName);
    assertContentType(contentType, `part ${name}`);
    const prev = this.overrides.get(name.toLowerCase());
    if (prev === undefined) {
      this.overrides.set(name.toLowerCase(), { name, type: contentType });
      return;
    }
    if (prev.type !== contentType) {
      throw new OoxmlError(
        "E_CONTENTTYPE_DUP_OVERRIDE",
        `part ${name} already maps to ${prev.type}, refusing ${contentType}`,
      );
    }
  }

  // Override wins (ASCII case-insensitive), else Default by the extension
  // of the last path segment, else null — never a guess.
  resolve(partName: string): string | null {
    const name = toPartName(partName);
    const over = this.overrides.get(name.toLowerCase());
    if (over !== undefined) return over.type;
    const seg = name.slice(name.lastIndexOf("/") + 1);
    const dot = seg.lastIndexOf(".");
    if (dot < 0) return null;
    return this.defaults.get(seg.slice(dot + 1).toLowerCase()) ?? null;
  }

  // Every Override must point at a part actually in the package.
  // A dangling Override alone triggers the PowerPoint repair dialog.
  assertNoOrphans(partNames: Iterable<string>): void {
    const known = new Set<string>();
    for (const p of partNames) known.add(toPartName(p).toLowerCase());
    for (const { name } of this.overrides.values()) {
      if (!known.has(name.toLowerCase())) {
        throw new OoxmlError(
          "E_CONTENTTYPE_ORPHAN_OVERRIDE",
          `override for missing part ${name}`,
        );
      }
    }
  }

  // Snapshot readers for the D-4 validator (tables stay private).
  defaultEntries(): ContentTypeDefault[] {
    return [...this.defaults.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([extension, contentType]) => ({ extension, contentType }));
  }

  overrideEntries(): ContentTypeOverride[] {
    return [...this.overrides.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(({ name, type }) => ({ partName: name, contentType: type }));
  }

  buildXml(): string {
    const children =
      this.defaultEntries()
        .map(({ extension, contentType }) =>
          el("Default", [
            ["Extension", extension],
            ["ContentType", contentType],
          ]),
        )
        .join("") +
      this.overrideEntries()
        .map(({ partName, contentType }) =>
          el("Override", [
            ["PartName", partName],
            ["ContentType", contentType],
          ]),
        )
        .join("");
    return doc(el("Types", [["xmlns", CT_NS]], children));
  }
}

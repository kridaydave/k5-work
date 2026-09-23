// Relationship IDs + .rels serialization (D-2).
// rIds are unique per .rels scope, never global: each .rels file owns
// its own rId1…rIdN counter, so the same rId may legally appear in two
// different scopes. TargetMode is omitted for internal targets
// (canonical form — it defaults to Internal) and emitted only for
// external ones such as hyperlinks. Paths go through the shared paths.ts
// canonicalizer, so "..", drive letters, and empty segments are refused
// exactly as in content-types.

import { OoxmlError } from "./errors.js";
import { toZipPath } from "./paths.js";
import { doc, el } from "./xml.js";
import type { XmlAttr } from "./xml.js";

export const RELS_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export const PACKAGE_RELS_PATH = "_rels/.rels";

export type RelTargetMode = "internal" | "external";

export interface RelEntry {
  readonly rId: string;
  readonly type: string;
  readonly target: string;
  readonly mode: RelTargetMode;
}

// Canonical package path (kept for compatibility; delegates to paths.ts).
export function normalizePartPath(path: string): string {
  return toZipPath(path);
}

// Part rels live beside their part: insert _rels/ before the last
// segment and append .rels. Package rels use PACKAGE_RELS_PATH.
export function relsPathForPart(partName: string): string {
  const norm = toZipPath(partName);
  const slash = norm.lastIndexOf("/");
  return slash < 0
    ? `_rels/${norm}.rels`
    : `${norm.slice(0, slash)}/_rels/${norm.slice(slash + 1)}.rels`;
}

function normalizeSegments(path: string, original: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) {
        throw new OoxmlError(
          "E_REL_BAD_TARGET",
          `target escapes the package: ${original}`,
        );
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

const ABS_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// Any single-letter-colon lead is a drive ("C:/…", "C:foo"), never an
// external IRI: single-letter URI schemes are vanishingly rare and OPC
// paths must not contain drive letters unconditionally.
const DRIVE = /^[A-Za-z]:/;

// Absolute-IRI test for rel targets. Drive letters ("C:/…") match the IRI
// shape but are NOT external — they are rejected before this is consulted.
export function isExternalTarget(target: string): boolean {
  const t = target.replace(/\\/g, "/");
  if (DRIVE.test(t)) return false;
  return t.startsWith("//") || ABS_IRI.test(t);
}

// Resolve an internal rel target against its source part ("." / ".."
// normalized). Absolute IRIs (http:, mailto:, …) are returned as-is;
// external targets never point at package parts.
export function resolveRelTarget(sourcePart: string, target: string): string {
  if (!target) throw new OoxmlError("E_REL_BAD_TARGET", "empty rel target");
  const t = target.replace(/\\/g, "/");
  if (DRIVE.test(t)) {
    throw new OoxmlError("E_REL_BAD_TARGET", `drive-letter target: ${target}`);
  }
  if (isExternalTarget(target)) return target;
  if (t.startsWith("/")) return requireNonEmpty(normalizeSegments(t.slice(1), target), target);
  const src = toZipPath(sourcePart);
  const slash = src.lastIndexOf("/");
  const base = slash < 0 ? "" : src.slice(0, slash + 1);
  return requireNonEmpty(normalizeSegments(base + t, target), target);
}

// Package-level rels resolve against the package root (their .rels lives
// at _rels/.rels); part rels resolve against their source part instead.
export function resolvePackageRelTarget(target: string): string {
  if (!target) throw new OoxmlError("E_REL_BAD_TARGET", "empty rel target");
  const t = target.replace(/\\/g, "/");
  if (DRIVE.test(t)) {
    throw new OoxmlError("E_REL_BAD_TARGET", `drive-letter target: ${target}`);
  }
  if (isExternalTarget(target)) return target;
  const stripped = t.startsWith("/") ? t.slice(1) : t;
  return requireNonEmpty(normalizeSegments(stripped, target), target);
}

function requireNonEmpty(resolved: string, target: string): string {
  if (!resolved) {
    throw new OoxmlError("E_REL_BAD_TARGET", `empty resolved target for: ${target}`);
  }
  return resolved;
}

export class RelScope {
  private next = 1;
  private readonly stored: RelEntry[] = [];

  constructor(readonly relsPath: string) {
    toZipPath(relsPath);
  }

  add(
    type: string,
    target: string,
    mode: RelTargetMode = "internal",
  ): RelEntry {
    if (!type) throw new OoxmlError("E_REL_BAD_TARGET", "empty rel type");
    if (!target) throw new OoxmlError("E_REL_BAD_TARGET", "empty rel target");
    assertModeMatchesTarget(mode, target);
    const entry: RelEntry = { rId: `rId${this.next++}`, type, target, mode };
    this.stored.push(entry);
    return entry;
  }

  get entries(): ReadonlyArray<RelEntry> {
    return this.stored;
  }

  buildXml(): string {
    return buildRelsXml(this.stored);
  }
}

function assertModeMatchesTarget(mode: RelTargetMode, target: string): void {
  if (
    mode === "internal" &&
    (isExternalTarget(target) || DRIVE.test(target.replace(/\\/g, "/")))
  ) {
    throw new OoxmlError(
      "E_REL_BAD_TARGET",
      `internal rel points outside the package: ${target}`,
    );
  }
  if (mode === "external" && DRIVE.test(target.replace(/\\/g, "/"))) {
    throw new OoxmlError(
      "E_REL_BAD_TARGET",
      `external rel has a drive-letter target: ${target}`,
    );
  }
}

// Write-time gate: duplicate Ids within one .rels scope and mode/target
// mismatches are refused here — never packed. Escape-outside-package is
// resolved against source context and refused by the validator.
export function buildRelsXml(rels: ReadonlyArray<RelEntry>): string {
  const seen = new Set<string>();
  const children = rels
    .map((r) => {
      if (seen.has(r.rId)) {
        throw new OoxmlError("E_REL_DUP_RID", `duplicate ${r.rId}`);
      }
      seen.add(r.rId);
      assertModeMatchesTarget(r.mode, r.target);
      const attrs: XmlAttr[] = [
        ["Id", r.rId],
        ["Type", r.type],
        ["Target", r.target],
      ];
      if (r.mode === "external") attrs.push(["TargetMode", "External"]);
      return el("Relationship", attrs);
    })
    .join("");
  return doc(el("Relationships", [["xmlns", RELS_NS]], children));
}

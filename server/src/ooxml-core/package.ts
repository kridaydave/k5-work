// Create-only OPC package assembler for ooxml-core (D-3).
// JSON-in (OoxmlPackageSpec from shared, Zod-validated at the boundary),
// engine-out: the engine owns the content-type table, rId allocation,
// .rels serialization, entry order, and ZIP bytes. Write-time gates
// refuse bad input here — duplicate parts, dangling rel targets, bad
// content types — so illegal-OPC bytes are never packed.

import { OoxmlPackageSpecSchema } from "@k5-work/shared";
import type { OoxmlPackageSpec } from "@k5-work/shared";
import { ContentTypes } from "./content-types.js";
import { OoxmlError } from "./errors.js";
import { toZipPath } from "./paths.js";
import {
  isExternalTarget,
  PACKAGE_RELS_PATH,
  RelScope,
  relsPathForPart,
  resolvePackageRelTarget,
  resolveRelTarget,
} from "./rels.js";
import { assertLegalXmlChars } from "./xml.js";
import { ZipWriter } from "./zip.js";

export const CONTENT_TYPES_PATH = "[Content_Types].xml";

const RELS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";
const XML_CONTENT_TYPE = "application/xml";

// Already-compressed payloads must not be Deflated again (wasted potato
// CPU, larger output). v1 parts are XML strings, so this only keys off
// the extension — binary media arrives with later drivers.
const STORED_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

function compressionLevel(partName: string): 0 | 6 {
  const seg = partName.slice(partName.lastIndexOf("/") + 1);
  const dot = seg.lastIndexOf(".");
  const ext = dot < 0 ? "" : seg.slice(dot + 1).toLowerCase();
  return STORED_EXTENSIONS.has(ext) ? 0 : 6;
}

interface CanonicalPart {
  readonly name: string;
  readonly contentType: string;
  readonly xml: string;
}

// Zod records silently drop "__proto__" keys, so a declared partRels
// source would vanish without error. Pre-scan the raw input and refuse
// loudly instead (part *names* travel in an array and reach toZipPath,
// which refuses the segment there).
function assertNoProtoKeys(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  const rels = (input as { partRels?: unknown }).partRels;
  if (typeof rels !== "object" || rels === null) return;
  for (const key of Object.keys(rels)) {
    if (key.toLowerCase() === "__proto__") {
      throw new OoxmlError(
        "E_REL_BAD_TARGET",
        "reserved rel source: __proto__",
      );
    }
  }
}

export class PackageBuilder {
  private readonly spec: OoxmlPackageSpec;

  private constructor(spec: OoxmlPackageSpec) {
    this.spec = spec;
  }

  // Sole entry point: validates the JSON-in payload (ZodError on drift,
  // never a silent null write) and reserves the shape for D-4+.
  static parse(input: unknown): PackageBuilder {
    assertNoProtoKeys(input);
    return new PackageBuilder(OoxmlPackageSpecSchema.parse(input));
  }

  // Runs every write-time gate, then packs. Deterministic: same spec in,
  // same bytes out (sorted entries, pinned mtime, fixed levels).
  build(): Uint8Array {
    const parts = this.canonicalParts();
    const table = new ContentTypes();
    table.addDefault("rels", RELS_CONTENT_TYPE);
    table.addDefault("xml", XML_CONTENT_TYPE);
    for (const p of parts.values()) table.addOverride(p.name, p.contentType);

    const packageScope = new RelScope(PACKAGE_RELS_PATH);
    for (const r of this.spec.packageRels) {
      this.assertTargetLive(parts, resolvePackageRelTarget(r.target), r.target);
      packageScope.add(r.type, r.target, r.mode);
    }

    const partScopes = new Map<string, RelScope>();
    for (const [source, rels] of Object.entries(this.spec.partRels)) {
      const canonical = this.canonicalSource(parts, source);
      const scope =
        partScopes.get(canonical) ?? new RelScope(relsPathForPart(canonical));
      for (const r of rels) {
        this.assertTargetLive(
          parts,
          resolveRelTarget(canonical, r.target),
          r.target,
        );
        scope.add(r.type, r.target, r.mode);
      }
      partScopes.set(canonical, scope);
    }

    // Engine-owned paths collide with caller parts: refuse, never merge.
    const reserved = new Set<string>([
      CONTENT_TYPES_PATH.toLowerCase(),
      PACKAGE_RELS_PATH.toLowerCase(),
    ]);
    for (const scope of partScopes.values()) {
      reserved.add(scope.relsPath.toLowerCase());
    }
    for (const p of parts.values()) {
      if (reserved.has(p.name.toLowerCase())) {
        throw new OoxmlError(
          "E_PACKAGE_DUP_PART",
          `part collides with an engine path: ${p.name}`,
        );
      }
    }
    table.assertNoOrphans([...parts.values()].map((p) => p.name));

    const zip = new ZipWriter();
    zip.add(CONTENT_TYPES_PATH, table.buildXml());
    zip.add(PACKAGE_RELS_PATH, packageScope.buildXml());
    // No sort here: ZipWriter.build() sorts by UTF-8 bytes, which already
    // yields the canonical table → rels → parts order.
    for (const scope of partScopes.values()) {
      zip.add(scope.relsPath, scope.buildXml());
    }
    for (const p of parts.values()) {
      zip.add(p.name, p.xml, { level: compressionLevel(p.name) });
    }
    return zip.build();
  }

  // Canonical ZIP names keyed case-insensitively (OPC equivalence):
  // first spelling wins, later variants are duplicates.
  private canonicalParts(): Map<string, CanonicalPart> {
    const parts = new Map<string, CanonicalPart>();
    for (const raw of this.spec.parts) {
      const name = toZipPath(raw.name);
      const folded = name.toLowerCase();
      if (parts.has(folded)) {
        throw new OoxmlError("E_PACKAGE_DUP_PART", `duplicate part: ${name}`);
      }
      assertLegalXmlChars(raw.xml, `part ${name}`);
      parts.set(folded, { name, contentType: raw.contentType, xml: raw.xml });
    }
    return parts;
  }

  private canonicalSource(
    parts: Map<string, CanonicalPart>,
    source: string,
  ): string {
    const name = toZipPath(source);
    const hit = parts.get(name.toLowerCase());
    if (hit === undefined) {
      throw new OoxmlError(
        "E_REL_BAD_TARGET",
        `part rels for unknown part: ${source}`,
      );
    }
    return hit.name;
  }

  // Internal targets must name a part in this package (orphaned r:id is
  // the classic repair-dialog bug); external IRIs point outside by design.
  private assertTargetLive(
    parts: Map<string, CanonicalPart>,
    resolved: string,
    original: string,
  ): void {
    if (isExternalTarget(original)) return;
    if (!parts.has(resolved.toLowerCase())) {
      throw new OoxmlError(
        "E_REL_DANGLING_REF",
        `rel target not in package: ${original}`,
      );
    }
  }
}

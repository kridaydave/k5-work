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

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

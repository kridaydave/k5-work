// The writer: the document model in, a .docx byte array out. This layer owns
// the package and nothing else: rIds, relationship order, content types and the
// ZIP bytes all stay in the engine.
import { DocxDocumentSchema, type DocxDocument } from "@k5-work/shared";
import { PackageBuilder } from "../ooxml-core/package.js";
import type { PackageSpecInput } from "../ooxml-core/validate.js";
import { buildCoreXml, buildStylesXml } from "./parts.js";
import {
  CORE_CT,
  CORE_PART,
  CORE_PROPS_REL,
  DOC_MAIN_CT,
  MAIN_PART,
  OFFICE_DOC_REL,
  STYLES_CT,
  STYLES_PART,
  STYLES_REL,
} from "./names.js";
import { buildDocumentXml } from "./vocabulary.js";

/**
 * Every part is pointed at by a relationship, because the engine now refuses a
 * part nothing reaches: a package with word/styles.xml in it that no reader
 * ever opens is exactly the silent failure this driver exists to prevent.
 */
export function buildPackageSpec(document: DocxDocument): PackageSpecInput {
  return {
    parts: [
      { name: MAIN_PART, contentType: DOC_MAIN_CT, xml: buildDocumentXml(document) },
      { name: STYLES_PART, contentType: STYLES_CT, xml: buildStylesXml() },
      { name: CORE_PART, contentType: CORE_CT, xml: buildCoreXml(document) },
    ],
    packageRels: [
      { type: OFFICE_DOC_REL, target: MAIN_PART },
      { type: CORE_PROPS_REL, target: CORE_PART },
    ],
    partRels: {
      [MAIN_PART]: [{ type: STYLES_REL, target: "styles.xml" }],
    },
  };
}

/**
 * Accepts the raw JSON a harness emits and validates it at the boundary, so a
 * bad document is a loud ZodError naming the field rather than a .docx that
 * opens wrong. Deterministic: the same input gives the same bytes.
 */
export function buildDocx(input: unknown): Uint8Array {
  const document = DocxDocumentSchema.parse(input);
  return PackageBuilder.parse(buildPackageSpec(document)).build({
    mainRelationship: { type: OFFICE_DOC_REL, target: MAIN_PART },
  });
}
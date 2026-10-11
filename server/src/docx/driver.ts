// The writer: the document model in, a .docx byte array out. This layer owns
// the package and nothing else: rIds, relationship order, content types and the
// ZIP bytes all stay in the engine.
import { DocxDocumentSchema, type DocxDocument } from "@k5-work/shared";
import { PackageBuilder } from "../ooxml-core/package.js";
import type { PackageSpecInput, SpecRel } from "../ooxml-core/validate.js";
import { buildCoreXml, buildStylesXml } from "./parts.js";
import {
  CORE_CT,
  CORE_PART,
  CORE_PROPS_REL,
  DOC_MAIN_CT,
  MAIN_PART,
  NUMBERING_CT,
  NUMBERING_PART,
  NUMBERING_REL,
  OFFICE_DOC_REL,
  STYLES_CT,
  STYLES_PART,
  STYLES_REL,
} from "./names.js";
import { buildNumberingXml } from "./numbering.js";
import { buildDocumentXml } from "./vocabulary.js";

/**
 * Every part is pointed at by a relationship, because the engine now refuses a
 * part nothing reaches: a package with word/styles.xml in it that no reader
 * ever opens is exactly the silent failure this driver exists to prevent.
 *
 * Numbering is a part relationship from the main document, not a package one.
 * The document is what consumes the list, and a reader that finds no numbering
 * relationship there drops the part and renders the paragraphs as plain text,
 * with the text still reading correctly and nothing complaining. Measured:
 * with the relationship at package level, LibreOffice imports every list as
 * plain paragraphs.
 */
export function buildPackageSpec(document: DocxDocument): PackageSpecInput {
  const numbering = buildNumberingXml(document.blocks);
  const parts: PackageSpecInput["parts"][number][] = [
    { name: MAIN_PART, contentType: DOC_MAIN_CT, xml: buildDocumentXml(document) },
    { name: STYLES_PART, contentType: STYLES_CT, xml: buildStylesXml() },
    { name: CORE_PART, contentType: CORE_CT, xml: buildCoreXml(document) },
  ];
  const partRels: SpecRel[] = [{ type: STYLES_REL, target: "styles.xml" }];
  if (numbering !== null) {
    parts.push({ name: NUMBERING_PART, contentType: NUMBERING_CT, xml: numbering });
    partRels.push({ type: NUMBERING_REL, target: "numbering.xml" });
  }
  return {
    parts,
    packageRels: [
      { type: OFFICE_DOC_REL, target: MAIN_PART },
      { type: CORE_PROPS_REL, target: CORE_PART },
    ],
    partRels: {
      [MAIN_PART]: partRels,
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
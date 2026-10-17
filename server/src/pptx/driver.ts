import { PptxPresentationSchema, type PptxPresentation } from "@k5-work/shared";
import { PackageBuilder } from "../ooxml-core/package.js";
import type { PackageSpecInput, SpecRel } from "../ooxml-core/validate.js";
import { buildCoreXml, buildLayoutXml, buildMasterXml, buildThemeXml } from "./parts.js";
import { buildPresentationXml, buildSlideXml } from "./vocabulary.js";
import {
  CORE_CT,
  CORE_PART,
  CORE_PROPS_REL,
  LAYOUT_CT,
  LAYOUT_PART,
  MAIN_PART,
  MASTER_CT,
  MASTER_PART,
  OFFICE_DOC_REL,
  PPT_MAIN_CT,
  SLIDE_CT,
  SLIDE_LAYOUT_REL,
  SLIDE_MASTER_REL,
  SLIDE_REL,
  THEME_CT,
  THEME_PART,
  THEME_REL,
  slidePart,
} from "./names.js";

export function buildPackageSpec(presentation: PptxPresentation): PackageSpecInput {
  const slides = presentation.slides;
  const parts: PackageSpecInput["parts"][number][] = [
    { name: MAIN_PART, contentType: PPT_MAIN_CT, xml: buildPresentationXml(presentation) },
    { name: MASTER_PART, contentType: MASTER_CT, xml: buildMasterXml() },
    { name: LAYOUT_PART, contentType: LAYOUT_CT, xml: buildLayoutXml() },
    { name: THEME_PART, contentType: THEME_CT, xml: buildThemeXml() },
    { name: CORE_PART, contentType: CORE_CT, xml: buildCoreXml(presentation) },
  ];
  for (let i = 0; i < slides.length; i += 1) {
    parts.push({ name: slidePart(i), contentType: SLIDE_CT, xml: buildSlideXml(slides[i]) });
  }

  const partRels: Record<string, SpecRel[]> = {};
  const presentationRels: SpecRel[] = [
    { type: THEME_REL, target: "theme/theme1.xml" },
    { type: SLIDE_MASTER_REL, target: "slideMasters/slideMaster1.xml" },
  ];
  for (let i = 0; i < slides.length; i += 1) {
    presentationRels.push({ type: SLIDE_REL, target: `slides/slide${String(i + 1)}.xml` });
  }
  partRels[MAIN_PART] = presentationRels;

  partRels[MASTER_PART] = [
    { type: THEME_REL, target: "../theme/theme1.xml" },
    { type: SLIDE_LAYOUT_REL, target: "../slideLayouts/slideLayout1.xml" },
  ];
  partRels[LAYOUT_PART] = [
    { type: SLIDE_MASTER_REL, target: "../slideMasters/slideMaster1.xml" },
  ];
  for (let i = 0; i < slides.length; i += 1) {
    partRels[slidePart(i)] = [
      { type: SLIDE_LAYOUT_REL, target: "../slideLayouts/slideLayout1.xml" },
    ];
  }

  return {
    parts,
    packageRels: [
      { type: OFFICE_DOC_REL, target: MAIN_PART },
      { type: CORE_PROPS_REL, target: CORE_PART },
    ],
    partRels,
  };
}

export function buildPptx(input: unknown): Uint8Array {
  const presentation = PptxPresentationSchema.parse(input);
  return PackageBuilder.parse(buildPackageSpec(presentation)).build({
    mainRelationship: { type: OFFICE_DOC_REL, target: MAIN_PART },
  });
}

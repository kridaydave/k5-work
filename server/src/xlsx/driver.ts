import { XlsxWorkbookSchema, type XlsxWorkbook } from "@k5-work/shared";
import { PackageBuilder } from "../ooxml-core/package.js";
import type { PackageSpecInput } from "../ooxml-core/validate.js";
import {
  CORE_CT,
  CORE_PART,
  MAIN_PART,
  OFFICE_DOC_REL,
  CORE_PROPS_REL,
  SHARED_STRINGS_CT,
  SHARED_STRINGS_PART,
  SHARED_STRINGS_REL,
  STYLES_CT,
  STYLES_PART,
  STYLES_REL,
  WORKBOOK_CT,
  WORKSHEET_CT,
  WORKSHEET_REL,
} from "./names.js";
import {
  buildCoreXml,
  buildSharedStringsXml,
  buildSheetXml,
  buildStylesXml,
  buildWorkbookXml,
} from "./parts.js";

export function buildPackageSpec(workbook: XlsxWorkbook): PackageSpecInput {
  const shared: string[] = [];
  const sharedIndex = (text: string): number => {
    const i = shared.indexOf(text);
    if (i >= 0) return i;
    shared.push(text);
    return shared.length - 1;
  };

  const parts: PackageSpecInput["parts"][number][] = [
    { name: MAIN_PART, contentType: WORKBOOK_CT, xml: buildWorkbookXml(workbook) },
    { name: STYLES_PART, contentType: STYLES_CT, xml: buildStylesXml() },
    { name: SHARED_STRINGS_PART, contentType: SHARED_STRINGS_CT, xml: buildSharedStringsXml(shared) },
    { name: CORE_PART, contentType: CORE_CT, xml: buildCoreXml(workbook) },
  ];

  // Need sheet xml built after shared strings collected; but sharedIndex mutates shared.
  // Build sheet parts now, collecting strings.
  const sheetParts = workbook.sheets.map((sheet, i) => ({
    name: `xl/worksheets/sheet${String(i + 1)}.xml`,
    xml: buildSheetXml(sheet, sharedIndex),
  }));
  // Rebuild shared strings part with collected strings.
  parts[2] = { name: SHARED_STRINGS_PART, contentType: SHARED_STRINGS_CT, xml: buildSharedStringsXml(shared) };
  for (const sp of sheetParts) {
    parts.push({ name: sp.name, contentType: WORKSHEET_CT, xml: sp.xml });
  }

  const partRels: { type: string; target: string }[] = [];
  workbook.sheets.forEach((_, i) => {
    partRels.push({ type: WORKSHEET_REL, target: `worksheets/sheet${String(i + 1)}.xml` });
  });
  partRels.push({ type: SHARED_STRINGS_REL, target: "sharedStrings.xml" });
  partRels.push({ type: STYLES_REL, target: "styles.xml" });

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

export function buildXlsx(input: unknown): Uint8Array {
  const workbook = XlsxWorkbookSchema.parse(input);
  return PackageBuilder.parse(buildPackageSpec(workbook)).build({
    mainRelationship: { type: OFFICE_DOC_REL, target: MAIN_PART },
  });
}
export const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const CP_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
export const DC_NS = "http://purl.org/dc/elements/1.1/";
export const DCTERMS_NS = "http://purl.org/dc/terms/";
export const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

export const MAIN_PART = "ppt/presentation.xml";
export const CORE_PART = "docProps/core.xml";
export const THEME_PART = "ppt/theme/theme1.xml";
export const MASTER_PART = "ppt/slideMasters/slideMaster1.xml";
export const LAYOUT_PART = "ppt/slideLayouts/slideLayout1.xml";

export function slidePart(index: number): string {
  return `ppt/slides/slide${String(index + 1)}.xml`;
}

export const PPT_MAIN_CT =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
export const SLIDE_CT =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
export const MASTER_CT =
  "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
export const LAYOUT_CT =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
export const THEME_CT =
  "application/vnd.openxmlformats-officedocument.theme+xml";
export const CORE_CT = "application/vnd.openxmlformats-package.core-properties+xml";

export const OFFICE_DOC_REL = `${R_NS}/officeDocument`;
export const SLIDE_REL = `${R_NS}/slide`;
export const SLIDE_MASTER_REL = `${R_NS}/slideMaster`;
export const SLIDE_LAYOUT_REL = `${R_NS}/slideLayout`;
export const THEME_REL = `${R_NS}/theme`;
export const CORE_PROPS_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

export const FIXED_TIMESTAMP = "2026-01-01T00:00:00Z";

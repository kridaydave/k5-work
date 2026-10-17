export const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const CP_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
export const DC_NS = "http://purl.org/dc/elements/1.1/";
export const DCTERMS_NS = "http://purl.org/dc/terms/";
export const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

export const MAIN_PART = "xl/workbook.xml";
export const STYLES_PART = "xl/styles.xml";
export const SHARED_STRINGS_PART = "xl/sharedStrings.xml";
export const CORE_PART = "docProps/core.xml";

export const WORKBOOK_CT =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
export const WORKSHEET_CT =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
export const STYLES_CT =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
export const SHARED_STRINGS_CT =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
export const CORE_CT = "application/vnd.openxmlformats-package.core-properties+xml";

export const OFFICE_DOC_REL = `${RELS_NS}/officeDocument`;
export const WORKSHEET_REL = `${RELS_NS}/worksheet`;
export const STYLES_REL = `${RELS_NS}/styles`;
export const SHARED_STRINGS_REL = `${RELS_NS}/sharedStrings`;
export const CORE_PROPS_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

export const FIXED_TIMESTAMP = "2026-01-01T00:00:00Z";
// Names the driver emits. Split out from the builders so the vocabulary and
// the writer can be tested apart, and so there is exactly one place where a
// namespace, content type or relationship type is spelled.

// WordprocessingML and the package namespaces.
export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const CP_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
export const DC_NS = "http://purl.org/dc/elements/1.1/";
export const DCTERMS_NS = "http://purl.org/dc/terms/";
export const DCMITYPE_NS = "http://purl.org/dc/dcmitype/";
export const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

export const MAIN_PART = "word/document.xml";
export const STYLES_PART = "word/styles.xml";
export const NUMBERING_PART = "word/numbering.xml";
export const CORE_PART = "docProps/core.xml";

// Content types are per part, not per extension, for all three of these. The
// engine owns the Default/Override table and refuses a part nothing covers.
export const DOC_MAIN_CT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
export const STYLES_CT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
export const NUMBERING_CT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
export const CORE_CT = "application/vnd.openxmlformats-package.core-properties+xml";

export const OFFICE_DOC_REL = `${RELS_NS}/officeDocument`;
export const STYLES_REL = `${RELS_NS}/styles`;
export const NUMBERING_REL = `${RELS_NS}/numbering`;
export const CORE_PROPS_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

/**
 * w:pStyle carries the styleId, never the w:name. For the built-in heading the
 * name is "heading 1" lowercased with a space and the id is "Heading1", so a
 * reference written as w:val="heading 1" resolves to nothing and the heading
 * silently becomes body text.
 */
export const STYLE_IDS = {
  normal: "Normal",
  title: "Title",
  quote: "Quote",
  heading1: "Heading1",
  heading2: "Heading2",
  heading3: "Heading3",
  code: "CodeBlockChar",
  tableGrid: "TableGrid",
} as const;

/**
 * Fixed so the same JSON always produces the same bytes. Same-JSON-same-bytes is
 * what the ZIP writer's determinism promise rests on, and an accurate
 * timestamp is worth less here than that promise. Deliberately not a Date.
 */
export const FIXED_TIMESTAMP = "2026-01-01T00:00:00Z";

/** Letter page, one inch all round, in twips. Matches the D-5 proof fixture. */
export const PAGE_WIDTH = "12240";
export const PAGE_HEIGHT = "15840";
export const PAGE_MARGIN = "1440";
export const HEADER_MARGIN = "720";
export const FOOTER_MARGIN = "720";
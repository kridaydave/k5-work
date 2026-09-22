// ooxml-core public surface (D-1 + D-2 + D-3; D-4+ adds validator).
export { OoxmlError } from "./errors.js";
export type { OoxmlErrorCode } from "./errors.js";
export { XML_DECL, assertLegalXmlChars, doc, el, escAttr, escText } from "./xml.js";
export type { XmlAttr } from "./xml.js";
export { ContentTypes, CT_NS } from "./content-types.js";
export type { ContentTypeDefault, ContentTypeOverride } from "./content-types.js";
export { toPartName, toZipPath } from "./paths.js";
export {
  buildRelsXml,
  isExternalTarget,
  normalizePartPath,
  PACKAGE_RELS_PATH,
  RELS_NS,
  RelScope,
  relsPathForPart,
  resolveRelTarget,
} from "./rels.js";
export type { RelEntry, RelTargetMode } from "./rels.js";

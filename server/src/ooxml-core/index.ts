// ooxml-core public surface (D-1 through D-4).
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
  resolvePackageRelTarget,
  resolveRelTarget,
} from "./rels.js";
export type { RelEntry, RelTargetMode } from "./rels.js";
export { ZipWriter, PINNED_MTIME, DEFAULT_LEVEL } from "./zip.js";
export type { ZipAddOptions } from "./zip.js";
export { PackageBuilder, CONTENT_TYPES_PATH } from "./package.js";
export { assertValid, validateSpec, validateZipBytes } from "./validate.js";
export type {
  IssueKind,
  PackageSpecInput,
  SpecPart,
  SpecRel,
  SpecValidateOptions,
  ValidationIssue,
  ValidationResult,
  ZipValidateOptions,
} from "./validate.js";

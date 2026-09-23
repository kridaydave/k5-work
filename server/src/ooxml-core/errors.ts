// Typed error for ooxml-core. Codes stay stable for validator + tests.

export type OoxmlErrorCode =
  | "E_XML_ILLEGAL_CHAR"
  | "E_XML_BAD_NAME"
  | "E_CONTENTTYPE_DUP_DEFAULT"
  | "E_CONTENTTYPE_DUP_OVERRIDE"
  | "E_CONTENTTYPE_BAD_EXT"
  | "E_CONTENTTYPE_BAD_TYPE"
  | "E_CONTENTTYPE_ORPHAN_OVERRIDE"
  | "E_CONTENTTYPE_UNCOVERED"
  | "E_REL_DUP_RID"
  | "E_REL_DANGLING_REF"
  | "E_REL_BAD_TARGET"
  | "E_ZIP_METHOD"
  | "E_ZIP_GPBIT"
  | "E_ZIP_ZIP64"
  | "E_ZIP_FORMAT"
  | "E_ZIP_CRC"
  | "E_ZIP_PATH"
  | "E_XML_MALFORMED"
  | "E_PACKAGE_MISSING_PART"
  | "E_PACKAGE_DUP_PART"
  | "E_PACKAGE_ORDER";

export class OoxmlError extends Error {
  readonly code: OoxmlErrorCode;

  constructor(code: OoxmlErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "OoxmlError";
    this.code = code;
  }
}

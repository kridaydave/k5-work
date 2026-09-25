import { Inflate } from "fflate";
import { SaxesParser } from "saxes";
import type { SaxesTagNS, XMLDecl } from "saxes";
import { isNameChar, isNameStartChar } from "xmlchars/xml/1.0/ed5.js";
import { CT_NS } from "./content-types.js";
import { OoxmlError } from "./errors.js";
import type { OoxmlErrorCode } from "./errors.js";
import { toZipPath } from "./paths.js";
import {
  isExternalTarget,
  PACKAGE_RELS_PATH,
  RELS_NS,
  relsPathForPart,
  resolveRelTarget,
} from "./rels.js";
import { assertLegalXmlChars } from "./xml.js";
import {
  MAX_ZIP_ARCHIVE_BYTES,
  MAX_ZIP_COMPRESSION_RATIO,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
} from "./limits.js";

export type IssueKind = "spec" | "heuristic";

export interface ValidationIssue {
  readonly code: OoxmlErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly kind: IssueKind;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: ValidationIssue[];
  readonly warnings: ValidationIssue[];
}

export interface SpecPart {
  readonly name: string;
  readonly contentType: string;
  readonly xml: string;
}

export interface SpecRel {
  readonly type: string;
  readonly target: string;
  readonly mode?: "internal" | "external";
}

export interface PackageSpecInput {
  readonly parts: readonly SpecPart[];
  readonly packageRels?: readonly SpecRel[];
  readonly partRels?: Readonly<Record<string, readonly SpecRel[]>>;
}

export interface SpecValidateOptions {
  readonly mainPart?: string;
}

export interface ZipValidateOptions {
  readonly mainPart?: string;
}

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const CONTENT_TYPES_PATH_LOWER = CONTENT_TYPES_PATH.toLowerCase();
const PACKAGE_RELS_PATH_LOWER = PACKAGE_RELS_PATH.toLowerCase();
const RELS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";
const DRIVE_RE = /^[A-Za-z]:/;
const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const CONTENT_TYPE_RE = new RegExp(
  `^${TOKEN}/${TOKEN}(?:;${TOKEN}=(?:${TOKEN}|"(?:[^"\\\\]|\\\\.)*"))*$`,
);
const RELATION_REF_NAMES = new Set(["id", "embed", "link"]);
const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const MAX_XML_DEPTH = 256;
const MAX_XML_ELEMENTS = 100_000;

class XmlLimitError extends Error {}

class Issues {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];

  error(code: OoxmlErrorCode, message: string, path?: string): void {
    this.errors.push(issue(code, message, path, "spec"));
  }

  warn(code: OoxmlErrorCode, message: string, path?: string): void {
    this.warnings.push(issue(code, message, path, "heuristic"));
  }

  result(): ValidationResult {
    return { ok: this.errors.length === 0, errors: this.errors, warnings: this.warnings };
  }
}

function issue(
  code: OoxmlErrorCode,
  message: string,
  path: string | undefined,
  kind: IssueKind,
): ValidationIssue {
  return path === undefined ? { code, message, kind } : { code, message, path, kind };
}

export function assertValid(result: ValidationResult, context = "package"): void {
  const first = result.errors[0];
  if (first !== undefined) {
    throw new OoxmlError(first.code, `${context}: ${first.message}`);
  }
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMediaType(value: string): boolean {
  return CONTENT_TYPE_RE.test(value);
}

function extensionOf(path: string): string | null {
  const segment = path.slice(path.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  if (dot < 0 || dot === segment.length - 1) return null;
  return asciiLower(segment.slice(dot + 1));
}

interface XmlAttribute {
  readonly uri: string;
  readonly local: string;
  readonly value: string;
}

interface XmlElement {
  readonly uri: string;
  readonly local: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: XmlElement[];
  hasText: boolean;
}

interface ParsedXml {
  readonly declaration: XMLDecl;
  readonly root: XmlElement;
}

function parseXml(
  text: string,
  path: string,
  issues: Issues,
): ParsedXml | null {
  try {
    assertLegalXmlChars(text, path);
  } catch (error) {
    issues.error(
      "E_XML_ILLEGAL_CHAR",
      errorMessage(error),
      path,
    );
    return null;
  }

  const parser = new SaxesParser<{ xmlns: true; fileName: string }>({
    xmlns: true,
    fileName: path,
  });
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let firstError: Error | null = null;
  let hasDoctype = false;
  let elementCount = 0;
  let limitMessage = "";

  parser.on("error", (error) => {
    firstError ??= error;
  });
  parser.on("doctype", () => {
    hasDoctype = true;
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    elementCount += 1;
    if (stack.length >= MAX_XML_DEPTH) {
      limitMessage = `XML depth exceeds ${MAX_XML_DEPTH}`;
      throw new XmlLimitError();
    }
    if (elementCount > MAX_XML_ELEMENTS) {
      limitMessage = `XML element count exceeds ${MAX_XML_ELEMENTS}`;
      throw new XmlLimitError();
    }
    const element: XmlElement = {
      uri: tag.uri,
      local: tag.local,
      attributes: Object.values(tag.attributes).map((attribute) => ({
        uri: attribute.uri,
        local: attribute.local,
        value: attribute.value,
      })),
      children: [],
      hasText: false,
    };
    const parent = stack.at(-1);
    if (parent !== undefined) parent.children.push(element);
    else root ??= element;
    stack.push(element);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const appendText = (textChunk: string): void => {
    const parent = stack.at(-1);
    if (parent !== undefined && /[^\t\n\r ]/.test(textChunk)) parent.hasText = true;
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);

  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof XmlLimitError) {
      issues.error("E_XML_LIMIT", limitMessage, path);
      return null;
    }
    firstError ??= error instanceof Error ? error : new Error(String(error));
  }

  if (firstError !== null) {
    issues.error("E_XML_MALFORMED", firstError.message, path);
    return null;
  }
  if (hasDoctype) {
    issues.error("E_XML_MALFORMED", "DTDs are not allowed in OOXML parts", path);
    return null;
  }
  if (root === null) {
    issues.error("E_XML_MALFORMED", "document has no root element", path);
    return null;
  }
  return { declaration: { ...parser.xmlDecl }, root };
}

function attribute(element: XmlElement, local: string, uri = ""): string | undefined {
  return element.attributes.find(
    (candidate) => candidate.local === local && candidate.uri === uri,
  )?.value;
}

function hasNonWhitespaceText(element: XmlElement): boolean {
  return element.hasText;
}

function hasElementChildren(element: XmlElement): boolean {
  return element.children.length > 0 || hasNonWhitespaceText(element);
}

function walk(element: XmlElement, visit: (element: XmlElement) => void): void {
  const pending: XmlElement[] = [element];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    visit(current);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      const child = current.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
}

function relationshipReferences(root: XmlElement): string[] {
  const references: string[] = [];
  walk(root, (element) => {
    for (const attr of element.attributes) {
      if (
        OFFICE_RELATIONSHIP_NAMESPACES.has(attr.uri) &&
        RELATION_REF_NAMES.has(attr.local)
      ) {
        references.push(attr.value);
      }
    }
  });
  return references;
}

interface ContentTypeTables {
  readonly defaults: Map<string, string>;
  readonly overrides: Map<string, { readonly name: string; readonly type: string }>;
}

function parseContentTypes(
  parsed: ParsedXml,
  path: string,
  issues: Issues,
): ContentTypeTables {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, { readonly name: string; readonly type: string }>();
  const root = parsed.root;
  if (root.uri !== CT_NS || root.local !== "Types") {
    issues.error("E_XML_MALFORMED", `${path}: root must be Types in ${CT_NS}`, path);
    return { defaults, overrides };
  }
  if (hasNonWhitespaceText(root)) {
    issues.error("E_XML_MALFORMED", `${path}: Types cannot contain text`, path);
  }

  for (const child of root.children) {
    if (child.uri !== CT_NS || (child.local !== "Default" && child.local !== "Override")) {
      issues.error(
        "E_XML_MALFORMED",
        `${path}: unexpected element ${child.local}`,
        path,
      );
      continue;
    }
    if (hasElementChildren(child)) {
      issues.error("E_XML_MALFORMED", `${path}: ${child.local} must be empty`, path);
      continue;
    }
    const contentType = attribute(child, "ContentType");
    if (contentType === undefined || !isMediaType(contentType)) {
      issues.error(
        "E_CONTENTTYPE_BAD_TYPE",
        `${path}: ${child.local} has invalid ContentType ${contentType ?? ""}`,
        path,
      );
      continue;
    }

    if (child.local === "Default") {
      const extension = attribute(child, "Extension");
      if (
        extension === undefined ||
        extension.length === 0 ||
        extension.startsWith(".") ||
        !new RegExp(`^${TOKEN}$`).test(extension)
      ) {
        issues.error(
          "E_CONTENTTYPE_BAD_EXT",
          `${path}: invalid Default Extension ${extension ?? ""}`,
          path,
        );
        continue;
      }
      const key = asciiLower(extension);
      const previous = defaults.get(key);
      if (previous === undefined) defaults.set(key, contentType);
      else if (previous !== contentType) {
        issues.error(
          "E_CONTENTTYPE_DUP_DEFAULT",
          `${path}: extension .${extension} maps to ${previous} and ${contentType}`,
          path,
        );
      } else {
        issues.error(
          "E_CONTENTTYPE_DUP_DEFAULT",
          `${path}: duplicate Default for .${extension}`,
          path,
        );
      }
      continue;
    }

    const partName = attribute(child, "PartName");
    if (partName === undefined || !partName.startsWith("/")) {
      issues.error(
        "E_ZIP_PATH",
        `${path}: Override PartName must start with /: ${partName ?? ""}`,
        path,
      );
      continue;
    }
    try {
      const zipPath = toZipPath(partName);
      if (zipPath !== partName.slice(1)) {
        issues.error("E_ZIP_PATH", `${path}: non-canonical PartName ${partName}`, path);
        continue;
      }
      const key = asciiLower(zipPath);
      const previous = overrides.get(key);
      const entry = { name: zipPath, type: contentType };
      if (previous === undefined) overrides.set(key, entry);
      else if (previous.type !== contentType) {
        issues.error(
          "E_CONTENTTYPE_DUP_OVERRIDE",
          `${path}: part ${zipPath} maps to ${previous.type} and ${contentType}`,
          path,
        );
      } else {
        issues.error(
          "E_CONTENTTYPE_DUP_OVERRIDE",
          `${path}: duplicate Override for ${zipPath}`,
          path,
        );
      }
    } catch (error) {
      issues.error(
        "E_ZIP_PATH",
        `${path}: ${errorMessage(error)}`,
        path,
      );
    }
  }
  return { defaults, overrides };
}

function contentTypeFor(
  path: string,
  tables: ContentTypeTables,
): string | null {
  const override = tables.overrides.get(asciiLower(path));
  if (override !== undefined) return override.type;
  const extension = extensionOf(path);
  return extension === null ? null : (tables.defaults.get(extension) ?? null);
}

function isXmlContentType(contentType: string): boolean {
  const essence = asciiLower(contentType.split(";", 1)[0]?.trim() ?? "");
  return (
    essence === "application/xml" ||
    essence === "text/xml" ||
    essence.endsWith("+xml")
  );
}

function checkContentTypeCoverage(
  entries: readonly ZipEntry[],
  files: ReadonlyMap<string, string>,
  tables: ContentTypeTables,
  issues: Issues,
): void {

  for (const [key, override] of tables.overrides) {
    const hit = files.get(key);
    if (hit === undefined) {
      issues.error(
        "E_CONTENTTYPE_ORPHAN_OVERRIDE",
        `Override targets missing part /${override.name}`,
      );
    } else if (hit !== override.name) {
      issues.warn(
        "E_CONTENTTYPE_ORPHAN_OVERRIDE",
        `Override /${override.name} differs in case from ${hit}`,
      );
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory || asciiLower(entry.name) === CONTENT_TYPES_PATH_LOWER) continue;
    const type = contentTypeFor(entry.name, tables);
    if (type === null) {
      issues.error(
        "E_CONTENTTYPE_UNCOVERED",
        `${entry.name}: no Default or Override covers this part`,
        entry.name,
      );
    } else if (asciiLower(entry.name).endsWith(".rels") && type !== RELS_CONTENT_TYPE) {
      issues.error(
        "E_CONTENTTYPE_BAD_TYPE",
        `${entry.name}: relationship part has content type ${type}`,
        entry.name,
      );
    }
  }
}



function sourceForRels(path: string): string | null {
  if (asciiLower(path) === PACKAGE_RELS_PATH_LOWER) return "";
  const segments = path.split("/");
  const relsIndex = segments.length - 2;
  if (
    relsIndex < 0 ||
    asciiLower(segments[relsIndex] ?? "") !== "_rels" ||
    !asciiLower(segments.at(-1) ?? "").endsWith(".rels")
  ) {
    return null;
  }
  const relationshipPart = segments.at(-1) ?? "";
  if (relationshipPart.length <= 5) return null;
  return [...segments.slice(0, relsIndex), relationshipPart.slice(0, -5)].join("/");
}

function isNcName(value: string): boolean {
  let first = true;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0x3a) return false;
    if (first ? !isNameStartChar(codePoint) : !isNameChar(codePoint)) return false;
    first = false;
  }
  return !first;
}

function checkInternalTarget(
  label: string,
  source: string,
  target: string,
  files: ReadonlyMap<string, string>,
  issues: Issues,
): void {
  try {
    const resolved = resolveRelTarget(source === "" ? "package" : source, target);
    const hit = files.get(asciiLower(resolved));
    if (hit === undefined) {
      issues.error(
        "E_REL_DANGLING_REF",
        `${label}: target ${target} matches no part`,
        label,
      );
    } else if (hit !== resolved) {
      issues.warn(
        "E_REL_BAD_TARGET",
        `${label}: target ${target} differs in case from ${hit}`,
        label,
      );
    }
  } catch (error) {
    issues.error("E_REL_BAD_TARGET", `${label}: ${errorMessage(error)}`, label);
  }
}

function checkRelationships(
  path: string,
  parsed: ParsedXml,
  source: string,
  files: ReadonlyMap<string, string>,
  issues: Issues,
): Set<string> {
  const ids = new Set<string>();
  const root = parsed.root;
  if (root.uri !== RELS_NS || root.local !== "Relationships") {
    issues.error(
      "E_XML_MALFORMED",
      `${path}: root must be Relationships in ${RELS_NS}`,
      path,
    );
    return ids;
  }
  if (hasNonWhitespaceText(root)) {
    issues.error("E_XML_MALFORMED", `${path}: Relationships cannot contain text`, path);
  }

  for (const child of root.children) {
    if (child.uri !== RELS_NS || child.local !== "Relationship") {
      issues.error(
        "E_XML_MALFORMED",
        `${path}: unexpected element ${child.local}`,
        path,
      );
      continue;
    }
    if (hasElementChildren(child)) {
      issues.error("E_XML_MALFORMED", `${path}: Relationship must be empty`, path);
      continue;
    }
    const id = attribute(child, "Id");
    const type = attribute(child, "Type");
    const target = attribute(child, "Target");
    const mode = attribute(child, "TargetMode") ?? "Internal";
    if (
      id === undefined ||
      id.trim().length === 0 ||
      type === undefined ||
      type.trim().length === 0 ||
      target === undefined ||
      target.length === 0
    ) {
      issues.error(
        "E_REL_BAD_TARGET",
        `${path}: Relationship misses Id, Type, or Target`,
        path,
      );
      continue;
    }
    if (!isNcName(id)) {
      issues.error("E_REL_BAD_TARGET", `${path}: ${id} is not a valid relationship Id`, path);
      continue;
    }
    if (ids.has(id)) {
      issues.error("E_REL_DUP_RID", `${path}: duplicate ${id}`, path);
      continue;
    }
    ids.add(id);
    if (mode !== "Internal" && mode !== "External") {
      issues.error(
        "E_REL_BAD_TARGET",
        `${path}: ${id} has invalid TargetMode ${mode}`,
        path,
      );
      continue;
    }
    const normalizedTarget = target.replace(/\\/g, "/");
    if (DRIVE_RE.test(normalizedTarget)) {
      issues.error(
        "E_REL_BAD_TARGET",
        `${path}: ${id} has drive-letter target ${target}`,
        path,
      );
      continue;
    }
    if (mode === "External") continue;
    if (isExternalTarget(target)) {
      issues.error(
        "E_REL_BAD_TARGET",
        `${path}: ${id} is internal but points outside the package`,
        path,
      );
      continue;
    }
    checkInternalTarget(`${path}: ${id}`, source, target, files, issues);
  }
  return ids;
}

function checkRelationshipReferences(
  documents: ReadonlyMap<string, ParsedXml>,
  scopes: ReadonlyMap<string, Set<string>>,
  issues: Issues,
): void {
  for (const [path, parsed] of documents) {
    const lower = asciiLower(path);
    if (lower === CONTENT_TYPES_PATH_LOWER || lower.endsWith(".rels")) continue;
    const references = relationshipReferences(parsed.root);
    if (references.length === 0) continue;
    let scopePath: string;
    try {
      scopePath = relsPathForPart(path);
    } catch {
      continue;
    }
    const ids = scopes.get(asciiLower(scopePath));
    if (ids === undefined) {
      for (const reference of references) {
        issues.error(
          "E_REL_DANGLING_REF",
          `${path}: ${reference} has no rels scope ${scopePath}`,
          path,
        );
      }
      continue;
    }
    for (const reference of references) {
      if (!ids.has(reference)) {
        issues.error(
          "E_REL_DANGLING_REF",
          `${path}: ${reference} has no entry in ${scopePath}`,
          path,
        );
      }
    }
  }
}

function checkWordOrder(parsed: ParsedXml, path: string, issues: Issues): void {
  walk(parsed.root, (element) => {
    if (!WORD_NAMESPACES.has(element.uri)) return;
    if (element.local === "body") {
      let lastSection = -1;
      for (let index = 0; index < element.children.length; index += 1) {
        const child = element.children[index];
        if (
          child !== undefined &&
          WORD_NAMESPACES.has(child.uri) &&
          child.local === "sectPr"
        ) {
          lastSection = index;
        }
      }
      if (lastSection >= 0 && lastSection !== element.children.length - 1) {
        issues.error(
          "E_PACKAGE_ORDER",
          `${path}: sectPr must be the last child of body`,
          path,
        );
      }
    }
    if (
      element.local === "tbl" &&
      !element.children.some(
        (child) => WORD_NAMESPACES.has(child.uri) && child.local === "tblGrid",
      )
    ) {
      issues.warn(
        "E_PACKAGE_ORDER",
        `${path}: table without tblGrid may make Word fail`,
        path,
      );
    }
  });
}

function checkDeclaredRelationship(
  rel: SpecRel,
  label: string,
  source: string,
  files: ReadonlyMap<string, string>,
  issues: Issues,
): void {
  if (rel.type.trim().length === 0 || rel.target.length === 0) {
    issues.error("E_REL_BAD_TARGET", `${label}: relationship misses type or target`, label);
    return;
  }
  const mode = rel.mode ?? "internal";
  if (mode !== "internal" && mode !== "external") {
    issues.error("E_REL_BAD_TARGET", `${label}: invalid mode ${mode}`, label);
    return;
  }
  const normalizedTarget = rel.target.replace(/\\/g, "/");
  if (DRIVE_RE.test(normalizedTarget)) {
    issues.error("E_REL_BAD_TARGET", `${label}: drive-letter target ${rel.target}`, label);
    return;
  }
  if (mode === "external") return;
  if (isExternalTarget(rel.target)) {
    issues.error(
      "E_REL_BAD_TARGET",
      `${label}: internal relationship points outside the package`,
      label,
    );
    return;
  }
  checkInternalTarget(label, source, rel.target, files, issues);
}

export function validateSpec(
  spec: PackageSpecInput,
  options: SpecValidateOptions = {},
): ValidationResult {
  const issues = new Issues();
  if (spec.parts.length === 0) {
    issues.error("E_PACKAGE_MISSING_PART", "spec has no parts");
    return issues.result();
  }
  if (spec.parts.length >= MAX_ZIP_ENTRIES) {
    issues.error("E_ZIP_LIMIT", `spec part limit is ${MAX_ZIP_ENTRIES - 1}`);
    return issues.result();
  }

  const files = new Map<string, string>();
  const documents = new Map<string, ParsedXml>();
  const reserved = new Set<string>([
    CONTENT_TYPES_PATH_LOWER,
    PACKAGE_RELS_PATH_LOWER,
  ]);

  for (const part of spec.parts) {
    let path: string;
    try {
      path = toZipPath(part.name);
    } catch (error) {
      issues.error(
        "E_ZIP_PATH",
        errorMessage(error),
        part.name,
      );
      continue;
    }
    const key = asciiLower(path);
    const previous = files.get(key);
    if (previous !== undefined) {
      issues.error(
        "E_PACKAGE_DUP_PART",
        `duplicate part ${path} clashes with ${previous}`,
        part.name,
      );
      continue;
    }
    if (reserved.has(key)) {
      issues.error(
        "E_PACKAGE_DUP_PART",
        `part ${path} collides with an engine-owned path`,
        part.name,
      );
      continue;
    }
    if (!isMediaType(part.contentType)) {
      issues.error(
        "E_CONTENTTYPE_BAD_TYPE",
        `invalid content type for ${path}: ${part.contentType}`,
        part.name,
      );
    }
    if (part.xml.length > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      issues.error(
        "E_ZIP_LIMIT",
        `${path}: XML part exceeds ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES} characters`,
        part.name,
      );
      continue;
    }
    files.set(key, path);
    const parsed = parseXml(part.xml, part.name, issues);
    if (parsed !== null) {
      documents.set(key, parsed);
      checkWordOrder(parsed, part.name, issues);
    }
  }

  if (options.mainPart !== undefined) {
    try {
      const main = toZipPath(options.mainPart);
      if (files.get(asciiLower(main)) !== main) {
        issues.error(
          "E_PACKAGE_MISSING_PART",
          `main part ${main} is missing or differs in case`,
          main,
        );
      }
    } catch (error) {
      issues.error(
        "E_ZIP_PATH",
        errorMessage(error),
        options.mainPart,
      );
    }
  }

  for (const rel of spec.packageRels ?? []) {
    checkDeclaredRelationship(rel, PACKAGE_RELS_PATH, "package", files, issues);
  }

  const declaredScopes = new Map<string, { source: string; count: number }>();
  for (const [rawSource, rels] of Object.entries(spec.partRels ?? {})) {
    let source: string;
    try {
      source = toZipPath(rawSource);
    } catch (error) {
      issues.error(
        "E_ZIP_PATH",
        errorMessage(error),
        rawSource,
      );
      continue;
    }
    const key = asciiLower(source);
    const canonical = files.get(key);
    if (canonical === undefined) {
      issues.error(
        "E_REL_BAD_TARGET",
        `relationship scope targets missing part ${rawSource}`,
        rawSource,
      );
      continue;
    }
    const existing = declaredScopes.get(key);
    if (existing === undefined) {
      declaredScopes.set(key, { source: canonical, count: rels.length });
    } else {
      existing.count += rels.length;
    }
    for (const rel of rels) {
      checkDeclaredRelationship(rel, rawSource, canonical, files, issues);
    }
  }

  for (const scope of declaredScopes.values()) {
    try {
      const relsPath = relsPathForPart(scope.source);
      if (reserved.has(asciiLower(relsPath)) || files.has(asciiLower(relsPath))) {
        issues.error(
          "E_PACKAGE_DUP_PART",
          `relationship scope collides with part ${relsPath}`,
          scope.source,
        );
      }
    } catch (error) {
      issues.error(
        "E_ZIP_PATH",
        errorMessage(error),
        scope.source,
      );
    }
  }

  for (const [partKey, parsed] of documents) {
    const references = relationshipReferences(parsed.root);
    if (references.length === 0) continue;
    const path = files.get(partKey) ?? partKey;
    const scope = declaredScopes.get(partKey);
    if (scope === undefined) {
      for (const reference of references) {
        issues.error(
          "E_REL_DANGLING_REF",
          `${path}: ${reference} has no relationship scope`,
          path,
        );
      }
      continue;
    }
    for (const reference of references) {
      const match = /^rId([1-9]\d*)$/.exec(reference);
      if (match === null) {
        issues.error(
          "E_REL_DANGLING_REF",
          `${path}: ${reference} is not an engine-allocated rIdN`,
          path,
        );
        continue;
      }
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index) || index > scope.count) {
        issues.error(
          "E_REL_DANGLING_REF",
          `${path}: ${reference} exceeds ${scope.count} declared relationships`,
          path,
        );
      }
    }
  }

  return issues.result();
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly dataStart: number;
  readonly localOffset: number;
  readonly localEnd: number;
  readonly externalAttributes: number;
  readonly isDirectory: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

class BoundedInflateError extends Error {}

function inflateBounded(data: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const inflater = new Inflate((chunk) => {
    if (size + chunk.byteLength > maxBytes) {
      throw new BoundedInflateError();
    }
    size += chunk.byteLength;
    chunks.push(chunk);
  });
  inflater.push(data, true);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

function checkEntryName(name: string, issues: Issues): void {
  const reject = (message: string): void => {
    issues.error("E_ZIP_PATH", message, name);
  };
  if (name.startsWith("/")) reject(`absolute entry name ${name}`);
  if (name.includes("\\")) reject(`backslash in entry name ${name}`);
  if (name !== name.trim()) reject(`surrounding whitespace in entry name ${name}`);
  if (name.endsWith("/")) reject(`directory entries are forbidden: ${name}`);
  if (name.length === 0) reject(`empty entry name ${name}`);
  try {
    const canonical = toZipPath(name);
    if (canonical !== name) reject(`non-canonical entry name ${name}`);
  } catch (error) {
    reject(errorMessage(error));
  }
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) reject(`control character in entry name ${name}`);
  }
}

function inspectExtraFields(extra: Uint8Array): boolean | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) return null;
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (offset + 4 + size > extra.byteLength) return null;
    if (id === 0x0001) return true;
    offset += 4 + size;
  }
  return false;
}

function inspectZip(data: Uint8Array, issues: Issues): ZipEntry[] | null {
  if (data.byteLength < 22) {
    issues.error("E_ZIP_FORMAT", "file is too small to be a ZIP");
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (offset: number): number => view.getUint16(offset, true);
  const u32 = (offset: number): number => view.getUint32(offset, true);
  let eocd = -1;
  const scanFrom = Math.max(0, data.byteLength - 65_557);
  for (let offset = data.byteLength - 22; offset >= scanFrom; offset -= 1) {
    if (u32(offset) !== EOCD_SIGNATURE) continue;
    if (offset + 22 + u16(offset + 20) === data.byteLength) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    issues.error("E_ZIP_FORMAT", "end-of-central-directory record not found");
    return null;
  }
  if (
    u16(eocd + 8) === 0xffff ||
    u16(eocd + 10) === 0xffff ||
    u32(eocd + 12) === 0xffffffff ||
    u32(eocd + 16) === 0xffffffff
  ) {
    issues.error("E_ZIP_ZIP64", "ZIP64 end-of-central-directory fields are not supported");
    return null;
  }
  if (eocd >= 20 && u32(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    issues.error("E_ZIP_ZIP64", "ZIP64 locator is not supported");
    return null;
  }
  if (eocd >= 56 && u32(eocd - 56) === ZIP64_EOCD_SIGNATURE) {
    issues.error("E_ZIP_ZIP64", "ZIP64 end-of-central-directory record is not supported");
    return null;
  }

  const disk = u16(eocd + 4);
  const centralDisk = u16(eocd + 6);
  const diskEntries = u16(eocd + 8);
  const entryCount = u16(eocd + 10);
  if (entryCount > MAX_ZIP_ENTRIES) {
    issues.error("E_ZIP_LIMIT", `ZIP has ${entryCount} entries; limit is ${MAX_ZIP_ENTRIES}`);
    return null;
  }
  const centralSize = u32(eocd + 12);
  const centralOffset = u32(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    issues.error("E_ZIP_FORMAT", "multi-disk ZIP archives are not supported");
    return null;
  }
  if (centralOffset + centralSize !== eocd) {
    issues.error("E_ZIP_FORMAT", "central directory does not end at the EOCD record");
    return null;
  }

  const entries: ZipEntry[] = [];
  let totalDeclaredSize = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || u32(offset) !== CENTRAL_SIGNATURE) {
      issues.error("E_ZIP_FORMAT", `central directory entry ${index} is corrupt`);
      break;
    }
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const crc = u32(offset + 16);
    const compressedSize = u32(offset + 20);
    const size = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const diskStart = u16(offset + 34);
    const externalAttributes = u32(offset + 38);
    const localOffset = u32(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > eocd) {
      issues.error("E_ZIP_FORMAT", `central directory entry ${index} is truncated`);
      break;
    }

    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
    let name: string;
    try {
      name = decodeUtf8(nameBytes);
    } catch {
      issues.error("E_ZIP_PATH", `entry ${index} name is not valid UTF-8`);
      offset += recordLength;
      continue;
    }
    const isDirectory = name.endsWith("/");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      issues.error("E_ZIP_ZIP64", `${name}: ZIP64 fields are not supported`, name);
      return null;
    }
    const unixFileType = (externalAttributes >>> 16) & 0xf000;
    if (unixFileType === 0xa000 || (externalAttributes & 0x0400) !== 0) {
      issues.error("E_ZIP_SYMLINK", `${name}: symlink entries are forbidden`, name);
      return null;
    }
    if (
      unixFileType !== 0 &&
      unixFileType !== 0x4000 &&
      unixFileType !== 0x8000
    ) {
      issues.error("E_ZIP_FORMAT", `${name}: special filesystem entry is forbidden`, name);
      return null;
    }
    if (size > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      issues.error(
        "E_ZIP_LIMIT",
        `${name}: uncompressed size ${size} exceeds ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES}`,
        name,
      );
      return null;
    }
    totalDeclaredSize += size;
    if (totalDeclaredSize > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      issues.error(
        "E_ZIP_LIMIT",
        `ZIP uncompressed total exceeds ${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}`,
        name,
      );
      return null;
    }
    if (
      method === 8 &&
      size >= 64 * 1024 &&
      (compressedSize === 0 ||
        size / compressedSize > MAX_ZIP_COMPRESSION_RATIO)
    ) {
      issues.error(
        "E_ZIP_LIMIT",
        `${name}: compression ratio exceeds ${MAX_ZIP_COMPRESSION_RATIO}`,
        name,
      );
      return null;
    }
    let dataStart = 0;
    let localEnd = localOffset;
    if (diskStart !== 0) {
      issues.error("E_ZIP_FORMAT", `${name}: entry starts on another disk`, name);
    }
    const extra = data.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    const zip64Extra = inspectExtraFields(extra);
    if (zip64Extra === null) {
      issues.error("E_ZIP_FORMAT", `${name}: malformed extra field`, name);
      return null;
    }
    if (zip64Extra) {
      issues.error("E_ZIP_ZIP64", `${name}: ZIP64 extra field is not supported`, name);
      return null;
    }
    if (method !== 0 && method !== 8) {
      issues.error(
        "E_ZIP_METHOD",
        `${name}: compression method ${method} is not Store or Deflate`,
        name,
      );
    }
    if ((flags & 0x0001) !== 0) issues.error("E_ZIP_GPBIT", `${name}: encryption is forbidden`, name);
    if ((flags & 0x0020) !== 0) issues.error("E_ZIP_GPBIT", `${name}: patched data is forbidden`, name);
    if ((flags & 0x0040) !== 0) issues.error("E_ZIP_GPBIT", `${name}: strong encryption is forbidden`, name);
    if ((flags & 0x2000) !== 0) issues.error("E_ZIP_GPBIT", `${name}: masked names are forbidden`, name);
    if ((flags & DATA_DESCRIPTOR_FLAG) !== 0) {
      issues.warn(
        "E_ZIP_GPBIT",
        `${name}: data descriptor may reduce strict-reader compatibility`,
        name,
      );
    }
    if ((flags & UTF8_FLAG) === 0) {
      if (nameBytes.some((byte) => byte >= 0x80)) {
        issues.error(
          "E_ZIP_GPBIT",
          `${name}: non-ASCII name requires the UTF-8 flag`,
          name,
        );
      } else {
        issues.warn("E_ZIP_GPBIT", `${name}: UTF-8 flag is not set`, name);
      }
    }
    checkEntryName(name, issues);
    if (isDirectory && (method !== 0 || compressedSize !== 0 || size !== 0)) {
      issues.error("E_ZIP_FORMAT", `${name}: directory entry is not empty`, name);
    }

    if (localOffset + 30 > centralOffset || u32(localOffset) !== LOCAL_SIGNATURE) {
      issues.error("E_ZIP_FORMAT", `${name}: local header is missing or out of range`, name);
    } else {
      const localFlags = u16(localOffset + 6);
      const localMethod = u16(localOffset + 8);
      const localNameLength = u16(localOffset + 26);
      const localExtraLength = u16(localOffset + 28);
      const localNameEnd = localOffset + 30 + localNameLength;
      dataStart = localNameEnd + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (localMethod !== method || localFlags !== flags) {
        issues.error("E_ZIP_FORMAT", `${name}: local and central headers disagree`, name);
      }
      if (localNameEnd > centralOffset || dataEnd > centralOffset) {
        issues.error("E_ZIP_FORMAT", `${name}: local entry runs into the central directory`, name);
        return null;
      }
      const localName = data.subarray(localOffset + 30, localNameEnd);
      if (
        localName.length !== nameBytes.length ||
        localName.some((byte, byteIndex) => byte !== nameBytes[byteIndex])
      ) {
        issues.error("E_ZIP_FORMAT", `${name}: local and central names disagree`, name);
      }
      const localExtra = data.subarray(localNameEnd, dataStart);
      const localZip64Extra = inspectExtraFields(localExtra);
      if (localZip64Extra === null) {
        issues.error("E_ZIP_FORMAT", `${name}: malformed local extra field`, name);
        return null;
      }
      if (localZip64Extra) {
        issues.error("E_ZIP_ZIP64", `${name}: local ZIP64 extra field is not supported`, name);
        return null;
      }
      localEnd = dataEnd;
      if ((flags & DATA_DESCRIPTOR_FLAG) === 0) {
        if (
          u32(localOffset + 14) !== crc ||
          u32(localOffset + 18) !== compressedSize ||
          u32(localOffset + 22) !== size
        ) {
          issues.error("E_ZIP_FORMAT", `${name}: local CRC or sizes disagree`, name);
        }
      } else {
        if (
          u32(localOffset + 14) !== 0 ||
          u32(localOffset + 18) !== 0 ||
          u32(localOffset + 22) !== 0
        ) {
          issues.error(
            "E_ZIP_FORMAT",
            `${name}: local CRC and sizes must be zero with a data descriptor`,
            name,
          );
        }
        let descriptor = dataEnd;
        if (descriptor + 4 <= centralOffset && u32(descriptor) === DATA_DESCRIPTOR_SIGNATURE) {
          descriptor += 4;
        }
        if (descriptor + 12 > centralOffset) {
          issues.error("E_ZIP_FORMAT", `${name}: data descriptor is truncated`, name);
        } else {
          if (
            u32(descriptor) !== crc ||
            u32(descriptor + 4) !== compressedSize ||
            u32(descriptor + 8) !== size
          ) {
            issues.error("E_ZIP_FORMAT", `${name}: data descriptor disagrees`, name);
          }
          localEnd = descriptor + 12;
        }
      }
    }

    entries.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      size,
      dataStart,
      localOffset,
      localEnd,
      externalAttributes,
      isDirectory,
    });
    offset += recordLength;
  }

  if (offset !== eocd) {
    issues.error("E_ZIP_FORMAT", "central directory size does not match its entries");
  }
  const duplicates = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const key = asciiLower(entry.name);
    const names = duplicates.get(key) ?? [];
    names.push(entry.name);
    duplicates.set(key, names);
  }
  for (const names of duplicates.values()) {
    if (names.length > 1) {
      issues.error(
        "E_PACKAGE_DUP_PART",
        `duplicate ZIP entries ${names.join(" and ")}`,
        names[0],
      );
    }
  }
  const localRanges = entries
    .filter((entry) => entry.localEnd > entry.localOffset)
    .sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 1; index < localRanges.length; index += 1) {
    const previous = localRanges[index - 1];
    const current = localRanges[index];
    if (previous !== undefined && current !== undefined && previous.localEnd > current.localOffset) {
      issues.error("E_ZIP_FORMAT", `${current.name}: local entries overlap`, current.name);
    }
  }
  return entries;
}

type XmlEncoding = "utf-8" | "utf-16le" | "utf-16be";

function decodeXmlText(data: Uint8Array): { readonly text: string; readonly encoding: XmlEncoding } {
  let encoding: XmlEncoding = "utf-8";
  if (data[0] === 0xff && data[1] === 0xfe) encoding = "utf-16le";
  else if (data[0] === 0xfe && data[1] === 0xff) encoding = "utf-16be";
  else if (data[0] === 0x3c && data[1] === 0x00) encoding = "utf-16le";
  else if (data[0] === 0x00 && data[1] === 0x3c) encoding = "utf-16be";
  return {
    text: new TextDecoder(encoding, { fatal: true }).decode(data),
    encoding,
  };
}

function declarationMatchesEncoding(declaration: XMLDecl, encoding: XmlEncoding): boolean {
  if (declaration.encoding === undefined) return true;
  const declared = asciiLower(declaration.encoding);
  if (declared === "utf-8") return encoding === "utf-8";
  if (declared === "utf-16") return encoding === "utf-16le" || encoding === "utf-16be";
  if (declared === "utf-16le") return encoding === "utf-16le";
  if (declared === "utf-16be") return encoding === "utf-16be";
  return false;
}

function decodeXmlPart(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  issues: Issues,
): ParsedXml | null {
  const bytes = files.get(path);
  if (bytes === undefined) return null;
  let decoded: { readonly text: string; readonly encoding: XmlEncoding };
  try {
    decoded = decodeXmlText(bytes);
  } catch {
    issues.error("E_XML_MALFORMED", `${path}: part is not valid UTF-8 or UTF-16`, path);
    return null;
  }
  const parsed = parseXml(decoded.text, path, issues);
  if (parsed === null) return null;
  if (!declarationMatchesEncoding(parsed.declaration, decoded.encoding)) {
    issues.error(
      "E_XML_MALFORMED",
      `${path}: XML encoding ${parsed.declaration.encoding ?? ""} does not match its bytes`,
      path,
    );
    return null;
  }
  return parsed;
}

export function validateZipBytes(
  data: Uint8Array,
  options: ZipValidateOptions = {},
): ValidationResult {
  const issues = new Issues();
  if (data.byteLength > MAX_ZIP_ARCHIVE_BYTES) {
    issues.error(
      "E_ZIP_LIMIT",
      `ZIP archive exceeds ${MAX_ZIP_ARCHIVE_BYTES} bytes`,
    );
    return issues.result();
  }
  const entries = inspectZip(data, issues);
  if (entries === null) return issues.result();

  const exact = new Set(
    entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
  );
  const fileNames = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory) fileNames.set(asciiLower(entry.name), entry.name);
  }
  if (!exact.has(CONTENT_TYPES_PATH)) {
    issues.error("E_PACKAGE_MISSING_PART", `${CONTENT_TYPES_PATH} is missing`);
    if (fileNames.has(CONTENT_TYPES_PATH_LOWER)) {
      issues.warn(
        "E_PACKAGE_MISSING_PART",
        `${CONTENT_TYPES_PATH} has the wrong case`,
      );
    }
  }
  if (!exact.has(PACKAGE_RELS_PATH)) {
    issues.error("E_PACKAGE_MISSING_PART", `${PACKAGE_RELS_PATH} is missing`);
    if (fileNames.has(PACKAGE_RELS_PATH_LOWER)) {
      issues.warn("E_PACKAGE_MISSING_PART", `${PACKAGE_RELS_PATH} has the wrong case`);
    }
  }
  if (options.mainPart !== undefined) {
    let mainPart: string;
    try {
      mainPart = toZipPath(options.mainPart);
    } catch (error) {
      issues.error(
        "E_ZIP_PATH",
        errorMessage(error),
        options.mainPart,
      );
      return issues.result();
    }
    if (!exact.has(mainPart)) {
      issues.error("E_PACKAGE_MISSING_PART", `main part ${mainPart} is missing`, mainPart);
    }
  }

  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (
      entry.dataStart === 0 ||
      (entry.method !== 0 && entry.method !== 8) ||
      (entry.flags & 0x0041) !== 0
    ) {
      continue;
    }
    if (entry.size > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      issues.error(
        "E_ZIP_LIMIT",
        `${entry.name}: uncompressed size exceeds ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES}`,
        entry.name,
      );
      continue;
    }
    const compressed = data.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let bytes: Uint8Array;
    try {
      bytes = entry.method === 8
        ? inflateBounded(compressed, MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES)
        : compressed;
    } catch (error) {
      if (error instanceof BoundedInflateError) {
        issues.error(
          "E_ZIP_LIMIT",
          `${entry.name}: uncompressed size exceeds ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES}`,
          entry.name,
        );
      } else {
        issues.error(
          "E_ZIP_FORMAT",
          `${entry.name}: extraction failed: ${errorMessage(error)}`,
          entry.name,
        );
      }
      continue;
    }
    if (bytes.byteLength > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      issues.error(
        "E_ZIP_LIMIT",
        `${entry.name}: uncompressed size exceeds ${MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES}`,
        entry.name,
      );
      continue;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      issues.error(
        "E_ZIP_LIMIT",
        `ZIP uncompressed total exceeds ${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}`,
        entry.name,
      );
      return issues.result();
    }
    files.set(entry.name, bytes);
    if (bytes.byteLength !== entry.size) {
      issues.error(
        "E_ZIP_FORMAT",
        `${entry.name}: uncompressed size mismatch`,
        entry.name,
      );
    }
    if (crc32(bytes) !== entry.crc) {
      issues.error("E_ZIP_CRC", `${entry.name}: CRC32 mismatch`, entry.name);
    }
  }

  const contentTypes = decodeXmlPart(files, CONTENT_TYPES_PATH, issues);
  const tables =
    contentTypes === null
      ? { defaults: new Map<string, string>(), overrides: new Map() }
      : parseContentTypes(contentTypes, CONTENT_TYPES_PATH, issues);
  checkContentTypeCoverage(entries, fileNames, tables, issues);

  const documents = new Map<string, ParsedXml>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const lowerName = asciiLower(entry.name);
    if (lowerName === CONTENT_TYPES_PATH_LOWER) continue;
    const type = contentTypeFor(entry.name, tables);
    if (
      !lowerName.endsWith(".rels") &&
      (type === null || !isXmlContentType(type))
    ) {
      continue;
    }
    const parsed = decodeXmlPart(files, entry.name, issues);
    if (parsed !== null) documents.set(entry.name, parsed);
  }

  const scopes = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.isDirectory || !asciiLower(entry.name).endsWith(".rels")) continue;
    const parsed = documents.get(entry.name);
    if (parsed === undefined) continue;
    const source = sourceForRels(entry.name);
    if (source === null) {
      issues.error(
        "E_REL_BAD_TARGET",
        `${entry.name}: invalid relationship part location`,
        entry.name,
      );
      continue;
    }
    if (source !== "" && !fileNames.has(asciiLower(source))) {
      issues.error(
        "E_REL_BAD_TARGET",
        `${entry.name}: relationship scope targets missing part ${source}`,
        entry.name,
      );
    }
    const ids = checkRelationships(entry.name, parsed, source, fileNames, issues);
    scopes.set(asciiLower(entry.name), ids);
  }

  checkRelationshipReferences(documents, scopes, issues);
  for (const [path, parsed] of documents) {
    if (!asciiLower(path).endsWith(".rels")) checkWordOrder(parsed, path, issues);
  }
  return issues.result();
}

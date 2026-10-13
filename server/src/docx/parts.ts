// The two fixed parts: the declared style vocabulary and the document
// properties. Both are pure JSON-in/part-string-out like the document body, and
// neither touches the package or the ZIP.
import { doc, el, escText } from "../ooxml-core/xml.js";
import type { XmlAttr } from "../ooxml-core/xml.js";
import type { DocxDocument } from "@k5-work/shared";
import {
  CP_NS,
  DC_NS,
  DCMITYPE_NS,
  DCTERMS_NS,
  FIXED_TIMESTAMP,
  STYLE_IDS,
  W_NS,
  XSI_NS,
} from "./names.js";

// Declared fonts, because there is no theme part here and a style with no font
// falls back to whatever the reader happens to have. themeColor and
// asciiTheme are banned in v1 for the same reason: they would render as nothing.
const BODY_FONT = "Calibri";
const CODE_FONT = "Consolas";
const BODY_SIZE_HALF_POINTS = "22";

function style(
  type: "paragraph" | "character" | "table",
  styleId: string,
  name: string,
  body: string,
  isDefault = false,
): string {
  const attrs: XmlAttr[] = [["w:type", type]];
  if (isDefault) attrs.push(["w:default", "1"]);
  attrs.push(["w:styleId", styleId]);
  // CT_Style wants w:name before w:pPr and w:rPr, which sit near the end.
  return el("w:style", attrs, el("w:name", [["w:val", name]]) + body);
}

/**
 * Every style the model can name, and nothing else. MS Learn is explicit that
 * applying a style that does not exist has no effect and generates no
 * exception, so an undeclared style is the silent failure this list prevents:
 * the document would open clean and render every heading as body text.
 *
 * A declared heading has to carry a size as well as bold, or it is a bold
 * paragraph that merely claims to be a heading. Sizes are explicit half-points
 * because there is no theme part here: Word's own heading styles reach for
 * asciiTheme="majorHAnsi" and szCs, and both would render as nothing without a
 * theme. Normal is 11pt, so the ladder is 16 / 14 / 12 and the title is 28.
 */
export function buildStylesXml(): string {
  // Half-points, and they go inside the same w:rPr as the bold: CT_Style takes
  // one w:pPr and one w:rPr, never two.
  const size = (halfPoints: string): string =>
    el("w:sz", [["w:val", halfPoints]]) + el("w:szCs", [["w:val", halfPoints]]);
  const boldAndSize = (halfPoints: string): string =>
    el("w:rPr", [], el("w:b", []) + size(halfPoints));

  const heading = (level: 1 | 2 | 3, halfPoints: string): string =>
    // CT_PPr order: keepNext, keepLines, spacing, outlineLvl.
    el(
      "w:pPr",
      [],
      el("w:keepNext", []) +
        el("w:keepLines", []) +
        el("w:spacing", [["w:before", "240"], ["w:after", "0"]]) +
        el("w:outlineLvl", [["w:val", String(level - 1)]]),
    ) + boldAndSize(halfPoints);

  const styles = [
    style("paragraph", STYLE_IDS.normal, "Normal", "", true),
    style("paragraph", STYLE_IDS.title, "Title", boldAndSize("56")),
    style("paragraph", STYLE_IDS.quote, "Quote", el("w:pPr", [], el("w:ind", [["w:left", "720"], ["w:right", "720"]])) + el("w:rPr", [], el("w:i", []))),
    style("paragraph", STYLE_IDS.heading1, "heading 1", heading(1, "32")),
    style("paragraph", STYLE_IDS.heading2, "heading 2", heading(2, "28")),
    style("paragraph", STYLE_IDS.heading3, "heading 3", heading(3, "24")),
    style("character", STYLE_IDS.code, "Code Block Char", el("w:rPr", [], el("w:rFonts", [
      ["w:ascii", CODE_FONT],
      ["w:hAnsi", CODE_FONT],
      ["w:cs", CODE_FONT],
    ]))),
    style("table", STYLE_IDS.tableGrid, "Table Grid", ""),
  ].join("");

  const docDefaults = el(
    "w:docDefaults",
    [],
    el(
      "w:rPrDefault",
      [],
      el(
        "w:rPr",
        [],
        el("w:rFonts", [
          ["w:ascii", BODY_FONT],
          ["w:hAnsi", BODY_FONT],
          ["w:cs", BODY_FONT],
        ]) + el("w:sz", [["w:val", BODY_SIZE_HALF_POINTS]]) +
          el("w:szCs", [["w:val", BODY_SIZE_HALF_POINTS]]),
      ),
    ),
  );

  // CT_Styles is w:docDefaults then the w:style entries. w:latentStyles is
  // optional and omitted.
  return doc(el("w:styles", [["xmlns:w", W_NS]], docDefaults + styles));
}

/**
 * Dublin Core, with the created and modified timestamps pinned to a constant.
 * CT_CoreProperties is an xs:all, so child order is unconstrained here and the
 * emitted order is just the order the spec lists the elements in. Both of ours
 * are optional and are omitted when the model left them out.
 */
export function buildCoreXml(document: DocxDocument): string {
  const timestamp = el(
    "dcterms:created",
    [["xsi:type", "dcterms:W3CDTF"]],
    escText(FIXED_TIMESTAMP),
  );
  const modified = el(
    "dcterms:modified",
    [["xsi:type", "dcterms:W3CDTF"]],
    escText(FIXED_TIMESTAMP),
  );
  const children = [
    timestamp,
    document.author === undefined ? "" : el("dc:creator", [], escText(document.author)),
    modified,
    document.title === undefined ? "" : el("dc:title", [], escText(document.title)),
  ].join("");
  return doc(
    el(
      "cp:coreProperties",
      [
        ["xmlns:cp", CP_NS],
        ["xmlns:dc", DC_NS],
        ["xmlns:dcterms", DCTERMS_NS],
        ["xmlns:dcmitype", DCMITYPE_NS],
        ["xmlns:xsi", XSI_NS],
      ],
      children,
    ),
  );
}
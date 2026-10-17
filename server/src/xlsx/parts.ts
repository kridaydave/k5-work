import { doc, el, escText } from "../ooxml-core/xml.js";
import type { XlsxWorkbook, XlsxSheet, XlsxCell } from "@k5-work/shared";
import {
  CP_NS,
  DC_NS,
  DCTERMS_NS,
  FIXED_TIMESTAMP,
  RELS_NS,
  S_NS,
  XSI_NS,
} from "./names.js";

function colLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function buildSharedStringsXml(strings: readonly string[]): string {
  const items = strings
    .map((s) => {
      const attrs: [string, string][] = /^\s|\s$/.test(s) ? [["xml:space", "preserve"]] : [];
      return el("si", [], el("t", attrs, escText(s)));
    })
    .join("");
  return doc(
    el(
      "sst",
      [
        ["xmlns", S_NS],
        ["count", String(strings.length)],
        ["uniqueCount", String(strings.length)],
      ],
      items,
    ),
  );
}

export function buildSheetXml(sheet: XlsxSheet, sharedIndex: (text: string) => number): string {
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, colIndex) => buildCell(cell, rowIndex + 1, colIndex, sharedIndex))
        .join("");
      if (cells === "") return "";
      return el("row", [["r", String(rowIndex + 1)]], cells);
    })
    .filter((r) => r !== "")
    .join("");
  return doc(el("worksheet", [["xmlns", S_NS]], el("sheetData", [], rows)));
}

function buildCell(cell: XlsxCell, row: number, col: number, sharedIndex: (text: string) => number): string {
  const ref = `${colLetter(col)}${String(row)}`;
  const v = cell.value;
  if (v === null) return "";
  if (typeof v === "string") {
    const idx = sharedIndex(v);
    return el("c", [["r", ref], ["t", "s"]], el("v", [], String(idx)));
  }
  if (typeof v === "boolean") {
    return el("c", [["r", ref], ["t", "b"]], el("v", [], v ? "1" : "0"));
  }
  return el("c", [["r", ref]], el("v", [], String(v)));
}

export function buildStylesXml(): string {
  return doc(
    el(
      "styleSheet",
      [["xmlns", S_NS]],
      el("fonts", [["count", "1"]], el("font", [], el("sz", [["val", "11"]]) + el("name", [["val", "Calibri"]]))) +
        el("fills", [["count", "2"]], el("fill", [], el("patternFill", [["patternType", "none"]])) + el("fill", [], el("patternFill", [["patternType", "gray125"]]))) +
        el("borders", [["count", "1"]], el("border", [], el("left") + el("right") + el("top") + el("bottom"))) +
        el("cellStyleXfs", [["count", "1"]], el("xf", [["numFmtId", "0"], ["fontId", "0"], ["fillId", "0"], ["borderId", "0"]])) +
        el("cellXfs", [["count", "1"]], el("xf", [["numFmtId", "0"], ["fontId", "0"], ["fillId", "0"], ["borderId", "0"], ["xfId", "0"]])) +
        el("cellStyles", [["count", "1"]], el("cellStyle", [["name", "Normal"], ["xfId", "0"], ["builtinId", "0"]])),
    ),
  );
}

export function buildWorkbookXml(workbook: XlsxWorkbook): string {
  const sheets = workbook.sheets
    .map((sheet, i) => el("sheet", [["name", sheet.name], ["sheetId", String(i + 1)], ["r:id", `rId${String(i + 1)}`]]))
    .join("");
  return doc(
    el(
      "workbook",
      [
        ["xmlns", S_NS],
        ["xmlns:r", RELS_NS],
      ],
      el("sheets", [], sheets),
    ),
  );
}

export function buildCoreXml(workbook: XlsxWorkbook): string {
  const title = workbook.title
    ? el("dc:title", [], escText(workbook.title))
    : "";
  const creator = workbook.author
    ? el("dc:creator", [], escText(workbook.author))
    : "";
  const created = el(
    "dcterms:created",
    [["xsi:type", "dcterms:W3CDTF"]],
    escText(FIXED_TIMESTAMP),
  );
  const modified = el(
    "dcterms:modified",
    [["xsi:type", "dcterms:W3CDTF"]],
    escText(FIXED_TIMESTAMP),
  );
  return doc(
    el(
      "cp:coreProperties",
      [
        ["xmlns:cp", CP_NS],
        ["xmlns:dc", DC_NS],
        ["xmlns:dcterms", DCTERMS_NS],
        ["xmlns:xsi", XSI_NS],
      ],
      title + creator + created + modified,
    ),
  );
}
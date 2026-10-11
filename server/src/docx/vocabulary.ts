// The document body: the JSON model in, a WordprocessingML part string out.
// Pure, with no package or ZIP knowledge, so it can be tested by asserting on
// strings alone.
//
// Every element order below is from the ECMA-376 content models and is
// asserted by the fixtures. Nothing in the engine checks CT_PPr, CT_RPr,
// w:tblPr or w:tcPr placement, and LibreOffice tolerates violations, so the
// order here is the only gate behind it.
import type {
  Cell,
  DocxDocument,
  HeadingBlock,
  ListBlock,
  Mark,
  ParagraphBlock,
  Run,
  TableBlock,
} from "@k5-work/shared";
import { doc, el, escText } from "../ooxml-core/xml.js";
import { numIdForListBlock } from "./numbering.js";
import {
  FOOTER_MARGIN,
  HEADER_MARGIN,
  PAGE_HEIGHT,
  PAGE_MARGIN,
  PAGE_WIDTH,
  STYLE_IDS,
  W_NS,
} from "./names.js";

/**
 * CT_RPr order, for the five marks the model can carry: rStyle, b, i, strike,
 * u. Anything out of this order is a repair prompt in Word.
 */
const MARK_ORDER: readonly Mark[] = ["code", "bold", "italic", "strike", "underline"];

const MARK_ELEMENTS: Readonly<Record<Mark, string>> = {
  code: el("w:rStyle", [["w:val", STYLE_IDS.code]]),
  bold: el("w:b", []),
  italic: el("w:i", []),
  strike: el("w:strike", []),
  underline: el("w:u", [["w:val", "single"]]),
};

function markProperties(marks: readonly Mark[]): string {
  const wanted = new Set(marks);
  const children = MARK_ORDER.filter((mark) => wanted.has(mark)).map(
    (mark) => MARK_ELEMENTS[mark],
  );
  return children.length === 0 ? "" : el("w:rPr", [], children.join(""));
}

/**
 * A newline inside w:t is not a line break and a tab inside w:t is not a tab
 * stop: the reader renders them as a space or as nothing. So they become w:br
 * and w:tab, and empty segments drop out so a trailing newline does not leave
 * an empty w:t behind.
 */
function runContent(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/([\n\t])/)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === "\n") return el("w:br", []);
      if (segment === "\t") return el("w:tab", []);
      // xml:space is set unconditionally. It is valid everywhere, it costs
      // nothing, and detecting when it matters is how indented text silently
      // loses its indentation.
      return el("w:t", [["xml:space", "preserve"]], escText(segment));
    })
    .join("");
}

function buildRun(run: Run): string {
  return el("w:r", [], markProperties(run.marks) + runContent(run.text));
}

function buildRuns(runs: readonly Run[]): string {
  return runs.map(buildRun).join("");
}

function paragraph(styleId: string, runs: readonly Run[]): string {
  // CT_P wants w:pPr first, and pStyle is the first child of pPr.
  const properties = el("w:pPr", [], el("w:pStyle", [["w:val", styleId]]));
  return el("w:p", [], properties + buildRuns(runs));
}

function buildParagraph(block: ParagraphBlock): string {
  return paragraph(STYLE_IDS[block.style], block.runs);
}

function buildHeading(block: HeadingBlock): string {
  return paragraph(STYLE_IDS[`heading${block.level}` as "heading1"], block.runs);
}

/** A page break is a paragraph holding one run holding one w:br of type page. */
function buildPageBreak(): string {
  return el("w:p", [], el("w:r", [], el("w:br", [["w:type", "page"]])));
}

/**
 * Each item is its own paragraph carrying w:numPr, which names the w:num the
 * numbering part declared for this list. CT_PPr puts pStyle first and numPr
 * after it, and CT_NumPr puts ilvl before numId. The level is the model's
 * one-based level minus one, since w:ilvl is zero-based.
 */
function buildList(block: ListBlock, numId: string): string {
  return block.items
    .map((item) => {
      const properties = el(
        "w:pPr",
        [],
        el("w:pStyle", [["w:val", STYLE_IDS.normal]]) +
          el(
            "w:numPr",
            [],
            el("w:ilvl", [["w:val", String(item.level - 1)]]) +
              el("w:numId", [["w:val", numId]]),
          ),
      );
      return el("w:p", [], properties + buildRuns(item.runs));
    })
    .join("");
}

function borderEdge(edge: string): string {
  return el(`w:${edge}`, [
    ["w:val", "single"],
    ["w:sz", "4"],
    ["w:space", "0"],
    ["w:color", "auto"],
  ]);
}

function buildCell(cell: Cell, columnWidth: number, bold: boolean): string {
  // tcW is the preferred width of the whole cell, so a spanning cell needs the
  // sum of the columns it covers. Declaring one column's width there makes
  // Word reconcile the row against the one above it, which moves the cell
  // boundary out from under the header.
  // CT_TcPr order is tcW then gridSpan. Vertical alignment is left at the
  // reader default rather than pinned: Word tops a data table, and a centred
  // row is a style choice this model does not make.
  const properties = el(
    "w:tcPr",
    [],
    el("w:tcW", [["w:w", String(columnWidth)], ["w:type", "dxa"]]) +
      (cell.colSpan > 1 ? el("w:gridSpan", [["w:val", String(cell.colSpan)]]) : ""),
  );
  // A cell holds runs, so the paragraph Word requires at the end of one is
  // supplied here. The header row is bolded explicitly rather than left to the
  // table style, so it still reads as a header in a reader that ignores styles.
  const runs = bold
    ? cell.runs.map((run) => ({ ...run, marks: [...new Set([...run.marks, "bold" as Mark])] }))
    : cell.runs;
  return el("w:tc", [], properties + el("w:p", [], buildRuns(runs)));
}

function buildRow(
  cells: readonly Cell[],
  columnWidths: readonly number[],
  isHeader: boolean,
): string {
  // CT_Row takes w:trPr first when present, then the cells.
  const properties = isHeader ? el("w:trPr", [], el("w:tblHeader", [])) : "";
  let column = 0;
  const body = cells
    .map((cell) => {
      // The grid columns this cell actually covers, which is the width Word
      // lays the cell out to.
      const width = columnWidths
        .slice(column, column + cell.colSpan)
        .reduce((total, value) => total + value, 0);
      column += cell.colSpan;
      return buildCell(cell, width, isHeader);
    })
    .join("");
  return el("w:tr", [], properties + body);
}

function buildTable(block: TableBlock): string {
  // CT_Tbl is tblPr, tblGrid, then the rows. tblPr order is tblStyle, tblW,
  // tblBorders, tblLayout. Word crashes without tblGrid even though the schema
  // marks it optional, and a table with no borders is a grid that renders like
  // nothing, so both are emitted explicitly rather than left to a style.
  const properties = el(
    "w:tblPr",
    [],
    el("w:tblStyle", [["w:val", STYLE_IDS.tableGrid]]) +
      el("w:tblW", [["w:w", "0"], ["w:type", "auto"]]) +
      el(
        "w:tblBorders",
        [],
        ["top", "left", "bottom", "right", "insideH", "insideV"]
          .map(borderEdge)
          .join(""),
      ) +
      el("w:tblLayout", [["w:type", "fixed"]]),
  );
  const grid = el(
    "w:tblGrid",
    [],
    block.columnWidths.map((width) => el("w:gridCol", [["w:w", String(width)]])).join(""),
  );
  const rows = block.rows
    .map((row, index) => buildRow(row, block.columnWidths, block.headerRow && index === 0))
    .join("");
  return el("w:tbl", [], properties + grid + rows);
}

function buildBlock(block: DocxDocument["blocks"][number], index: number): string {
  switch (block.type) {
    case "paragraph":
      return buildParagraph(block);
    case "heading":
      return buildHeading(block);
    case "table":
      return buildTable(block);
    case "list":
      return buildList(block, numIdForListBlock(index));
    case "pageBreak":
      return buildPageBreak();
  }
}

/** w:sectPr must be the last child of w:body. Word repairs on swap. */
function sectionProperties(): string {
  return el(
    "w:sectPr",
    [],
    el("w:pgSz", [["w:w", PAGE_WIDTH], ["w:h", PAGE_HEIGHT]]) +
      el("w:pgMar", [
        ["w:top", PAGE_MARGIN],
        ["w:right", PAGE_MARGIN],
        ["w:bottom", PAGE_MARGIN],
        ["w:left", PAGE_MARGIN],
        ["w:header", HEADER_MARGIN],
        ["w:footer", FOOTER_MARGIN],
        ["w:gutter", "0"],
      ]),
  );
}

export function buildDocumentXml(document: DocxDocument): string {
  const body =
    document.blocks.map(buildBlock).join("") + sectionProperties();
  return doc(el("w:document", [["xmlns:w", W_NS]], el("w:body", [], body)));
}
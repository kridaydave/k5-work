import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SaxesParser } from "saxes";
import { DocxDocumentSchema } from "@k5-work/shared";
import { buildStylesXml } from "./parts.js";
import { buildDocumentXml } from "./vocabulary.js";
import { STYLE_IDS } from "./names.js";

// What docDefaults sets for body text, in half-points. Named here so the
// heading-size assertion compares against a real number rather than a guess.
const BODY_DEFAULT_HALF_POINTS = "22";

interface Node {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  readonly children: Node[];
}

function parseXml(xml: string): Node {
  const parser = new SaxesParser();
  const stack: Node[] = [];
  let root: Node | undefined;
  parser.on("opentag", (tag) => {
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      tag.attributes as Record<string, string | { value: string }>,
    )) {
      attrs[key] = typeof value === "string" ? value : value.value;
    }
    const node: Node = { name: tag.name, attrs, text: "", children: [] };
    const parent = stack.at(-1);
    if (parent === undefined) root ??= node;
    else parent.children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (chunk) => {
    const parent = stack.at(-1);
    if (parent === undefined) return;
    (parent as { text: string }).text += chunk;
  });
  parser.write(xml).close();
  assert.ok(root !== undefined, "no root element");
  return root;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function all(xml: string): Node[] {
  const found: Node[] = [];
  walk(parseXml(xml), (node) => found.push(node));
  return found;
}

/**
 * The permitted child sequences for the elements this driver emits, as ordered
 * groups. Children in the same group are a repeating choice and may interleave
 * freely, which is why w:body is [["w:p", "w:tbl"], ["w:sectPr"]].
 *
 * Three things this table is not, so nobody leans on it wrongly:
 *
 * - It is not a complete transcription of ECMA-376. It lists what the driver
 *   emits, not every legal child. Adding an element means adding its slot
 *   here, and that is deliberate: an emitter change should not be able to skip
 *   the order question.
 * - It is stricter than the XSD in one place. CT_TrPrBase and EG_RPrBase are
 *   xsd:choice, so the schema enforces no order there, while Word serializes in
 *   the sequence below. Checking the stricter rule guards the order readers
 *   actually produce.
 * - Grouping is not the same as permissiveness. A group of one is
 *   single-occurrence and the cardinality check enforces it; only the names in
 *   REPEATABLE_CHILDREN may genuinely repeat.
 *
 * Nothing in the engine checks any of this and LibreOffice tolerates
 * violations, so these assertions are the only gate. The table was checked
 * against wml.xsd from ECMA-376 Transitional: every emitted part validates, and
 * deliberately broken variants are rejected.
 */
const PERMITTED_ORDER: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  "w:p": [["w:pPr"], ["w:r", "w:hyperlink", "w:bookmarkStart", "w:bookmarkEnd"]],
  "w:r": [["w:rPr"], ["w:t", "w:br", "w:tab", "w:cr"]],
  "w:pPr": [["w:pStyle"], ["w:keepNext"], ["w:keepLines"], ["w:pageBreakBefore"], ["w:numPr"], ["w:spacing"], ["w:ind"], ["w:jc"], ["w:outlineLvl"], ["w:rPr"], ["w:sectPr"]],
  "w:rPr": [["w:rStyle"], ["w:rFonts"], ["w:b"], ["w:bCs"], ["w:i"], ["w:iCs"], ["w:strike"], ["w:dstrike"], ["w:color"], ["w:sz"], ["w:szCs"], ["w:highlight"], ["w:u"], ["w:vertAlign"], ["w:lang"]],
  "w:tbl": [["w:tblPr"], ["w:tblGrid"], ["w:tr"]],
  "w:tblPr": [["w:tblStyle"], ["w:tblpPr"], ["w:tblOverlap"], ["w:bidiVisual"], ["w:tblW"], ["w:jc"], ["w:tblCellSpacing"], ["w:tblInd"], ["w:tblBorders"], ["w:shd"], ["w:tblLayout"], ["w:tblCellMar"], ["w:tblLook"]],
  "w:tblBorders": [["w:top"], ["w:start"], ["w:left"], ["w:bottom"], ["w:end"], ["w:right"], ["w:insideH"], ["w:insideV"]],
  "w:tr": [["w:trPr"], ["w:tc"]],
  "w:trPr": [["w:cnfStyle"], ["w:divId"], ["w:gridBefore"], ["w:gridAfter"], ["w:wBefore"], ["w:wAfter"], ["w:cantSplit"], ["w:trHeight"], ["w:tblHeader"], ["w:tblCellSpacing"], ["w:jc"], ["w:hidden"]],
  "w:tc": [["w:tcPr"], ["w:p", "w:tbl"]],
  "w:tcPr": [["w:cnfStyle"], ["w:tcW"], ["w:gridSpan"], ["w:hMerge"], ["w:vMerge"], ["w:tcBorders"], ["w:shd"], ["w:noWrap"], ["w:tcMar"], ["w:textDirection"], ["w:tcFitText"], ["w:vAlign"], ["w:hideMark"]],
  "w:body": [["w:p", "w:tbl"], ["w:sectPr"]],
  "w:sectPr": [["w:headerReference", "w:footerReference"], ["w:footnotePr"], ["w:endnotePr"], ["w:type"], ["w:pgSz"], ["w:pgMar"], ["w:paperSrc"], ["w:pgBorders"], ["w:lnNumType"], ["w:pgNumType"], ["w:cols"], ["w:docGrid"]],
  "w:styles": [["w:docDefaults"], ["w:latentStyles"], ["w:style"]],
  "w:style": [["w:name"], ["w:aliases"], ["w:basedOn"], ["w:next"], ["w:link"], ["w:qFormat"], ["w:locked"], ["w:pPr"], ["w:rPr"], ["w:tblPr"], ["w:trPr"], ["w:tcPr"], ["w:tblStylePr"]],
  "w:docDefaults": [["w:rPrDefault"], ["w:pPrDefault"]],
  "w:rPrDefault": [["w:rPr"]],
};

/**
 * The only single-name groups that may repeat. ECMA-376 declares these with
 * maxOccurs unbounded (CT_Tbl's rows, CT_Row's cells, CT_Styles' style, and
 * CT_Style's conditional formatting). Every other single-name group is a
 * single-occurrence child and two of them is a repair prompt.
 */
const REPEATABLE_CHILDREN = new Set(["w:tr", "w:tc", "w:style", "w:tblStylePr"]);

function assertChildOrder(root: Node): void {
  walk(root, (node) => {
    const groups = PERMITTED_ORDER[node.name];
    if (groups === undefined) return;
    const positions = node.children.map((child) => {
      const group = groups.findIndex((names) => names.includes(child.name));
      assert.notEqual(
        group,
        -1,
        `${node.name} has a child outside the permitted sequence: ${node.children.map((c) => c.name).join(", ")}`,
      );
      return group;
    });
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      `${node.name} children are out of order: ${node.children.map((c) => c.name).join(", ")}`,
    );

    // CT_Style takes one w:pPr and one w:rPr, so a second one is invalid even
    // though it is still "in order". An order check alone cannot catch that.
    groups.forEach((names, index) => {
      if (names.length > 1 || REPEATABLE_CHILDREN.has(names[0] ?? "")) return;
      const count = positions.filter((position) => position === index).length;
      assert.ok(count <= 1, `${node.name} repeats ${String(names[0])} ${String(count)} times`);
    });
  });
}

const RICH = {
  title: "Revenue",
  author: "kriday",
  blocks: [
    { type: "heading", level: 1, runs: [{ text: "Revenue" }] },
    { type: "heading", level: 2, runs: [{ text: "By region" }] },
    { type: "paragraph", style: "quote", runs: [{ text: "Fish & Chips", marks: ["italic"] }] },
    { type: "paragraph", runs: [{ text: "  indented\tcolumn\nsecond line  ", marks: ["code", "bold"] }] },
    { type: "pageBreak" },
    {
      type: "table",
      columnWidths: [4675, 4675],
      headerRow: true,
      rows: [
        [{ runs: [{ text: "Quarter" }] }, { runs: [{ text: "Total" }] }],
        [{ runs: [{ text: "Both regions" }], colSpan: 2 }],
      ],
    },
    { type: "paragraph", runs: [{ text: "Ünïcode: 日本語 ✓ 🎉" }] },
  ],
} as const;

function richXml(): string {
  return buildDocumentXml(DocxDocumentSchema.parse(RICH));
}

describe("docx vocabulary (D-6 unit 2)", () => {
  it("emits the elements in the order the content models permit", () => {
    assertChildOrder(parseXml(richXml()));
    assertChildOrder(parseXml(buildStylesXml()));
  });

  it("gives the headings a size, not just bold", () => {
    // A heading style with no w:sz is a bold paragraph that claims to be a
    // heading. There is no theme part here, so Word's own asciiTheme sizes
    // would render as nothing and the size has to be explicit.
    const styles = all(buildStylesXml());
    const sizeOf = (styleId: string): string | undefined => {
      const style = styles.find((node) => node.attrs["w:styleId"] === styleId);
      const runProperties = style?.children.find((child) => child.name === "w:rPr");
      return runProperties?.children.find((child) => child.name === "w:sz")?.attrs["w:val"];
    };
    const normal = sizeOf(STYLE_IDS.normal) ?? BODY_DEFAULT_HALF_POINTS;
    assert.equal(sizeOf(STYLE_IDS.heading1), "32");
    assert.equal(sizeOf(STYLE_IDS.heading2), "28");
    assert.equal(sizeOf(STYLE_IDS.heading3), "24");
    assert.equal(sizeOf(STYLE_IDS.title), "56");
    // And the ladder is actually descending.
    const ladder = ["32", "28", "24"].map(Number);
    assert.deepEqual(ladder, [...ladder].sort((a, b) => b - a));
    assert.ok(Number("24") > Number(normal), "the smallest heading is still larger than the body");
  });

  it("resolves every w:pStyle to a declared styleId", () => {
    // The silent failure: an unresolvable style is not an error to a reader,
    // it is a heading that silently renders as body text.
    const declared = new Set(
      all(buildStylesXml())
        .filter((node) => node.name === "w:style")
        .map((node) => node.attrs["w:styleId"] ?? ""),
    );
    assert.ok(declared.size > 0);
    const referenced = all(richXml())
      .filter((node) => node.name === "w:pStyle" || node.name === "w:rStyle" || node.name === "w:tblStyle")
      .map((node) => node.attrs["w:val"] ?? "");
    assert.ok(referenced.length > 0);
    for (const value of referenced) {
      assert.ok(declared.has(value), `w:val="${value}" resolves to no declared styleId`);
    }
  });

  it("carries the styleId, never the style name", () => {
    const xml = richXml();
    // "heading 1" is the name of Heading1. Writing it as a val resolves to
    // nothing, which is the same failure wearing a second disguise.
    assert.ok(!xml.includes('w:val="heading 1"'));
    assert.ok(xml.includes('w:val="Heading1"'));
  });

  it("keeps w:sectPr as the last child of w:body", () => {
    const body = all(richXml()).find((node) => node.name === "w:body");
    assert.ok(body !== undefined);
    assert.equal(body.children.at(-1)?.name, "w:sectPr");
  });

  it("turns newlines into w:br and tabs into w:tab", () => {
    const nodes = all(richXml());
    const brs = nodes.filter((node) => node.name === "w:br");
    assert.ok(brs.some((br) => br.attrs["w:type"] === "page"), "the page break block");
    assert.ok(
      brs.some((br) => br.attrs["w:type"] === undefined),
      "a newline inside a run",
    );
    assert.equal(nodes.filter((node) => node.name === "w:tab").length, 1);
    // A literal newline inside w:t is not a line break, and a literal tab is
    // not a tab stop: the reader renders them as a space or as nothing.
    for (const text of nodes.filter((node) => node.name === "w:t")) {
      assert.ok(
        !text.text.includes("\n") && !text.text.includes("\t"),
        `w:t carries a raw control character: ${JSON.stringify(text.text)}`,
      );
    }
  });

  it("sets xml:space on every w:t", () => {
    const texts = all(richXml()).filter((node) => node.name === "w:t");
    assert.ok(texts.length > 0);
    for (const text of texts) {
      assert.equal(text.attrs["xml:space"], "preserve");
    }
  });

  it("emits a page break as one paragraph with one run holding one w:br", () => {
    const withBreak = DocxDocumentSchema.parse({
      blocks: [
        { type: "paragraph", runs: [{ text: "before" }] },
        { type: "pageBreak" },
        { type: "paragraph", runs: [{ text: "after" }] },
      ],
    });
    const paragraphs = all(buildDocumentXml(withBreak)).filter((node) => node.name === "w:p");
    // Two paragraphs, one paragraph break block, one sectPr child of body.
    assert.equal(paragraphs.length, 3);
    const breakParagraph = paragraphs[1];
    assert.equal(breakParagraph?.children.length, 1);
    assert.equal(breakParagraph?.children[0]?.name, "w:r");
    assert.equal(breakParagraph?.children[0]?.children.length, 1);
    assert.equal(breakParagraph?.children[0]?.children[0]?.attrs["w:type"], "page");
  });

  it("emits marks in CT_RPr order", () => {
    const node = all(
      buildDocumentXml(
        DocxDocumentSchema.parse({
          blocks: [
            {
              type: "paragraph",
              runs: [{ text: "x", marks: ["underline", "bold", "code", "strike"] }],
            },
          ],
        }),
      ),
    ).find((candidate) => candidate.name === "w:rPr");
    assert.ok(node !== undefined);
    assert.deepEqual(node.children.map((child) => child.name), [
      "w:rStyle",
      "w:b",
      "w:strike",
      "w:u",
    ]);
  });

  it("writes a table a reader renders as a table", () => {
    const nodes = all(richXml());
    const table = nodes.find((node) => node.name === "w:tbl");
    assert.ok(table !== undefined);
    assert.ok(table.children.find((c) => c.name === "w:tblGrid"), "tblGrid, which Word needs");
    const borders = nodes.filter((node) => node.name === "w:tblBorders");
    assert.equal(borders.length, 1);
    assert.deepEqual(borders[0]?.children.map((c) => c.name), [
      "w:top",
      "w:left",
      "w:bottom",
      "w:right",
      "w:insideH",
      "w:insideV",
    ]);
    const gridColumns = nodes.filter((node) => node.name === "w:gridCol");
    assert.deepEqual(gridColumns.map((c) => c.attrs["w:w"]), ["4675", "4675"]);
    assert.ok(nodes.some((node) => node.name === "w:gridSpan"), "the merged cell");
    assert.equal(nodes.find((node) => node.name === "w:gridSpan")?.attrs["w:val"], "2");
    assert.ok(nodes.some((node) => node.name === "w:tblHeader"), "the repeating header row");
    // Every cell declares a width, so a fixed layout has something to honour.
    assert.equal(nodes.filter((node) => node.name === "w:tcW").length, 3);
  });

  it("gives a spanning cell the width of every column it covers", () => {
    // tcW is the preferred width of the whole cell. Declaring one column's
    // width for a two-column span makes Word reconcile the row against the one
    // above it, which slides the cell boundary out from under the header.
    const nodes = all(
      buildDocumentXml(
        DocxDocumentSchema.parse({
          blocks: [
            {
              type: "table",
              columnWidths: [2000, 3000, 4000],
              rows: [
                [
                  { runs: [{ text: "a" }] },
                  { runs: [{ text: "b" }] },
                  { runs: [{ text: "c" }] },
                ],
                [{ runs: [{ text: "wide" }], colSpan: 2 }, { runs: [{ text: "c" }] }],
                [{ runs: [{ text: "all" }], colSpan: 3 }],
              ],
            },
          ],
        }),
      ),
    );
    const widths = nodes
      .filter((node) => node.name === "w:tcW")
      .map((node) => node.attrs["w:w"]);
    assert.deepEqual(widths, [
      "2000",
      "3000",
      "4000",
      "5000", // the two columns this cell spans
      "4000", // the grid cursor carried on to the third column
      "9000", // the whole grid
    ]);
  });

  it("writes nothing it promised to leave out", () => {
    const documentXml = richXml();
    const stylesXml = buildStylesXml();
    // Compared on element names, not substrings: "<w:ins" is a prefix of
    // "<w:insideH", which would make a substring check pass for the wrong reason.
    const names = new Set([
      ...all(documentXml).map((node) => node.name),
      ...all(stylesXml).map((node) => node.name),
    ]);
    for (const banned of [
      "w:ins",
      "w:del",
      "w:commentRangeStart",
      "w:hyperlink",
      "w:numPr",
      "w:latentStyles",
      "w:sectPrChange",
      "w:pPrChange",
      "w:rPrChange",
    ]) {
      assert.ok(!names.has(banned), `${banned} must never be emitted`);
    }
    // No theme part, so these would render as nothing.
    assert.ok(!documentXml.includes("themeColor"));
    assert.ok(!documentXml.includes("asciiTheme"));
  });

  it("leaves text that has to survive intact", () => {
    const document = DocxDocumentSchema.parse(RICH);
    const xml = buildDocumentXml(document);
    assert.ok(xml.includes("Ünïcode: 日本語 ✓ 🎉"), "unicode and emoji");
    assert.ok(xml.includes("Fish &amp; Chips"), "escaped exactly once");
    assert.ok(!xml.includes("&amp;amp;"), "not escaped twice");
    assert.ok(xml.includes("  indented"), "leading spaces survive");
  });
});
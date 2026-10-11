import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DocxDocumentSchema,
  MAX_DOCUMENT_BLOCKS,
  MAX_RUN_CHARS,
  MAX_RUNS_PER_BLOCK,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  ParagraphStyleSchema,
  MarkSchema,
  BlockSchema,
} from "./office.js";

const run = (text: string) => ({ text });

function doc(blocks: unknown[]): unknown {
  return { blocks };
}

/** A document whose every part parses, for tests that vary one field. */
function minimalDoc(): unknown {
  return doc([{ type: "paragraph", runs: [run("hello")] }]);
}

function firstIssue(input: unknown): string {
  const result = DocxDocumentSchema.safeParse(input);
  assert.equal(result.success, false, "expected the document to be refused");
  assert.ok(result.error.issues.length > 0);
  return result.error.issues[0]?.message ?? "";
}

describe("office document model (D-6 unit 1)", () => {
  it("accepts a minimal document and fills the defaults", () => {
    const result = DocxDocumentSchema.safeParse(minimalDoc());
    assert.ok(result.success);
    const parsed = result.data;
    const first = parsed.blocks[0];
    assert.equal(first?.type, "paragraph");
    assert.equal(first?.type === "paragraph" ? first.style : "", "normal");
    const firstRun = first?.type === "paragraph" ? first.runs[0] : undefined;
    assert.deepEqual(firstRun?.marks, []);
  });

  it("refuses a document with no blocks", () => {
    assert.equal(firstIssue(doc([])).length > 0, true);
  });

  it("refuses an unknown field rather than dropping it", () => {
    assert.equal(firstIssue({ ...(minimalDoc() as object), colour: "red" }).length > 0, true);
    assert.equal(
      firstIssue(doc([{ type: "paragraph", runs: [], font: "comic" }])).length > 0,
      true,
    );
  });

  it("refuses a style it does not declare, which would render as body text", () => {
    // MS Learn is explicit that an unknown style is not an error, so this is
    // the case a closed enum exists to catch.
    for (const style of ["heading1", "Heading1", "body", "Normal", ""]) {
      assert.equal(
        firstIssue(doc([{ type: "paragraph", style, runs: [run("x")] }])).length > 0,
        true,
        `style ${JSON.stringify(style)} must be refused`,
      );
    }
    assert.deepEqual([...ParagraphStyleSchema.options], ["normal", "title", "quote"]);
  });

  it("maps heading levels to the three heading styles that exist", () => {
    for (const level of [1, 2, 3]) {
      const result = DocxDocumentSchema.safeParse(
        doc([{ type: "heading", level, runs: [run("Title")] }]),
      );
      assert.ok(result.success, `level ${String(level)} must parse`);
    }
    for (const level of [0, 4, 1.5, "1", null]) {
      assert.equal(
        firstIssue(doc([{ type: "heading", level, runs: [run("x")] }])).length > 0,
        true,
        `level ${JSON.stringify(level)} must be refused`,
      );
    }
  });

  it("refuses an unknown block type, including the list unit 3 will add", () => {
    // Numbering is its own part with its own strict order, so accepting a
    // list here would only defer the failure to the emitter.
    for (const block of [
      { type: "list", items: ["a"] },
      { type: "image", src: "a.png" },
      { type: "image", src: "a.png", alt: "a" },
      { type: "link", href: "https://example.com", text: "x" },
    ]) {
      assert.equal(
        firstIssue(doc([block])).length > 0,
        true,
        `${String(block.type)} must not be accepted yet`,
      );
    }
    assert.equal(BlockSchema.safeParse({ type: "pageBreak" }).success, true);
  });

  it("refuses a repeated mark instead of emitting it twice", () => {
    const result = DocxDocumentSchema.safeParse(
      doc([{ type: "paragraph", runs: [{ text: "x", marks: ["bold", "bold"] }] }]),
    );
    assert.equal(result.success, false);
    assert.equal(BlockSchema.safeParse({ type: "pageBreak" }).success, true);
    assert.ok(MarkSchema.options.includes("code"));
  });

  it("refuses an empty run but allows a blank paragraph", () => {
    assert.equal(firstIssue(doc([{ type: "paragraph", runs: [run("")] }])).length > 0, true);
    const blank = DocxDocumentSchema.safeParse(doc([{ type: "paragraph", runs: [] }]));
    assert.ok(blank.success, "a blank line is a real thing in a document");
  });

  it("checks the cell geometry of a table", () => {
    const table = (rows: unknown, columnWidths: number[]) =>
      doc([{ type: "table", columnWidths, rows }]);

    const ok = DocxDocumentSchema.safeParse(
      table([[{ runs: [run("a")] }, { runs: [run("b")] }]], [4675, 4675]),
    );
    assert.ok(ok.success);

    // A row that does not add up to the declared grid.
    assert.equal(
      firstIssue(table([[{ runs: [run("a")] }]], [4675, 4675])).length > 0,
      true,
    );
    assert.equal(
      firstIssue(
        table([[{ runs: [run("a")] }, { runs: [run("b")] }, { runs: [run("c")] }]], [
          4675, 4675,
        ]),
      ).length > 0,
      true,
    );
    assert.equal(firstIssue(table([[]], [4675])).length > 0, true);

    // colSpan is how a row covers the grid with fewer cells.
    const spanned = DocxDocumentSchema.safeParse(
      table(
        [[{ runs: [run("wide")], colSpan: 2 }], [{ runs: [run("a")] }, { runs: [run("b")] }]],
        [4675, 4675],
      ),
    );
    assert.ok(spanned.success);

    // A span that overshoots the grid.
    assert.equal(
      firstIssue(
        table([[{ runs: [run("wide")], colSpan: 3 }]], [4675, 4675]),
      ).length > 0,
      true,
    );
  });

  it("caps a table at the cell budget the engine can hold", () => {
    const rows = Array.from({ length: MAX_TABLE_CELLS / 2 }, () => [
      { runs: [run("a")] },
      { runs: [run("b")] },
    ]);
    const atCap = DocxDocumentSchema.safeParse(doc([{ type: "table", columnWidths: [1, 1], rows }]));
    assert.ok(atCap.success, `${String(MAX_TABLE_CELLS)} cells must be allowed`);

    const overCap = DocxDocumentSchema.safeParse(
      doc([{ type: "table", columnWidths: [1, 1], rows: [...rows, rows[0] as never] }]),
    );
    assert.equal(overCap.success, false);
    assert.match(firstIssue({ blocks: [{ type: "table", columnWidths: [1, 1], rows: [...rows, rows[0] as never] }] }), /at most/);
  });

  it("caps the column count", () => {
    const cell = { runs: [run("a")] };
    const widths = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => 4675);
    assert.equal(
      firstIssue(doc([{ type: "table", columnWidths: widths, rows: [[cell]] }]))
        .length > 0,
      true,
    );
    // A row still has to span the whole grid, so the row carries every column.
    const fullRow = Array.from({ length: MAX_TABLE_COLUMNS }, () => cell);
    assert.ok(
      DocxDocumentSchema.safeParse(
        doc([{ type: "table", columnWidths: widths.slice(0, -1), rows: [fullRow] }]),
      ).success,
      `${String(MAX_TABLE_COLUMNS)} columns must be allowed`,
    );
  });

  it("caps runs per block, characters per run, and blocks per document", () => {
    const runs = Array.from({ length: MAX_RUNS_PER_BLOCK + 1 }, () => run("x"));
    assert.equal(
      firstIssue(doc([{ type: "paragraph", runs }])).length > 0,
      true,
    );
    const ok = DocxDocumentSchema.safeParse(
      doc([{ type: "paragraph", runs: runs.slice(0, -1) }]),
    );
    assert.ok(ok.success);

    assert.equal(
      firstIssue(doc([{ type: "paragraph", runs: [run("x".repeat(MAX_RUN_CHARS + 1))] }])).length > 0,
      true,
    );

    const blocks = Array.from({ length: MAX_DOCUMENT_BLOCKS + 1 }, () => ({
      type: "paragraph",
      runs: [run("x")],
    }));
    assert.equal(firstIssue(doc(blocks)).length > 0, true);
    assert.ok(
      DocxDocumentSchema.safeParse(doc(blocks.slice(0, -1))).success,
      `${String(MAX_DOCUMENT_BLOCKS)} blocks must be allowed`,
    );
  });

  it("carries no date field, so the same JSON gives the same bytes", () => {
    assert.equal(DocxDocumentSchema.safeParse({ ...(minimalDoc() as object), created: "2026-01-01" }).success, false);
    assert.ok(DocxDocumentSchema.safeParse({ ...(minimalDoc() as object), title: "Report", author: "kriday" }).success);
  });
});
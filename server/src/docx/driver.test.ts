import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import {
  DocxDocumentSchema,
  MAX_DOCUMENT_BLOCKS,
  MAX_RUNS_PER_BLOCK,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
} from "@k5-work/shared";
import { validateSpec, validateZipBytes } from "../ooxml-core/validate.js";
import { MAX_XML_ELEMENTS } from "../ooxml-core/index.js";
import { findLibreOffice, readDocument } from "../ooxml-core/libreoffice.js";
import { buildDocx, buildPackageSpec } from "./driver.js";
import { CORE_PART, FIXED_TIMESTAMP, MAIN_PART, OFFICE_DOC_REL, STYLES_PART } from "./names.js";

const SAMPLE = {
  title: "Revenue",
  author: "kriday",
  blocks: [
    { type: "heading", level: 1, runs: [{ text: "Revenue" }] },
    { type: "paragraph", runs: [{ text: "Up 12 percent", marks: ["bold"] }] },
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
  ],
} as const;

function entriesOf(bytes: Uint8Array): Record<string, string> {
  const raw = unzipSync(bytes);
  return Object.fromEntries(
    Object.entries(raw).map(([name, data]) => [name, strFromU8(data)]),
  );
}

/** Gate one: both engine gates, on the spec and again on the packed bytes. */
function assertEngineAccepts(bytes: Uint8Array): void {
  const spec = buildPackageSpec(DocxDocumentSchema.parse(SAMPLE));
  assert.deepEqual(validateSpec(spec, { mainPart: MAIN_PART }), {
    ok: true,
    errors: [],
    warnings: [],
  });
  assert.deepEqual(validateZipBytes(bytes, { mainPart: MAIN_PART }), {
    ok: true,
    errors: [],
    warnings: [],
  });
}

describe("docx driver (D-6 unit 2)", () => {
  it("writes a package whose every part is reachable", () => {
    const bytes = buildDocx(SAMPLE);
    const entries = entriesOf(bytes);
    assert.deepEqual(Object.keys(entries).sort(), [
      "[Content_Types].xml",
      "_rels/.rels",
      CORE_PART,
      "word/_rels/document.xml.rels",
      MAIN_PART,
      STYLES_PART,
    ]);
    // The engine's reachability gate is what makes these relationships
    // mandatory: without them styles.xml and core.xml ship and get ignored.
    assert.ok(entries["_rels/.rels"].includes(OFFICE_DOC_REL));
    assert.ok(entries["_rels/.rels"].includes("metadata/core-properties"));
    assert.ok(entries["word/_rels/document.xml.rels"].includes("/styles"));
    assertEngineAccepts(bytes);
  });

  it("refuses a document that is not valid, at the boundary", () => {
    assert.throws(() => buildDocx({ blocks: [{ type: "list", items: ["a"] }] }));
    assert.throws(() => buildDocx({ blocks: [] }));
    assert.throws(() => buildDocx({ blocks: [{ type: "paragraph", runs: [], style: "Heading1" }] }));
  });

  it("is deterministic: the same JSON gives the same bytes", () => {
    // The docProps timestamps are pinned to a constant and the ZIP writer sorts
    // its entries, so this is byte-identical, not merely equivalent.
    const first = buildDocx(SAMPLE);
    const second = buildDocx(SAMPLE);
    assert.deepEqual([...first], [...second]);

    // The invariant is that every timestamp written is the pinned one, so a
    // future Date.now() anywhere in the properties fails here rather than
    // quietly making two builds differ.
    const core = strFromU8(unzipSync(first)[CORE_PART] ?? new Uint8Array());
    const written = [...core.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g)].map(
      (match) => match[0],
    );
    assert.equal(written.length, 2, "created and modified, and nothing else");
    for (const value of written) assert.equal(value, FIXED_TIMESTAMP);
  });

  it("builds the 3,000-row table the ratio guard used to refuse", () => {
    const rows = Array.from({ length: MAX_TABLE_CELLS / 2 }, (_, index) => [
      { runs: [{ text: `r${String(index)}` }] },
      { runs: [{ text: `v${String(index)}` }] },
    ]);
    const document = DocxDocumentSchema.parse({
      blocks: [{ type: "table", columnWidths: [4675, 4675], rows }],
    });
    assert.equal(document.blocks.length, 1);

    const started = Date.now();
    const bytes = buildDocx(document);
    const elapsedMs = Date.now() - started;
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    const spec = buildPackageSpec(document);
    assert.deepEqual(validateSpec(spec, { mainPart: MAIN_PART }), {
      ok: true,
      errors: [],
      warnings: [],
    });
    assert.deepEqual(validateZipBytes(bytes, { mainPart: MAIN_PART }), {
      ok: true,
      errors: [],
      warnings: [],
    });
    // The potato-friendly pillar is a claim about a measurement, so the
    // measurement is recorded and given a regression bound. The bound is
    // deliberately loose: this catches a pathological regression, not a slow
    // machine. Measured on this host, the numbers below.
    process.stderr.write(
      `k5 docx worst case: ${String(MAX_TABLE_CELLS)} cells in ${String(elapsedMs)}ms, ` +
        `${String(Math.round(bytes.byteLength / 1024))} KiB, peak RSS ${String(rssMb)} MiB\n`,
    );
    assert.ok(elapsedMs < 15_000, `3,000 rows took ${String(elapsedMs)}ms`);
    assert.ok(rssMb < 1024, `peak RSS ${String(rssMb)} MiB`);
  });

  it("keeps the shared caps under the engine's element budget", () => {
    // shared cannot import the engine's constants, so unit 1 states the
    // arithmetic in a comment and this is where the two sides are checked
    // against each other. If either number moves, one of the assertions below
    // fails here rather than in a document the engine refuses at 100,000
    // elements with an error that names a limit nobody in the model mentioned.
    const worstTextBlock = 1 + 2 * MAX_RUNS_PER_BLOCK;
    const worstDocument = MAX_DOCUMENT_BLOCKS * worstTextBlock;
    // w:tbl, w:tblPr, w:tblGrid and a gridCol per column, then per cell a w:tc,
    // w:tcPr, w:p, w:r and w:t, and per row a w:tr and w:trPr.
    const worstTable = 4 + MAX_TABLE_COLUMNS + MAX_TABLE_CELLS * 6 + (MAX_TABLE_CELLS / 2) * 2;

    assert.ok(
      worstDocument + worstTable < MAX_XML_ELEMENTS,
      `worst case is ${String(worstDocument + worstTable)} elements, over the engine's ${String(MAX_XML_ELEMENTS)}`,
    );
    // And the shared block cap has to be expressible, or a document the model
    // accepts could never be written.
    assert.ok(MAX_TABLE_CELLS >= 6_000, "the 3,000-row two-column fixture must fit");
  });

  it("opens in LibreOffice as a document that renders as one", (t) => {
    const command = findLibreOffice();
    if (command === undefined) {
      t.skip("LibreOffice executable not found");
      return;
    }
    const read = readDocument(command, buildDocx(SAMPLE));

    // Content, from what a reader actually shows.
    assert.match(read.text, /Revenue/);
    assert.match(read.text, /Up 12 percent/);
    assert.match(read.text, /Quarter/);
    assert.match(read.text, /Both regions/);

    // Formatting, which an exit code cannot see: a heading that silently
    // rendered as body text would still pass every check above.
    assert.ok(read.flatOdf.includes("<text:h"), "the heading is a heading");
    assert.ok(
      /<text:h[^>]*text:outline-level="1"/.test(read.flatOdf),
      "the reader resolved it to outline level 1, not just any bold paragraph",
    );
    assert.ok(read.flatOdf.includes("<table:table"), "the table is a table");
    assert.match(read.flatOdf, /font-weight="bold"/, "the bold run and the header row");
    // One table, two columns, three cells: the merged cell is still a cell.
    assert.equal((read.flatOdf.match(/<table:table-cell/g) ?? []).length, 3);
  });
});
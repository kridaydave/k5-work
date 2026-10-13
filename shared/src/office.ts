import { z } from "zod";

// The document model a harness emits. Nothing in this file writes XML: the
// driver reads this and produces the part strings, and the engine packs the
// ZIP. That split is SPEC item 3 and AGENTS.md:85, JSON-in and engine-out.
//
// The style vocabularies are closed on purpose. MS Learn is explicit that
// "applying a style that does not exist to a paragraph has no effect; there is
// no exception generated and no formatting changes occur", so an open string
// here would not fail the build. It would produce a document that opens
// perfectly clean and renders every heading as body text. Every style a block
// can name has a matching w:styleId in the styles part the driver emits.
//
// There is no `list` block yet. Numbering is its own part with its own strict
// child sequence, and it ships in its own unit; until the emitter can render
// one, accepting the block would only defer the failure.

// --- caps ---
//
// These tighten MAX_XML_ELEMENTS (100_000) and MAX_XML_DEPTH (256) in
// server/src/ooxml-core/validate.ts. Those constants live in the server and
// shared cannot import them, so the arithmetic below is stated here and the
// driver asserts the two sides agree against the engine's exports.
//
// Worst case per text block: one w:p plus two elements per run (w:r and w:t),
// so 1 + 2 * MAX_RUNS_PER_BLOCK. Worst case for a table: one w:tbl, a w:tblPr,
// a w:tblGrid and its gridCol, then per row a w:tr and w:trPr, and per cell a
// w:tc, w:tcPr, w:p, w:r and w:t. That is roughly 6 elements per cell, which
// puts the cell cap at about 36,000 elements, and 400 full text blocks at
// 32,400, for 68,400 of the engine's 100,000. The engine stays the backstop.

/** Inline runs in one paragraph or heading. 40 runs is about 81 elements. */
export const MAX_RUNS_PER_BLOCK = 40;
/** Blocks in one document. Caps total paragraph elements. */
export const MAX_DOCUMENT_BLOCKS = 400;
/** Cells in one table, spans included. Caps the table's element budget. */
export const MAX_TABLE_CELLS = 6_000;
/** Columns in one table. Also bounds a single cell's colSpan. */
export const MAX_TABLE_COLUMNS = 32;
/** Characters in one run, which becomes one w:t. */
export const MAX_RUN_CHARS = 8_000;

// --- runs and marks ---

/**
 * Character formatting, mapped to the w:rPr child order in ECMA-376. "code"
 * is the one mark that is a character style rather than a toggle, because
 * there is no theme part here to borrow a monospace face from.
 */
export const MarkSchema = z.enum(["bold", "italic", "underline", "strike", "code"]);
export type Mark = z.infer<typeof MarkSchema>;

/**
 * Marks are a set, not a bag: `<w:b/><w:b/>` is tolerated by readers but has
 * no meaning, so it is refused here rather than deduplicated in the emitter.
 */
const MarkListSchema = z
  .array(MarkSchema)
  .max(MAX_RUNS_PER_BLOCK)
  .refine(
    (marks) => new Set(marks).size === marks.length,
    "a run cannot carry the same mark twice",
  );

export const RunSchema = z
  .object({
    text: z.string().min(1).max(MAX_RUN_CHARS),
    marks: MarkListSchema.default([]),
  })
  .strict();
export type Run = z.infer<typeof RunSchema>;

// --- blocks ---

/**
 * The paragraph styles this model can name. Heading1 through Heading3 are not
 * here because the `heading` block owns them and maps its level to them, so
 * two ways of asking for a heading would exist otherwise. A reader applying
 * the wrong style silently gets body text, so each value here is exactly one
 * w:styleId: Normal, Title, Quote.
 */
export const ParagraphStyleSchema = z.enum(["normal", "title", "quote"]);
export type ParagraphStyle = z.infer<typeof ParagraphStyleSchema>;

/** Heading 4 does not exist in the styles part, so it is not a level. */
export const HeadingLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type HeadingLevel = z.infer<typeof HeadingLevelSchema>;

export const ParagraphBlockSchema = z
  .object({
    type: z.literal("paragraph"),
    style: ParagraphStyleSchema.default("normal"),
    // Zero runs is a blank line, which is a thing a document can contain, so
    // it is allowed. A run with no text is not: it emits an empty w:t.
    runs: z.array(RunSchema).max(MAX_RUNS_PER_BLOCK),
  })
  .strict();
export type ParagraphBlock = z.infer<typeof ParagraphBlockSchema>;

export const HeadingBlockSchema = z
  .object({
    type: z.literal("heading"),
    level: HeadingLevelSchema,
    runs: z.array(RunSchema).max(MAX_RUNS_PER_BLOCK),
  })
  .strict();
export type HeadingBlock = z.infer<typeof HeadingBlockSchema>;

/**
 * A cell holds runs, not blocks. Word requires a cell to end in a paragraph
 * and a table cell holding a nested table is its own element-order problem,
 * so a cell is inline content and the emitter supplies the w:p.
 */
export const CellSchema = z
  .object({
    runs: z.array(RunSchema).max(MAX_RUNS_PER_BLOCK),
    colSpan: z.number().int().min(1).max(MAX_TABLE_COLUMNS).default(1),
  })
  .strict();
export type Cell = z.infer<typeof CellSchema>;

/** Column widths in twips. Word's page body is about 9,360. */
const ColumnWidthSchema = z.number().int().min(1).max(20_000);

export const TableBlockSchema = z
  .object({
    type: z.literal("table"),
    columnWidths: z.array(ColumnWidthSchema).min(1).max(MAX_TABLE_COLUMNS),
    /** Repeats across pages and renders bold. Needs the tblHeader flag. */
    headerRow: z.boolean().default(false),
    rows: z.array(z.array(CellSchema)).min(1),
  })
  .strict();
export type TableBlock = z.infer<typeof TableBlockSchema>;

/**
 * A page break is a paragraph carrying one run holding one w:br of type
 * page, not a block of its own. Modelled as a block so the emitter has a
 * single place that decides what a page break is.
 */
export const PageBreakBlockSchema = z
  .object({ type: z.literal("pageBreak") })
  .strict();
export type PageBreakBlock = z.infer<typeof PageBreakBlockSchema>;

export const BlockSchema = z.discriminatedUnion("type", [
  ParagraphBlockSchema,
  HeadingBlockSchema,
  TableBlockSchema,
  PageBreakBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;

// --- document ---

/**
 * There is no date field. The created and modified timestamps in docProps are
 * a fixed constant so the same JSON always produces the same bytes, which
 * is what the ZIP writer's determinism promise rests on.
 */
export const DocxDocumentSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    author: z.string().min(1).max(200).optional(),
    blocks: z.array(BlockSchema).min(1).max(MAX_DOCUMENT_BLOCKS),
  })
  .strict()
  // The table's own geometry is checked here rather than on the block, because
  // z.discriminatedUnion takes only plain objects in zod 3 and a refine would
  // turn the option into a ZodEffects it cannot read a discriminator from.
  .superRefine((document, ctx) => {
    document.blocks.forEach((block, index) => {
      if (block.type !== "table") return;
      const columns = block.columnWidths.length;
      const cells = block.rows.reduce((total, row) => total + row.length, 0);
      if (cells > MAX_TABLE_CELLS) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: MAX_TABLE_CELLS,
          type: "array",
          inclusive: true,
          path: [index, "rows"],
          message: `a table may hold at most ${String(MAX_TABLE_CELLS)} cells, got ${String(cells)}`,
        });
      }
      block.rows.forEach((row, rowIndex) => {
        const path = [index, "rows", rowIndex];
        if (row.length === 0 || row.length > columns) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `a row needs between 1 and ${String(columns)} cells, got ${String(row.length)}`,
          });
          return;
        }
        const span = row.reduce((total, cell) => total + cell.colSpan, 0);
        if (span !== columns) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `a row spans ${String(span)} columns but the table declares ${String(columns)}`,
          });
        }
      });
    });
  });
export type DocxDocument = z.infer<typeof DocxDocumentSchema>;
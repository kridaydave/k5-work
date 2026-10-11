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
// The binding one is the per-document cell budget, not the block count. A
// block is not a unit of size: one paragraph is a handful of elements and one
// table is thousands. Capping the block count alone let a document of 400
// tables reach 19 million elements against the engine's 100,000, so every block
// is weighted by what it actually emits and the totals are capped together.
//
// A weighted unit is one paragraph, one heading, one page break, one list item
// or one table cell. The worst any of them reaches is about eight elements
// (a cell is a w:tc, w:tcPr, w:tcW, w:p, w:pPr, w:r and w:t, plus a w:tr and
// w:trPr shared across a row), so 6,000 units is about 48,000 elements. The
// engine stays the backstop.

/** Inline runs in one paragraph, heading or list item. */
export const MAX_RUNS_PER_BLOCK = 40;
/** Top-level blocks in one document. A loose bound; the cell budget is real. */
export const MAX_DOCUMENT_BLOCKS = 400;
/**
 * Weighted units in one whole document, where a table counts its cells and a
 * list counts its items. This is the cap that keeps a document inside the
 * engine's element budget.
 */
export const MAX_DOCUMENT_CELLS = 6_000;
/** Cells in one table, spans included. Caps a single table's size. */
export const MAX_TABLE_CELLS = 6_000;
/** Columns in one table. Also bounds a single cell's colSpan. */
export const MAX_TABLE_COLUMNS = 32;
/** Characters in one run, which becomes one w:t. */
export const MAX_RUN_CHARS = 8_000;
/** Items in one list. */
export const MAX_LIST_ITEMS = 6_000;
/**
 * Nesting levels in one list. Nine, because that is what Word writes and what
 * a reader expects: a definition that declares fewer imports as plain
 * paragraphs with no list at all.
 */
export const MAX_LIST_LEVELS = 9;

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

/**
 * A list item. It carries runs, not blocks, and nests by level rather than by
 * containing another list, because w:numPr expresses depth through w:ilvl and
 * a nested list would mean deciding what the level means anyway.
 *
 * Two lists of the same format are two separate w:num entries, so the second
 * starts at one again. That is what "restart" means here: no w:lvlOverride is
 * needed, because a fresh numId is a fresh counter.
 */
export const ListItemSchema = z
  .object({
    runs: z.array(RunSchema).max(MAX_RUNS_PER_BLOCK),
    level: z.number().int().min(1).max(MAX_LIST_LEVELS).default(1),
  })
  .strict();
export type ListItem = z.infer<typeof ListItemSchema>;

export const ListBlockSchema = z
  .object({
    type: z.literal("list"),
    /** false is a bullet list, true is a decimal numbered list. */
    ordered: z.boolean().default(false),
    items: z.array(ListItemSchema).min(1).max(MAX_LIST_ITEMS),
  })
  .strict();
export type ListBlock = z.infer<typeof ListBlockSchema>;

export const BlockSchema = z.discriminatedUnion("type", [
  ParagraphBlockSchema,
  HeadingBlockSchema,
  TableBlockSchema,
  ListBlockSchema,
  PageBreakBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;

/**
 * How many weighted units a block spends against MAX_DOCUMENT_CELLS. A block
 * is not a unit of size, so the budget has to count what each one emits.
 */
export function blockWeight(block: Block): number {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "pageBreak":
      return 1;
    case "table":
      return block.rows.reduce((cells, row) => cells + row.length, 0);
    case "list":
      return block.items.length;
  }
}

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

    // The whole-document budget, weighted by what each block emits. Without
    // this, 400 blocks of full-size tables is a document the model happily
    // accepts and the engine refuses at 100,000 elements.
    const total = document.blocks.reduce((sum, block) => sum + blockWeight(block), 0);
    if (total > MAX_DOCUMENT_CELLS) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_DOCUMENT_CELLS,
        type: "array",
        inclusive: true,
        path: ["blocks"],
        message:
          `this document emits ${String(total)} paragraphs and cells, over the ` +
          `budget of ${String(MAX_DOCUMENT_CELLS)}. Shorten it rather than ` +
          `splitting it: a document this size stops being a document`,
      });
    }
  });
export type DocxDocument = z.infer<typeof DocxDocumentSchema>;
# The office document model

What a harness emits to create a Word document, and what refuses it. The schema
is `DocxDocumentSchema` in [shared/src/office.ts](../shared/src/office.ts). This
page is the contract; the schema is the enforcement. Nothing here is raw XML:
the driver turns this JSON into WordprocessingML parts and the engine packs the
ZIP, so the caller never handles element order or relationship ids.

## Shape

```json
{
  "title": "Quarterly notes",
  "author": "kriday",
  "blocks": [
    { "type": "heading", "level": 1, "runs": [{ "text": "Revenue" }] },
    {
      "type": "paragraph",
      "style": "normal",
      "runs": [
        { "text": "Up " , "marks": ["bold"] },
        { "text": "12 percent", "marks": ["italic"] }
      ]
    },
    { "type": "pageBreak" },
    {
      "type": "list",
      "ordered": true,
      "items": [
        { "runs": [{ "text": "Europe" }] },
        { "runs": [{ "text": "Asia" }], "level": 2 }
      ]
    },
    {
      "type": "table",
      "columnWidths": [4675, 4675],
      "headerRow": true,
      "rows": [
        [{ "runs": [{ "text": "Quarter" }] }, { "runs": [{ "text": "Total" }] }],
        [
          { "runs": [{ "text": "Q1" }] },
          { "runs": [{ "text": "All regions", "marks": ["bold"] }] }
        ]
      ]
    }
  ]
}
```

`title` and `author` are optional and land in the document properties. There is
no date field: the created and modified timestamps are a fixed constant so the
same JSON always produces the same bytes.

## Blocks

`paragraph`, `heading`, `table`, `list`, `pageBreak`. Image, link, quote and
table of contents are deliberately absent: each is a new part with its own
relationship and element-order rules, and the model has no block the emitter
cannot honour.

A `heading` takes a level of 1, 2 or 3, which map to the three heading styles
the styles part declares. Paragraph style is `normal`, `title` or `quote`.
Marks are `bold`, `italic`, `underline`, `strike` and `code`.

A `list` is a real Word list, not a bullet character typed into the text. It is
ordered or not, and each item nests by `level`, 1 through 9. Two lists of the
same format in one document are two separate lists, so the second starts at one
again.

A cell holds runs, not blocks. Word requires a cell to end in a paragraph and
the emitter supplies it.

## What gets refused, and why

| Refused | Reason |
| --- | --- |
| An unknown style or mark | An unknown style is not an error to a reader. MS Learn is explicit that applying a style that does not exist "has no effect; there is no exception generated and no formatting changes occur", so an open string would produce a document that opens perfectly clean and renders every heading as body text. |
| A heading level outside 1 to 3 | There is no `Heading4` style in the styles part, so it would hit the row above. |
| The same mark twice on one run | `<w:b/><w:b/>` has no meaning. Refused here rather than deduplicated by the emitter. |
| An empty run | It emits an empty text element. An empty paragraph is allowed, since a blank line is real. |
| A row that does not span the declared columns | A mismatched grid is what makes Word offer to repair a table. |
| An unknown field | Dropped fields are how a typo becomes a silent omission. |

## Caps

| Cap | Value |
| --- | --- |
| Paragraphs, list items and table cells, whole document | 6,000 |
| Blocks in one document | 400 |
| Runs per paragraph, heading or list item | 40 |
| Characters per run | 8,000 |
| Cells per table | 6,000 |
| Columns per table | 32 |
| Items per list | 6,000 |
| Nesting levels per list | 9 |

The 6,000 is weighted: a paragraph, a list item and a table cell each count one,
and a table contributes all of its cells. This tightens the engine's own budget
of 100,000 elements per part, and the worst case a document can reach is about
48,000 of them. Capping the block count alone would not: 400 blocks of
full-size tables is 19 million elements, which the engine refuses at build time
with an error naming a limit the model never mentioned. A refusal is the
failure mode here, never a truncated document.
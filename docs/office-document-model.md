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

`paragraph`, `heading`, `table`, `pageBreak`. There is deliberately no `list`
yet. Numbering is a separate part with a strict child sequence and it ships in
its own unit, so the model has no block the emitter cannot render.

A `heading` takes a level of 1, 2 or 3, which map to the three heading styles
the styles part declares. Paragraph style is `normal`, `title` or `quote`.
Marks are `bold`, `italic`, `underline`, `strike` and `code`.

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
| Blocks per document | 400 |
| Runs per paragraph or heading | 40 |
| Characters per run | 8,000 |
| Cells per table | 6,000 |
| Columns per table | 32 |

These tighten the engine's own element budget of 100,000 elements per part. The
worst case a document can reach is about 68,000 of them, and the engine is the
backstop if that arithmetic is ever wrong. A refusal is the failure mode here,
never a truncated document.
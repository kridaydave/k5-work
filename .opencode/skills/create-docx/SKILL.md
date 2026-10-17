---
name: create-docx
description: Emit a Word document through create_docx. Use when a task needs a .docx in the project root.
---

# create_docx document model

Use `create_docx` with `{ "filename": "name.docx", "document": { ... } }`. The
document shape is the JSON model below. Nothing is raw XML: the driver builds
WordprocessingML and the engine packs the ZIP.

## Shape

```json
{
  "title": "Quarterly notes",
  "author": "kriday",
  "blocks": [
    { "type": "heading", "level": 1, "runs": [{ "text": "Revenue" }] },
    { "type": "paragraph", "style": "normal", "runs": [{ "text": "Body", "marks": ["bold"] }] },
    { "type": "pageBreak" }
  ]
}
```

Blocks: `paragraph`, `heading`, `table`, `list`, `pageBreak`. Heading levels 1-3.
Paragraph styles: `normal`, `title`, `quote`. Marks: `bold`, `italic`,
`underline`, `strike`, `code`.

See `docs/office-document-model.md` and `docs/create-docx-model.md` for caps and
refusal rules.
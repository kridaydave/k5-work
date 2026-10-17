---
name: create-pptx
description: Emit a presentation through create_pptx. Use when a task needs a .pptx in the project root.
---

# create_pptx presentation model

Use `create_pptx` with `{ "filename": "name.pptx", "presentation": { ... } }`.
The presentation shape is the JSON model below. Nothing is raw XML: the driver
builds PresentationML and the engine packs the ZIP.

## Shape

```json
{
  "title": "Quarterly review",
  "author": "kriday",
  "slides": [
    {
      "title": "Revenue",
      "body": "Up 12 percent year over year.",
      "bullets": ["Europe", "Asia"]
    }
  ]
}
```

Slides: 1 to 50. A slide may carry `title`, `body`, `text`, `content`,
`bullets`, `items` or `lines`. Slide text fields cap at 8,000 characters and
bullet lists at 100 items.

See `docs/create-pptx-model.md` for caps and refusal rules.
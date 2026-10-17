---
name: create-xlsx
description: Emit a spreadsheet through create_xlsx. Use when a task needs a .xlsx in the project root.
---

# create_xlsx workbook model

Use `create_xlsx` with `{ "filename": "name.xlsx", "workbook": { ... } }`. The
workbook shape is the JSON model below. Nothing is raw XML: the driver builds
SpreadsheetML and the engine packs the ZIP.

## Shape

```json
{
  "title": "Quarterly notes",
  "author": "kriday",
  "sheets": [
    {
      "name": "Revenue",
      "rows": [
        [{ "value": "Quarter" }, { "value": "Total" }],
        [{ "value": "Q1" }, { "value": 12 }]
      ]
    }
  ]
}
```

Sheets: 1 to 10. Rows are arrays of cells. Each cell is `{ "value": ... }`
with a string, number, boolean or null. Columns per row: at most 32.

See `docs/create-xlsx-model.md` for caps and refusal rules.
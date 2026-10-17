# The create_xlsx workbook model

What a harness emits to `create_xlsx`, and what the tool refuses. The schema is
`XlsxWorkbookSchema` in `shared/src/xlsx.ts` and `CreateXlsxArgsSchema` in the
same file. This page is the contract; the schema is the enforcement. Nothing
here is raw XML: the driver turns this JSON into SpreadsheetML parts and the
engine packs the ZIP, so the caller never handles element order or relationship
ids.

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

`title` and `author` are optional and land in the document properties. There
is no date field: the created and modified timestamps are a fixed constant so
the same JSON always produces the same bytes.

A `create_xlsx` call takes a filename plus this workbook:

```json
{ "filename": "notes.xlsx", "workbook": { "title": "...", "sheets": [ ... ] } }
```

`filename` is a single segment ending in `.xlsx`. The tool resolves it under
the project root and refuses a path, a traversal, or a hidden name.

## Sheets

A workbook holds 1 to 10 sheets. Each sheet has a `name` of 1 to 31
characters and a `rows` array. Sheet names must be unique across the workbook
and may not contain `\`, `/`, `?`, `*`, `[`, `]` or `:`.

A row is an array of cells, 0 to 32 of them. A sheet may hold up to 1,000
rows. Cells are addressed by their position in the row; trailing empty cells
may be omitted, but a row's length declares its column count.

A cell is `{ "value": ... }` with a value that is a string, a finite
number, a boolean, or null. The string form caps at 8,000 characters. An
object or array is not a value and is refused.

## What gets refused, and why

| Refused | Reason |
| --- | --- |
| An unknown field | Dropped fields are how a typo becomes a silent omission. The workbook, sheet and cell schemas are all strict. |
| A sheet name outside 1 to 31 characters | Excel limits sheet titles to 31 characters and rejects empty titles. |
| A sheet name with `\`, `/`, `?`, `*`, `[`, `]` or `:` | These characters are reserved by Excel for sheet names and would corrupt the workbook. |
| Duplicate sheet names | Two sheets with the same name collide in the workbook part index. |
| More than 10 sheets | Keeps the workbook within the engine's part budget. |
| More than 1,000 rows per sheet | Keeps the workbook within the engine's part budget. |
| More than 32 columns per row | Keeps the column grid consistent with the declared width. |
| More than 10,000 cells across the whole workbook | Tightens the engine's own budget of 100,000 elements per part. |
| A cell string longer than 8,000 characters | Matches the engine's text run cap. |
| A non-finite number | `NaN` and `Infinity` are not valid spreadsheet values. |
| A value that is an object or array | A cell holds a scalar value, not a nested structure. |
| A filename that is not a single segment ending in `.xlsx` | Path traversal and hidden names are refused. |

## Caps

| Cap | Value |
| --- | --- |
| Sheets per workbook | 10 |
| Rows per sheet | 1,000 |
| Columns per row | 32 |
| Cells per workbook | 10,000 |
| Characters per cell string | 8,000 |
| Characters per sheet name | 31 |
| Characters per title or author | 200 |
| Characters per filename | 128 |

A refusal is the failure mode here, never a truncated document.

## Serving the result

A successful call returns a relative `path`, a `byteLength`, and a `reused`
flag. The file sits in the project root and can be fetched with `GET` on the
project file route, which returns the bytes with `Content-Disposition:
attachment` and `X-Content-Type-Options: nosniff`.
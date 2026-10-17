# The create_pptx presentation model

What a harness emits to `create_pptx`, and what the tool refuses. The schema is
`PptxPresentationSchema` in `shared/src/pptx.ts` and `CreatePptxArgsSchema` in
the same file. This page is the contract; the schema is the enforcement.
Nothing here is raw XML: the driver turns this JSON into PresentationML parts
and the engine packs the ZIP, so the caller never handles element order or
relationship ids.

## Shape

```json
{
  "title": "Quarterly review",
  "subject": "Q1 results",
  "author": "kriday",
  "creator": "kriday",
  "slides": [
    {
      "title": "Revenue",
      "body": "Up 12 percent year over year.",
      "bullets": ["Europe", "Asia"]
    }
  ]
}
```

`title`, `subject`, `author` and `creator` are optional and land in the
document properties. There is no date field: the created and modified
timestamps are a fixed constant so the same JSON always produces the same
bytes.

A `create_pptx` call takes a filename plus this presentation:

```json
{ "filename": "review.pptx", "presentation": { "title": "...", "slides": [ ... ] } }
```

`filename` is a single segment ending in `.pptx`. The tool resolves it under
the project root and refuses a path, a traversal, or a hidden name.

## Slides

A presentation holds 1 to 50 slides. Each slide may carry any combination of
the following text fields, all optional and capped at 8,000 characters:

- `title`: the slide title, 1 to 200 characters.
- `body`, `text`, `content`: free-form body text.
- `bullets`, `items`, `lines`: a list of strings, 1 to 8,000 characters each,
  up to 100 entries.

An empty slide object is accepted but carries no content. Prefer at least one
text field per slide.

## What gets refused, and why

| Refused | Reason |
| --- | --- |
| An unknown field | Dropped fields are how a typo becomes a silent omission. The presentation and slide schemas are both strict. |
| A slide title outside 1 to 200 characters | An empty title is not a title, and titles beyond the cap overflow the title placeholder. |
| A text field longer than 8,000 characters | Matches the engine's text run cap. |
| A bullet, item or line that is empty or longer than 8,000 characters | An empty bullet renders as a blank list entry. |
| More than 100 bullets, items or lines on one slide | Keeps the slide within the engine's part budget. |
| More than 50 slides | Keeps the presentation within the engine's part budget. |
| A title, subject, author or creator outside 1 to 200 characters | Empty metadata fields are refused. |
| A filename that is not a single segment ending in `.pptx` | Path traversal and hidden names are refused. |

## Caps

| Cap | Value |
| --- | --- |
| Slides per presentation | 50 |
| Slide title characters | 200 |
| Text field characters | 8,000 |
| Bullets, items or lines per slide | 100 |
| Characters per bullet, item or line | 8,000 |
| Characters per title, subject, author or creator | 200 |
| Characters per filename | 128 |

A refusal is the failure mode here, never a truncated document.

## Serving the result

A successful call returns a relative `path`, a `byteLength`, and a `reused`
flag. The file sits in the project root and can be fetched with `GET` on the
project file route, which returns the bytes with `Content-Disposition:
attachment` and `X-Content-Type-Options: nosniff`.
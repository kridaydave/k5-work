# Implementation Research: thin docx driver on k5-ooxml-core (D-6)

**Date:** 2026-10-10 (first draft), revised twice the same day after the two
adversarial passes that never ran on the first draft
**Status:** GREEN on sources, on code claims and on the re-ordered build plan. The two
measured engine blockers reproduce from the script in Local measurements, and the
six-row load table reproduces from the script there as well.

## The Task

Build `k5-docx`, a create-only Word document driver that sits on top of the shipped
`server/src/ooxml-core` (D-1 through D-4 done: ZipWriter, ContentTypes, RelScope,
PackageBuilder, dual-gate validator). The driver takes JSON, emits a `.docx` that
Word, LibreOffice, and Google Docs all open with no repair dialog.

Constraints from AGENTS.md and SPEC.md: JSON-in/engine-out (AI never touches raw
XML strings), Zod at every boundary in `shared`, MIT-clean core, potato-friendly,
true dark UI, no faked passes. SPEC item 3 names the split as a custom
`k5-ooxml-core` (ZIP + rels + content-types + ID allocator + validator) with thin
docx/xlsx/pptx drivers on top, JSON-in/engine-out. AGENTS.md:85 is the one that spells
out what the core owns: element ordering, rId allocation, content-type mapping,
Deflate packaging, with drivers thin.

The first draft of this file recommended three PRs: vocabulary plus styles, a repair
gate, then an MCP tool. Two adversarial passes that the first draft admitted had never
run were run, and they came back with findings that change the plan. Five were
blockers. Three of those are engine defects, and one of the remaining two is a plan
gap (the caps are not exported) while the last is a missing specification (the
document model does not exist yet). All five sit below the driver, so the revised plan
builds them first.

Versions read off this machine today (2026-10-10): Node `v22.23.1` at
`/usr/bin/node`, no `.nvmrc` and no version manager. Installed `tsc` is `5.9.3`; the
root, server and shared manifests declare `typescript@^5.6.3` and
`apps/web/package.json` pins `typescript` exactly to `5.9.3`. `soffice --version` is
26.2.6.3. LibreOffice in CI is the distro build installed by `libreoffice-writer`, so
local and CI reader versions differ. Repo pins: `zod@^3.23.8` in
`server/package.json`, resolving to 3.25.76 in every workspace.

## 0. Engine blockers the driver sits on (measured or read, not argued)

Two of these were reproduced locally with a script before they were written down, and
two were established by reading the code: the bomb guard and the missing main
relationship are measured, reachability and the unexported caps are reads of
`package.ts:126`, `validate.ts:444-457` and `index.ts`. Both scripts are in Local
measurements and both were re-run by an independent reviewer who got the same output.
None of these existed as questions before the adversarial pass, and each would have
landed during implementation as a failing fixture nobody could explain.

### The engine's bomb guard refuses the engine's own output

`MAX_ZIP_COMPRESSION_RATIO = 200` is enforced in `inspectZip` at
`server/src/ooxml-core/validate.ts:1158-1170`, which `validateZipBytes` calls: for a
deflate entry of 64 KiB or more, `size / compressedSize > 200` is an `E_ZIP_LIMIT`
error. `PackageBuilder.build` runs that gate on the bytes it just packed, at
`server/src/ooxml-core/package.ts:140`, with no options.

A table of empty cells is mostly repetition, so it compresses far past 200:1 and the
build refuses itself. Measured: 3,000 rows of two empty cells is refused with
`E_ZIP_LIMIT: package: word/document.xml: compression ratio exceeds 200`, and 2,000
rows of the same shape builds fine at 1,377 bytes. The error the user sees names a
compression ratio, which has nothing to do with what they asked for.

The guard exists to catch zip bombs in bytes we did not write. Bytes we just wrote
from validated, size-capped XML strings are not that input. Two fixes, both small:

- Skip the ratio check for engine-built output. The four other constants in
  `limits.ts` still apply, and those are the caps that bound memory: `MAX_ZIP_ENTRIES`
  (1024), `MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES` (64 MiB),
  `MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES` (256 MiB) and `MAX_ZIP_ARCHIVE_BYTES` (256 MiB).
- Keep the ratio check for every other caller of `validateZipBytes`. Today the only
  production caller is `build()` at `package.ts:140`, and unit 0 passes the new flag
  there and nowhere else, so the heuristic stays armed for anything that validates
  bytes from another source, including a future read or import path.

Add a fixture: a 3,000-row empty-cell table must build.

### Nothing stops a package with no relationship to its own document

`build()` calls `validateSpec(this.spec)` and `validateZipBytes(bytes)` without
options at `package.ts:85` and `package.ts:140`, so `mainPart` is never set.
`validateSpec`'s `mainPart` check only asserts that the part exists
(`validate.ts:812-830`); it does not ask whether anything points at it. The
relationship check runs one way only: a declared relationship must resolve to a live
part (`validate.ts:831-833`, the loop calling `checkDeclaredRelationship`, defined at
`:705`). Nothing checks the other direction, that the package
relationship named `officeDocument` exists at all.

Measured: a package with an empty `packageRels` array builds, 860 bytes, no gate
objected. LibreOffice refuses to load it, exit 1, which is row `relsempty` of the load
table below. So the discipline the first draft leaned on, "the driver ships the
relationships", has no gate behind it.

Fix: `PackageBuilder` needs an option for the main relationship type and target, run
in both gates. The driver passes `officeDocument` pointing at `word/document.xml`. A
fixture asserts the build fails when the relationship is removed. The check runs only
when the option is passed, the same way `mainPart` already works, because the builder
is generic over OPC content types and cannot know what a caller considers main. That
is a deliberate limit, and it is what keeps `validate.test.ts:224-237` and
`:301-331` (specs that pass no `packageRels` at all) validating as they do today.

### A part nobody points at is invisible to both gates

`table.assertNoOrphans` at `package.ts:126` and `E_CONTENTTYPE_ORPHAN_OVERRIDE` at
`validate.ts:444-457` both ask one direction: a declared content-type override must
name a part that exists. The reverse, a part in the package that no relationship
reaches, is not checked anywhere. That is exactly how `word/styles.xml` gets shipped
and ignored, which is the failure this whole document was written to prevent, and it
would happen again for every later part (`numbering`, `settings`, `fontTable`).

Fix: reachability from the package relationship graph, in the engine, plus a fixture.
Unit 0 carries one fixture for the new refusal and one per shipped part as parts land,
and unit 0 in the Recommendation promises exactly that.

### The element caps cannot be named by a caller

`MAX_XML_DEPTH = 256` and `MAX_XML_ELEMENTS = 100_000` are private constants at
`validate.ts:85-86` and are not exported from `index.ts`, which exports only the five
`limits.ts` constants. A driver that wants to refuse a document before the engine
refuses it has no number to refuse against, so the cap surface is one error message
with nothing in it. Export both, then pick the driver's block and cell caps as the
smaller of the two.

## 1. Common gotchas

- **The minimum package is three parts, and it opens.** MS Learn's WordprocessingML
  structure doc, quoting ISO/IEC 29500:2016, gives the minimum *document story* as
  `document` > `body` > `p` > `r` > `t`, and its sample output is a package whose only
  part is the main document part. The Library of Congress format description gives the
  package-level view: "The top level of a minimal package will typically have three
  folders (_rels, docProps, and word) and one file part ([Content_Types].xml". I built
  that three-part package by hand (content types, package rels, one document part)
  and LibreOffice 26.2.6.3 loaded it, exit 0, PDF produced, which is the `good` row of
  the load table. The trap is the opposite belief: that a hand-built three-part file
  is invalid. It is valid.
  Sources: https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document
  ; https://www.loc.gov/preservation/digital/formats/fdd/fdd000397.shtml ; local probe.

- **A missing styles part is a quiet failure, not a loud one.** `w:pStyle` naming a
  style that does not exist is not a corruption error. MS Learn's style-application
  page states the behavior directly: "Applying a style that does not exist to a
  paragraph has no effect; there is no exception generated and no formatting changes
  occur." So nothing fails, the document opens clean, and every heading renders as
  body text. Source: https://learn.microsoft.com/en-us/office/open-xml/word/how-to-apply-a-style-to-a-paragraph-in-a-word-processing-document

- **`w:pStyle` must carry the `w:styleId`, never the `w:name`.** The two differ for
  the built-in heading: the name is `heading 1` lowercased with a space, the id is
  `Heading1`. A reference written as `w:pStyle w:val="heading 1"` resolves to nothing
  and the heading silently becomes body text, which is the failure above wearing a
  second disguise. The id is what goes in `w:val`, and a fixture asserts every
  `w:pStyle/@w:val` in the document appears as a `w:style/@w:styleId` in the same
  package.

- **`w:sectPr` must be the last child of `w:body`, and Word repairs on swap;
  LibreOffice does not care.** A package whose `sectPr` sits before its paragraph
  loads in LibreOffice 26.2.6.3 with exit 0 and produces a PDF, which is row `ord_unc`
  of the load table. The order rule is a Word-repair rule, and the LibreOffice gate
  will not catch it, so the engine's own ordering checks have to carry it. Sources:
  prior repo research, section 1 first bullet of
  `CD_res/implementation/ooxml-core/ooxml-core-research.md`; local probe.

- **`w:t` trims leading and trailing whitespace unless `xml:space="preserve"` is set,
  and it does nothing for newlines and tabs.** Indented code blocks and lines that
  start with spaces silently lose the indentation, so set `xml:space` on every `w:t`
  the driver emits rather than trying to detect when it matters. A literal `\n` inside
  `w:t` is not a line break and a literal `\t` is not a tab stop: the reader renders
  them as a space or nothing. The model splits `\n` into `w:br` and maps `\t` to
  `w:tab`, with a fixture carrying both. Sources: https://ooxml.dev/docs/paragraphs/
  (SuperDoc team documentation, ideas-only per the AGPL rule; the claim is a
  WordprocessingML behavior fact, and the same rule is in the W3C XML spec's
  `xml:space` semantics).

- **A page break is a paragraph, not a block of its own.** The `pageBreak` block
  emits `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`, one paragraph with one run
  holding one `w:br` of type `page`. A fixture asserts the paragraph count so this
  cannot be implemented three different ways.

- **Real lists need `word/numbering.xml`, and the standard for it is a strict
  sequence.** Numbering is a separate part with a package relationship, `w:numPr` on
  each paragraph pointing at a `w:num` that points at a `w:abstractNum` that defines
  the levels, and restarting a list means `w:lvlOverride` on the `w:num`.
  python-docx still has no high-level list API (issue #122, opened Jan 6 2015 and
  still open) and the maintainer comment on the numbering analysis page is blunt: the
  standard is "highly cumbersome". Sources:
  https://skelmis-docx.readthedocs.io/en/latest/dev/analysis/features/numbering.html ;
  https://github.com/python-openxml/python-docx/issues/122

  This draft's first version dropped lists from v1 and substituted a literal bullet
  character. That argument is withdrawn, and the reason is in the Recommendation: the
  parts of numbering that are strict are precisely the parts no reader here can check,
  so a v1 bullet substitute would be a permanently unverifiable claim of a list.
  Numbering ships in its own unit with its own order assertions, and until then the
  model has no list block for the emitter to be asked to render.

- **Tables need `w:tblGrid` even though the spec marks it optional.** Word crashes
  without it. Carried over from the core research, unchanged in scope. Source: prior
  repo research, section 1 first bullet of
  `CD_res/implementation/ooxml-core/ooxml-core-research.md`; https://ooxml.dev/docs/common-gotchas/

- **A table without `tblPr` is a borderless grid that still opens.** No `w:tblW`, no
  `w:tblLayout`, no `w:tblBorders`, no per-cell `w:tcW` and no `w:gridSpan` means
  LibreOffice and Word both render an auto-width grid with no rules between cells.
  Every assertion in the first plan could pass and the table still looked like
  nothing. The model carries `columnWidths`, `headerRow` and `colSpan`; the emitter
  writes `tblPr`, `tblW`, `tblLayout`, `tblBorders`, `tcW` per cell, `gridSpan` and
  `tblHeader`, and the declared table style is referenced from `tblStyle` while the
  borders stay explicit, so the table renders even if a reader ignores the style.

- **The tool fetch timeout in the harness is short, but it does not apply here
  today.** OpenCode's local MCP config documents `timeout` (ms) for fetching tools
  from an MCP server, default 5000. The repo has no MCP server of its own: the seat
  passes `mcpServers: []` on resume at `server/src/acp/acp-seat.ts:464` and passes
  nothing on the `session/new` path, and the installed ACP SDK does expose
  `SessionBuilder.withMcpServer` at `acp.d.ts:284`. So the timeout figure is a
  constraint on a tool boundary nobody has built, not on anything in the current plan.
  Sources: https://opencode.ai/docs/mcp-servers/ ; repo read.

## 2. Best practices

- **Split the driver into a vocabulary layer and a writer layer, and test them
  apart.** The vocabulary layer turns the JSON document model into WordprocessingML
  part strings using the existing `xml.ts` helpers (`doc`, `el`, `escText`,
  `escAttr`); it is pure and testable with string assertions. The writer layer
  assembles the `OoxmlPackageSpec` (parts + packageRels + partRels) and hands it to
  `PackageBuilder.parse(...).build()`. That is the same split the core already uses,
  and it keeps rId allocation, ordering, and ZIP bytes in the engine.

- **Write the Zod model before the emitter, as its own change.** "Blocks (paragraph,
  heading, table, pageBreak), runs with marks, cells" was a sentence, not a
  specification: it named no style values, no heading levels, no mark list, no cell
  shape, no empty-block rule and no caps. The closed `z.enum` the plan argues for has
  no declared contents without it, so the missing-style hole would not have been
  closed. `shared/src/office.ts` lands first, the emitter reads it, and the enum
  contains exactly the styles the emitter emits and no others.

- **Ship a styles part with a small declared style vocabulary.** Declare the styles
  the model can reference (`Normal`, `Title`, `Heading1` through `Heading3`, `Quote`,
  `CodeBlockChar`, one table style) in `word/styles.xml`, plus `docDefaults` with a
  font stack and size in `rPrDefault`. Every `w:pStyle` the model can name then
  resolves, and the "opens but wrong" failure above cannot happen by construction.
  Word writes `basedOn`/`next` chains; v1 does not need them because every style
  stands alone. `w:latentStyles` is optional and is omitted.

- **Name the fonts in `docDefaults`, and ban theme-dependent attributes.** A
  character style with no font falls back to whatever the reader has, and there is no
  `word/theme/theme1.xml` in this plan, so `themeColor` and `asciiTheme` attributes
  would render as nothing. Both are banned in v1.

- **Doc properties are cheap and expected.** `docProps/core.xml` (Dublin Core:
  `dc:title`, `dc:creator`, `dcterms:created`/`dcterms:modified`) plus a package rel
  to it. The Library of Congress format description notes the core properties part is
  usually present and that every element in it is optional, so emitting title and
  creator with a fixed created date is both safe and deterministic. The extended
  `docProps/app.xml` part is optional; emitting it buys nothing for a create-only
  driver and adds a second timestamp to keep deterministic, so skip it. Say plainly
  what the fixed timestamp is: a deterministic value, visible in Explorer and
  LibreOffice, chosen because same-JSON-same-bytes matters more than accurate metadata
  here.

- **Determinism is per machine, not across timezones, and the engine already says
  so.** `zip.ts:26-30` notes that fflate's local-field encoding makes bytes
  deterministic per machine, out of scope for v1. The driver must not add `new Date()`
  in `core.xml`, which is what keeps that promise intact. A byte-determinism fixture,
  same spec twice and the same bytes out, belongs to unit 2 because that unit owns
  the gates.

- **Validate with two gates, and the second gate has to see formatting.** Gate one is
  the existing engine (`validateSpec` at write time, `validateZipBytes` post-hoc, both
  already wired into `PackageBuilder.build()`). Gate two is LibreOffice, following the
  pattern already in `server/src/ooxml-core/docx.test.ts`: locate the binary
  (`findLibreOffice`, `docx.test.ts:81`), convert with a private
  `-env:UserInstallation` profile, assert exit status 0, assert no
  `source file could not be loaded|repair|corrupt` in the output, and assert the
  expected text appears. That helper currently runs `--cat` with
  `--infilter="Office Open XML Text"`, which dumps plain text: it cannot see whether a
  heading took its style, and neither can an exit code. `--cat` stays for the content
  assertion, and a second invocation converts to `fodt` so the emitted markup can be
  read for the style. Local LibreOffice is 26.2.6.3 while CI installs the distro
  build, so the reader version is a recorded variable rather than a controlled one.

- **`xml:space="preserve"` on every `w:t` the model does not control.** Text from
  JSON can start or end with a space, and trimming it is silent corruption of the
  author's intent. Set the attribute unconditionally; it is valid everywhere and costs
  nothing.

## 3. Pitfalls and language quirks

- **Zod major-version drift is live right now.** `server/package.json` pins
  `zod@^3.23.8` and `shared/package.json` pins `^3.25.76`; npm
  latest is `4.6.5`. `shared/src/index.ts` uses v3 idioms (`.strict()` at `:113`,
  `z.record` with a single-argument form at `:136`). The MCP TypeScript SDK v1
  (`@modelcontextprotocol/sdk@1.32.1`) is MIT and takes plain JSON Schema or
  Zod-shaped objects, and declares `zod: '^3.25 || ^4.0'`, so it does not force the
  bump. Do not "modernize" zod as a side effect of this feature; that is a separate,
  repo-wide migration and it would touch every workspace.

- **`docx@9.9.0` is 16.9 MiB unpacked for exactly the job we already did by hand.**
  The core research already closed this out on license and behavior grounds
  (write-only in practice, mutates caller state, pushes rIds and ordering onto the
  caller). Adding it now would duplicate the engine and import the
  caller-state-mutation class of bug the core was built to avoid. Not a dependency to
  reconsider.

- **`z.record` and `__proto__`.** The core already guards this: `PackageBuilder.parse`
  pre-scans `partRels` for a `__proto__` key because Zod records drop it silently
  (`package.ts:57-66`, plus the path guard at `paths.ts:44-45`). The driver must route
  part rels through the same `PackageBuilder.parse` entry point and never build the
  spec object by hand, or that guard is bypassed.

- **Content types are per-part, not per-extension, for the interesting parts.**
  `word/document.xml` needs the `...wordprocessingml.document.main+xml` override, not
  the generic `application/xml` default. The engine owns the table, so the driver
  supplies the right content type string per part and the engine refuses orphans.
  Getting a content type string wrong is a loud failure here
  (`E_CONTENTTYPE_UNCOVERED`), which is the intended behavior.

- **`--cat` versus `--convert-to` for the LibreOffice gate.** The existing test uses
  `--cat` with `--infilter="Office Open XML Text"` and asserts the text appears on
  stdout. That is a content assertion, which is stronger than an exit-code check.
  Keep it, and add the conversion for formatting assertions.

- **Element order in the two new parts is not covered by anything in the engine.**
  `checkWordOrder` at `validate.ts:667-703` checks exactly two rules: `sectPr` last
  child of `body` (error) and `tblGrid` present in a `tbl` (warning). Nothing checks
  `CT_PPr`, `CT_RPr`, `w:tblPr` placement, `w:tcPr` placement, `w:numPr` child order,
  `CT_Styles`, `CT_Style`, `CT_Numbering`, `CT_AbstractNum`, `CT_Lvl` or `CT_Num`. The
  probe table below shows LibreOffice tolerates order violations, so the fixture suite
  is the only thing standing behind those rules, and it has to list them all. The
  exact permitted sequences are in the invariant list below.

- **No Windows Word was available here.** Every reader claim in this file is
  LibreOffice 26.2.6.3. The `sectPr`-order, `tblGrid` and style-resolution rules are
  Word-repair rules from cited sources, not observations. CI cannot close that gap
  either.

## Element order invariants the fixtures must assert

The first draft listed four of these and called the list the only gate. It was not the
whole list. This is the list, 18 rows, taken from the ECMA-376 content models. No XSD
is vendored in this repo, so the fixtures are written from this table and the table is
the authority a reviewer compares against.

| element | permitted child sequence (relevant subset) |
| --- | --- |
| `w:body` | block content, then `w:sectPr` last |
| `w:p` | `w:pPr` first, then run content |
| `w:r` | `w:rPr` first, then run content |
| `w:pPr` | `pStyle`, `keepNext`, `keepLines`, `pageBreakBefore`, `framePr`, `widowControl`, `numPr`, `suppressLineNumbers`, `pBdr`, `shd`, `tabs`, `suppressAutoHyphens`, `kinsoku`, `wordWrap`, `overflowPunct`, `topLinePunct`, `autoSpaceDE`, `autoSpaceDN`, `bidi`, `adjustRightInd`, `snapToGrid`, `spacing`, `ind`, `contextualSpacing`, `mirrorIndents`, `suppressOverlap`, `jc`, `textDirection`, `textAlignment`, `textboxTightWrap`, `outlineLvl`, `divId`, `cnfStyle`, `rPr`, `sectPr`, `pPrChange` |
| `w:numPr` | `ilvl`, `numId`, `numberingChange`, `ins` |
| `w:rPr` | `rStyle`, `rFonts`, `b`, `bCs`, `i`, `iCs`, `caps`, `smallCaps`, `strike`, `dstrike`, `outline`, `shadow`, `emboss`, `imprint`, `noProof`, `snapToGrid`, `vanish`, `webHidden`, `color`, `spacing`, `w`, `kern`, `position`, `sz`, `szCs`, `highlight`, `u`, `effect`, `bdr`, `shd`, `fitText`, `vertAlign`, `rtl`, `cs`, `em`, `lang`, `eastAsianLayout`, `specVanish`, `oMath` |
| `w:tbl` | `w:tblPr`, `w:tblGrid`, then `w:tr` rows |
| `w:tblPr` | `tblStyle`, `tblpPr`, `tblOverlap`, `bidiVisual`, `tblStyleRowBandSize`, `tblStyleColBandSize`, `tblW`, `jc`, `tblCellSpacing`, `tblInd`, `tblBorders`, `shd`, `tblLayout`, `tblCellMar`, `tblLook`, `tblCaption`, `tblDescription` |
| `w:tr` | `w:trPr` optional first, then `w:tc` cells |
| `w:tc` | `w:tcPr` first, then block content |
| `w:tcPr` | `cnfStyle`, `tcW`, `gridSpan`, `hMerge`, `vMerge`, `tcBorders`, `shd`, `noWrap`, `tcMar`, `textDirection`, `tcFitText`, `vAlign`, `hideMark` |
| `w:sectPr` | `footnotePr`, `endnotePr`, `type`, `pgSz`, `pgMar`, `paperSrc`, `pgBorders`, `lnNumType`, `pgNumType`, `cols`, `formProt`, `vAlign`, `noEndnote`, `titlePg`, `textDirection`, `bidi`, `rtlGutter`, `docGrid`, `printerSettings` |
| `w:styles` | `w:docDefaults`, then `w:style` entries |
| `w:style` | `w:name` before `w:pPr`/`w:rPr`, which sit near the end |
| `w:numbering` | `w:abstractNum` entries, then `w:num` entries |
| `w:abstractNum` | `nsid`, `multiLevelType`, `tmpl`, `name`, `styleLink`, `numStyleLink`, then `w:lvl` entries |
| `w:lvl` | `start`, `numFmt`, `lvlRestart`, `pStyle`, `isLgl`, `suff`, `lvlText`, `lvlPicBulletId`, `legacy`, `lvlJc`, then `w:pPr`, `w:rPr` |
| `w:num` | `abstractNumId`, then `w:lvlOverride` entries |

One defect per package, byte-identical otherwise, or the result proves nothing: that
rule, which the first draft put in a footnote, is a hard rule for every new fixture.

## 4. Differentiation

- Industry standard: `docx` (npm) builds the package for you and exposes a document
  builder; python-docx opens a template `.docx` and mutates it; SuperDoc edits an
  existing OOXML model through operations. All three either pull in a large dependency
  or require a template on disk, and all three leave the caller holding rIds,
  ordering, or a template's baggage.
- Our approach: the driver emits a part spec and lets the engine pack it. No template
  file, no runtime dependency beyond what the core already needs, no mutated caller
  state.
- Does the difference translate to usefulness? Yes, and narrowly. The core already
  absorbed the hard half (OPC correctness). The driver's job is the WordprocessingML
  vocabulary, and the industry-standard tools do not do that part better; they do it
  with more weight and more caller responsibility. Following the standard is the right
  call here: same ZIP, same schemas, same namespaces, different packaging.

## Recommendation

The ordering changed after the adversarial pass. Engine work first, because every unit
after it depends on gates that currently do not exist.

**Unit 0 (engine, one PR) — IMPLEMENTED.** Four fixes (landed in engine-gates.test.ts and package.ts):

1. Skip the ratio check for engine-built bytes and keep it for every other caller.
   Fixture: a 3,000-row empty-cell table that builds.
2. Add the main-relationship option to `PackageBuilder`, run in both gates, option-gated
   the same way `mainPart` is today. Fixture: a package that refuses to build without
   the `officeDocument` relationship when the option is passed.
3. Check reachability from the package relationship graph. Fixture: a part that
   refuses to build when nothing points at it, plus one per shipped part as parts
   land.
4. Export `MAX_XML_DEPTH` and `MAX_XML_ELEMENTS` from `index.ts`.

The existing suite does not stay untouched by design, and the places that need a
deliberate look are named rather than assumed away. `package.test.ts`'s "stores
precompressed extensions" test builds six media parts (`a.png`, `b.jpg`, `c.jpeg`,
`d.PNG`, `e.Jpeg` and `f.gif`) that no relationship reaches, which is exactly the
defect item 3 refuses, so that fixture gains part rels pointing at them rather than
the check being loosened. Three tests compare a whole validation result and break on
any added issue: `docx.test.ts:67` and `:73` deep-equal `{ok: true, errors: [],
warnings: []}`, and `validate.test.ts:194` does the same, with
`doesNotThrow(() => assertValid(result))` directly under it at `:195` and another at
`:365`. `package.test.ts`'s `assert.throws` sites (for example `:151-163`) name an
exact `e.code`, so they break too if a new refusal fires before the one they expect.
The large majority of the suite is presence checks that tolerate added issues,
`hasCode` in `validate.test.ts` and `security.test.ts` plus `assert.ok(result.ok)`
sites, and those are fine. Any new refusal that lands on an existing fixture is a
finding to review, not a pass to record.

**Unit 1 (shared model, one PR).** `shared/src/office.ts`: the Zod document model
with a closed style enum whose contents are declared, heading levels, the mark list,
the cell shape, and caps on blocks, cells and characters per run, each cap citing the
engine constant it tightens. The enum holds exactly the styles unit 2 emits. No
`list` block yet: unit 3 adds it together with numbering, so unit 1 never accepts a
block unit 2 cannot emit. No emitter yet. This is the artifact the whole plan was
missing, and it is drafted against the harness prompt contract at the same time, so
the model is not designed against no caller at all.

**Unit 2 (driver, one PR).** Vocabulary plus writer: `document.xml`, `styles.xml`,
`docProps/core.xml`, the package assembly through `PackageBuilder`, and the invariant
assertions from the table above as a test file. Fixes for the two silent failures:
`w:pStyle` carries the `w:styleId`, and `\n` becomes `w:br` while `\t` becomes
`w:tab`. The `pageBreak` block emits `w:p` holding `w:br w:type="page"`. The default
`sectPr` carries `pgSz` and the full `pgMar` that `createProofSpec` in
`server/src/ooxml-core/docx.test.ts:25-43` already emits. Fixtures: plain, headings,
a table with borders and column widths, a table with a merged cell and a header row
exercising `gridSpan` and `tblHeader`, long text with `xml:space` cases, unicode, a
multi-line paragraph with tabs, a page break asserting the paragraph count, a fixture
asserting every `w:pStyle/@w:val` resolves to a `w:style/@w:styleId`, a guard fixture
asserting the emitter writes no `w:ins`, `w:del`, `w:commentRangeStart` or hyperlink
relationship, the 3,000-row table from unit 0, and a byte-determinism fixture. Each
fixture runs both
gates, with the second gate converted to `fodt` for formatting assertions plus the
`--cat` content assertion. The unit also measures build time and peak RSS on the
largest fixture and records the number, because a potato-friendly pillar is a claim
about a measurement.

**Unit 3 (numbering, one PR, after unit 2 ships).** Real lists with
`word/numbering.xml`, the `list` block added to the model, `w:numPr` emitted on list
paragraphs, the full `CT_AbstractNum`/`CT_Lvl`/`CT_Num` sequence asserted from the
table above, and a restart case. This replaces the literal-bullet substitute, which is
dropped.

**What is out of scope and why.** Headers and footers, images, comments, tracked
changes, hyperlinks, table of contents. Each is a new part with its own relationship
and element-order rules, and each was scoped out in the core research for a reason.
Two guards go with that list: the emitter must never emit `w:ins`, `w:del`,
`w:commentRangeStart` or a hyperlink relationship, and a fixture asserts it; and
hyperlinks carry a known cost, because an `r:id` must exist before the part string is
written while the engine allocates rIds after, so a hyperlink needs a `reserve` step
in `RelScope` that runs before emission. Unit 2 emits no `r:id` at all, which is what
makes the two-pass problem dormant today.

**The tool boundary is out of the plan for now.** The first draft offered two options
for delivering `create_docx` to a harness: implement `execTool` in
`server/src/service.ts` "behind the existing `K5Service`, no new subsystem, and no
5-second tool-fetch timeout to fit inside", or an MCP server in the seat. The first is
not available today: `createMemoryService` is a test-only stub referenced by
`service.test.ts` and `acp/plug.test.ts` and nothing else, `server/src/index.ts` wires
`createSessionHandlers` instead, `server/src/tools/` does not exist, and the six
browser commands in `shared/src/contracts.ts` (`session.open`, `configure`, `prompt`,
`cancel`, `close`, `load`) carry no tool call. Harness tool notifications reach
`session-service.ts` and are rendered view-only. The second needs an MCP server
process, a new MIT dependency, and seat wiring, and the 5-second figure it was argued
against does not apply to a path the repo has not built. Neither option is a cost
trade-off today, so the tool does not belong in a build plan.

When a caller exists, the tool's design constraints are these, and they are worth
writing down now because they are the ones a lazy first version skips: the input
schema is the document model and `OoxmlPackageSpec` is never reachable from a tool
argument; the output path is resolved against the session's project root with
`server/src/store/safe-name.ts`; a posture gate, an audit row and an idempotency key
per call, using `ToolCallSchema`'s existing `idempotencyKey` and `AuditSchema`; a rate
cap per session on documents created per minute, in the same bound shape the `/ws`
gateway already applies; and caps on blocks and characters validated in `shared`,
failing loudly rather than truncating.

**Delivery questions the docx driver cannot answer alone.** Two product gaps showed up
while checking the tool boundary, and they apply to any office deliverable: there is
no route that serves a generated file back to the user (`server/src/session-api.ts`
has POST and DELETE for attachments and no GET that returns bytes), and no skill or
instruction anywhere tells the harness what JSON to emit, though SPEC item 3 requires
JSON-in/engine-out and AGENTS.md:85 says "AI prompts must only generate clean JSON
structures". Both belong to the
office feature as a whole rather than to this driver. The second is priced into unit 1,
which is drafted against the prompt contract rather than after it. The first needs a
decision from the maintainer, because it is independent of everything in units 0
through 3 and could be built in any order: attachment bytes already sit in the store
and `session-api.ts` already routes that namespace.

## Local measurements

Two scripts, both re-run by an independent reviewer with the same output. Build the
engine first (`npm run build -w shared && npm run build -w server`), then run them.

The first reproduces the two measured engine blockers. The third engine blocker,
reachability, is a code read rather than a measurement, so no script carries it.

```js
// /tmp/opencode/probe-bomb.mjs
import { PackageBuilder } from "server/dist/ooxml-core/package.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function rows(n, cellBody) {
  let out = "";
  for (let i = 0; i < n; i += 1)
    out += `<w:tr><w:tc><w:p>${cellBody}</w:p></w:tc><w:tc><w:p>${cellBody}</w:p></w:tc></w:tr>`;
  return out;
}

function tableSpec(n, cellBody) {
  return {
    parts: [{
      name: "word/document.xml",
      contentType: MAIN,
      xml:
        DECL +
        `<w:document xmlns:w="${W}"><w:body><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4675"/><w:gridCol w:w="4675"/></w:tblGrid>` +
        rows(n, cellBody) +
        `</w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
    }],
    packageRels: [{
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
      target: "word/document.xml",
      mode: "internal",
    }],
    partRels: {},
  };
}

for (const [label, n, cell] of [
  ["empty cells, 2000 rows", 2000, ""],
  ["empty cells, 3000 rows", 3000, ""],
  ["one char cells, 1000 rows", 1000, "<w:r><w:t>x</w:t></w:r>"],
  ["one char cells, 1500 rows", 1500, "<w:r><w:t>x</w:t></w:r>"],
]) {
  try {
    const bytes = PackageBuilder.parse(tableSpec(n, cell)).build();
    console.log(`${label}: OK, ${bytes.length} bytes`);
  } catch (err) {
    const codes = err?.issues?.map((i) => `${i.code}: ${i.message}`) ?? [err.message];
    console.log(`${label}: REFUSED, ${codes.join("; ")}`);
  }
}

try {
  const bytes = PackageBuilder.parse({
    parts: [{
      name: "word/document.xml",
      contentType: MAIN,
      xml: `${DECL}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>`,
    }],
    packageRels: [],
    partRels: {},
  }).build();
  console.log(`empty package rels: built ${bytes.length} bytes, no gate objected`);
} catch (err) {
  const codes = err?.issues?.map((i) => `${i.code}: ${i.message}`) ?? [err.message];
  console.log(`empty package rels: REFUSED, ${codes.join("; ")}`);
}
```

Output on 2026-10-10, identical on a second run by another agent:

```
empty cells, 2000 rows: OK, 1377 bytes
empty cells, 3000 rows: REFUSED, E_ZIP_LIMIT: package: word/document.xml: compression ratio exceeds 200
one char cells, 1000 rows: OK, 1398 bytes
one char cells, 1500 rows: OK, 1579 bytes
empty package rels: built 860 bytes, no gate objected
```

The second builds the six load packages, one defect each, and hands each to
LibreOffice.

```bash
#!/bin/bash
# /tmp/opencode/loadprobe.sh
set -u
ROOT=/tmp/opencode/loadprobe
DOCX_NS='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
REL_NS='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
CT_DOC='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
CT_RELS='application/vnd.openxmlformats-package.relationships+xml'
OFFICE_DOC='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
DECL='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
PG='<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

rm -rf "$ROOT"
mkdir -p "$ROOT/profile"

build_case() {
  local name="$1" ct="$2" rels="$3" doc="$4"
  local dir="$ROOT/$name"
  mkdir -p "$dir/_rels" "$dir/word"
  printf '%s' "$ct"  > "$dir/[Content_Types].xml"
  printf '%s' "$rels" > "$dir/_rels/.rels"
  printf '%s' "$doc" > "$dir/word/document.xml"
  (cd "$dir" && zip -X -q "../$name.docx" '[Content_Types].xml' '_rels/.rels' 'word/document.xml')
}

ct_good="$DECL<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"$CT_RELS\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"$CT_DOC\"/></Types>"
ct_nomain="$DECL<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"$CT_RELS\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/></Types>"
rels_good="$DECL<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"$OFFICE_DOC\" Target=\"word/document.xml\"/></Relationships>"
body_good="<w:body><w:p><w:r><w:t>load probe</w:t></w:r></w:p>$PG</w:body>"
doc_open="<w:document xmlns:w=\"$DOCX_NS\" xmlns:r=\"$REL_NS\">"
doc_close='</w:document>'

build_case good     "$ct_good"   "$rels_good" "$DECL$doc_open$body_good$doc_close"
build_case relsempty "$ct_good"  ""           "$DECL$doc_open$body_good$doc_close"
build_case ctonly   "$ct_nomain" "$rels_good" "$DECL$doc_open$body_good$doc_close"

# sectPr before the paragraph instead of last.
build_case ord_unc  "$ct_good"   "$rels_good" "$DECL$doc_open<w:body>$PG<w:p><w:r><w:t>load probe</w:t></w:r></w:p></w:body>$doc_close"

# A live r:id with no relationship entry behind it.
sect_rid='<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
build_case ord_rid  "$ct_good"   "$rels_good" "$DECL$doc_open<w:body><w:p><w:r><w:t>load probe</w:t></w:r></w:p>$sect_rid</w:body>$doc_close"

# Malformed XML: w:p, w:r and w:t left open.
build_case bad      "$ct_good"   "$rels_good" "$DECL$doc_open<w:body><w:p><w:r><w:t>load probe</w:body></w:document>"

for name in good relsempty ctonly ord_unc ord_rid bad; do
  soffice --headless --nologo --nodefault --norestore --nolockcheck --nofirststartwizard \
    -env:UserInstallation=file://$ROOT/profile \
    --convert-to pdf --outdir "$ROOT" "$ROOT/$name.docx" > "$ROOT/$name.out" 2> "$ROOT/$name.err"
  code=$?
  if [ -f "$ROOT/$name.pdf" ]; then pdf=yes; else pdf=no; fi
  echo "$name exit=$code pdf=$pdf"
  rm -f "$ROOT/$name.pdf"
done
```

Output on 2026-10-10, identical on a second run by another agent:

```
good exit=0 pdf=yes
relsempty exit=1 pdf=no
ctonly exit=1 pdf=no
ord_unc exit=0 pdf=yes
ord_rid exit=1 pdf=no
bad exit=1 pdf=no
```

Three findings stand.

1. LibreOffice is a good load gate. Missing relationships, an undeclared main part,
   live dangling references and malformed XML all fail loudly with exit 1. A package
   with a dangling relationship *declaration* is the exception: an earlier probe run
   had a `word/_rels/document.xml.rels` pointing `rId7` at a `styles.xml` part that
   did not exist and that nothing referenced, and LibreOffice loaded it (exit 0, PDF
   produced). It only fails when a missing relationship is *referenced* by live
   markup.
2. LibreOffice is not an ordering gate. `ord_unc` is the row to read. A `sectPr`
   before its paragraph loads fine, so the corruption class the engine's ordering
   checks exist to prevent is invisible to this gate.
3. Do not trust a probe you did not isolate. The first version of this table claimed
   `sectPr`-first caused exit 1. That package also had a zero-byte `_rels/.rels` and
   no content-type Override, so the failure had nothing to do with element order. An
   adversarial reviewer caught it by rebuilding the package with the one defect, and
   the row was re-measured before this document was written. The script above exists
   because that reviewer asked why the table had no build method.

## Sources

- https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document (2024-01-12, updated 2025-01-21)
- https://www.loc.gov/preservation/digital/formats/fdd/fdd000397.shtml (last significant update 2024-05-06)
- https://learn.microsoft.com/en-us/office/open-xml/word/how-to-apply-a-style-to-a-paragraph-in-a-word-processing-document
- https://ooxml.dev/docs/common-gotchas/ (SuperDoc team, ideas-only per AGPL boundary)
- https://ooxml.dev/docs/paragraphs/ (superdoc team, ideas-only per AGPL boundary)
- https://skelmis-docx.readthedocs.io/en/latest/dev/analysis/features/numbering.html
- https://github.com/python-openxml/python-docx/issues/122 (opened Jan 6 2015, still open)
- https://opencode.ai/docs/mcp-servers/ (last updated Oct 10 2026)
- npm registry via `npm view` 2026-10-10: `docx@9.9.0` MIT, unpacked 17,694,326 B; `@modelcontextprotocol/sdk@1.32.1` MIT with `zod: '^3.25 || ^4.0'`; `zod@4.6.5` latest, repo pin `^3.23.8`
- Prior repo research: `CD_res/implementation/ooxml-core/ooxml-core-research.md` (element order, tblGrid, library failure catalog); `CD_res/implementation/ooxml-core/ooxml-zip-engine-research.md`; repo `AGENTS.md` (`:85`), repo `SPEC.md` (`:8` item 3)
- Repo code, read and quoted above: `server/src/ooxml-core/package.ts` (`:57-66`, `:78`, `:85`, `:126`, `:140`), `server/src/ooxml-core/validate.ts` (`:85-86`, `:444-457`, `:667-703`, `:812-830`, `:1031`, `:1158-1170`, `:1397`), `server/src/ooxml-core/limits.ts`, `server/src/ooxml-core/zip.ts` (`:26-30`), `server/src/ooxml-core/docx.test.ts` (`:25-43` inside `createProofSpec`, `:65-79` `buildProof`, `:67`, `:73`, `:81`, `:107-128`, `:160-166`), `server/src/ooxml-core/package.test.ts` (the precompressed-extensions fixture at `:108`, the exact-code throws at `:151-163`), `server/src/ooxml-core/validate.test.ts` (`:194`, `:224-237`, `:301-331`, `:365`), `server/src/ws/gateway.ts` (`:61`, `:70-71`, `:296-302`), `server/src/service.ts` (`:22`, `:30`), `server/src/acp/acp-seat.ts` (`:464`), `server/src/session-api.ts` (attachment POST and DELETE), `shared/src/index.ts` (`:43-53`, `:69-80`, `:107-143`), `shared/src/contracts.ts` (`:242-247`), `shared/src/access.ts`, `.github/workflows/ci.yml` (`:48`, `:65`, `:84`), `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` (`:284`)
- Measured locally: Node `v22.23.1`, `npx tsc --version` 5.9.3, `soffice --version` 26.2.6.3, `npm ls zod` resolving every workspace to 3.25.76

## Adversarial Verification

Three passes were promised by the first draft and only one ran. All three are logged
here, followed by the round-two checks that confirmed or refuted each fix.

**Pass 1, source validity (ran before the first draft was shipped): RED, then GREEN
after a re-run.** Eight findings, all resolved and re-measured: the `sectPr`-first
probe row was wrong and its narrative was false (rebuilt one defect per package and
the conclusion flipped); the `unc` probe row rested on a broken package (replaced with
`ctonly` and `relsempty`); the styles claim was re-attributed from ooxml.dev to MS
Learn; the three-part minimum was re-attributed from MS Learn to the Library of
Congress plus the probe; Node 26.7.0 and TypeScript 5.6.3 were wrong (Node is
v22.23.1, installed tsc is 5.9.3); python-docx issue #122 opened 2015 not 2014; "G11"
was cited from a file with no G-numbering (pointers fixed); two probe packages were
described as three parts but were not (both rebuilt).

**Pass 2, claims and logic (never ran on the first draft; ran now): 12 findings.**

1. `K5Service` was described as "available today" for the tool boundary. Not true:
   `createMemoryService` is referenced only by `service.test.ts` and `plug.test.ts`,
   `index.ts` wires `createSessionHandlers`, no tool call exists in the wire contract.
   Confirmed by grep. The tool was cut from the Recommendation.
2. The probe script the document pointed at (`/tmp/opencode/probe-order.mjs`) no
   longer existed anywhere, so several measurements had no reproducible method.
   Replaced by the two scripts in Local measurements, which reproduce the blocker rows
   and the whole load table by name.
3. The element-order invariant list omitted `styles.xml` and `numbering.xml` orders.
   Both parts now have rows in the table above.
4. The style vocabulary had no table style while the model ships tables, so a
   borderless table could pass every assertion. `tblStyle` added to the vocabulary,
   referenced from `tblStyle`, with explicit `tblBorders` kept so the borders do not
   depend on the style being found.
5. The 5-second MCP tool-fetch figure was cited from config-file documentation and
   applied to a path the repo does not have. Rewritten in gotchas to say what it
   applies to and that it does not apply today. `withMcpServer` at `acp.d.ts:284`
   recorded, because a future tool boundary would use it.
6. The tool PR had no caller. Cut, with its design constraints written down for when
   one exists.
7. Numbering's safety argument rested on LibreOffice loading it, the same reader the
   document had just disqualified as an order authority. The conclusion was reversed:
   numbering moves to its own unit with its own order assertions instead of being cut
   with a literal bullet.
8. Determinism was claimed as whole-pipeline. Corrected: per machine, not across
   timezones, quoting `zip.ts:26-30`.
9. The cell arithmetic in the size argument was wrong (100,000 divided by five is
   20,000, not 16,600, and the example did not cross the cap without `pPr`). The
   section it sat in was rewritten around the measured blocker instead.
10. The LibreOffice pattern was cited as a converter; it is `--cat`. Corrected, with
    a second conversion added for formatting assertions.
11. `apps/web/package.json` pins `typescript` to exactly 5.9.3 rather than a caret
    range, so "all three manifests declare `^5.6.3`" was wrong. Corrected in the
    versions paragraph.
12. `limits.ts` enumeration omitted `MAX_ZIP_ARCHIVE_BYTES`. The five constants are
    now named in the caps discussion.

**Pass 3, omissions (never ran on the first draft; ran now): 22 findings, 5 of them
blockers.** All five were verified by re-running a measurement or reading the code
before the finding was accepted, and all five are now units 0 and 1: the bomb guard on
engine-built bytes (reproduced, 3,000-row table refused), no gate for a package with
no relationship to its document (reproduced, 860 bytes built clean), no reachability
check in either gate (read `package.ts:126` and `validate.ts:444-457`), the element
caps not exported (read `index.ts`), and no model specification to build from
(`shared/src/office.ts` does not exist).

The remaining 16, by severity: the table model carried no borders, widths, header row
or spans (fixed, model and emitter rules plus a merged-cell fixture); `w:pStyle` was
never pinned to `w:styleId` (fixed, gotcha and fixture added); the document model was
a sentence rather than a specification (fixed, it is unit 1); `\n` and `\t` had no
emission rule (fixed, gotcha and fixture added); `pageBreak` had no emission rule
(fixed, `w:br w:type="page"` in unit 2 with a paragraph-count fixture); fonts and
`docDefaults` were unspecified and the theme part was never mentioned (fixed, fonts
named and theme attributes banned); gate two could not see formatting (fixed, `fodt`
conversion added); the tool boundary had no answer for who may call it and no audit,
idempotency or rate design (fixed, all four written into the deferred tool
constraints); the tool input was not pinned to the document model (fixed, the same
constraint); the product had no caller, no prompt contract and no retrieval route
(fixed, the prompt contract is priced into unit 1 and the retrieval route is recorded
as a maintainer decision that is independent of units 0 through 3); `w:pgMar` was
missing from the default `sectPr` while `buildProof` emits it (fixed, unit 2 copies
`buildProof`'s `sectPr`); the rId two-pass problem blocks hyperlinks later (fixed, the
two passes are named and the `reserve` step is specified); no caps at the model
boundary (fixed, unit 1); hyperlinks were not in the deferral list (fixed); the
create-only never-read-a-byte boundary was never stated (fixed: the driver reads no
bytes and uses no template, so zip-slip and zip-bomb on input are non-issues and
`validateZipBytes` is never wired to a repair path); build cost was unmeasured (fixed,
unit 2 measures build time and peak RSS on the largest fixture and records the
number). That is 16 fixed plus the 5 blockers, 21 of the 22; the 22nd is the
vertical-slice proposal, checked and rejected in the next paragraph.

One finding was checked and rejected with reasons. Pass 3 proposed building the
vertical slice (model, caller, write path, retrieval route) before the emitter. The
round-two reviewer correctly noted that the first draft's rejection was circular for
two of the three pieces: the retrieval route depends on nothing in units 0 through 2,
and the prompt contract depends on unit 1's model, so drafting unit 1 against no
contract is the coupling risk the slice existed to kill. Both halves are priced in
now: unit 1 is drafted against the prompt contract rather than after it, and the
retrieval route is called out as maintainer work that can happen in any order. What
the rejection keeps is the order between the engine and the emitter, which is not
circular: a caller and a retrieval route demonstrated on a driver whose output the
current gates cannot judge would prove nothing.

Round-two checks, run by both reviewers independently after the fixes: all 12 pass-2
findings came back FIXED except one, which came back NOT FIXED and was corrected
again (`MAX_ZIP_ARCHIVE_BYTES` was claimed as noted without being noted; it is named
now). Both reviewers re-ran the bomb script and the load script and got the output
above. Every file and line citation in this document was re-read at the cited line.
The round-two reviewers also raised eleven items of their own, all now fixed: the
`w:numPr` row was missing from the invariant table that unit 3 cites (added, from
CT_NumPr: `ilvl`, `numId`, `numberingChange`, `ins`); `pageBreak`, the `pgMar` copy,
the determinism fixture and the RSS measurement were claimed as unit 2 content
without being in it (all four now are); the rate cap was named as missing from the
tool constraints (added); no fixture exercised `gridSpan` or `tblHeader` (added); the
proof fixture was referenced without being located (named as `buildProof` in
`docx.test.ts`); the reachability fixture promise differed between section 0 and unit
0 (unified); the pass-3 enumeration claimed 17 items and listed 16 (now headed
"remaining 16" with the 22nd finding named as the rejected vertical-slice proposal);
the blocker counts
disagreed across three places in the file (now consistent: three engine blockers of
which two are measured, five blockers in total); the claim that the zip ratio guard was enforced "inside
`validateZipBytes`" named the wrong function (it is in `inspectZip`, which
`validateZipBytes` calls); the claim that the ratio check would stay armed for
"untrusted input" implied a caller that does not exist (the only production caller is
`build()`, and the check stays armed for every other caller); and unit 0's "existing
tests keep passing" was an assertion rather than an examination, so it was replaced
with the two places that need a deliberate look.

Round-three checks, the re-check of those fixes, came back RED on follow-up items
only, with all 34 original findings across the two passes still FIXED. Seven things
changed and are fixed now: the blocker counts said "two engine blockers" in Local
measurements and "both engine blockers" in the status line while the intro said three
(the script carries the two measured ones, reachability is a code read, and both
places now say so); the pass-3 enumeration still listed 16 under a 17 header (now
headed 16, with 16 fixed plus 5 blockers plus 1 rejected accounting for all 22); the
claim that the whole suite uses `hasCode` presence checks was false, because
`validate.test.ts:194` is a third whole-result `deepEqual`, `:195` and `:365` are
`doesNotThrow(() => assertValid(result))`, and `package.test.ts`'s throws name an
exact `e.code` (all named now, along with `validate.test.ts:224-237` and `:301-331`
whose specs pass no `packageRels` and would break if the main-relationship check ran
by default, which is why unit 0's option is gated the way `mainPart` already is); the
precompressed fixture was described as five media parts and is six; the invariant
table was captioned 17 rows after `numPr` made it 18; `buildProof` carried
`createProofSpec`'s line range, since `:25-43` is the spec's `sectPr` and `buildProof`
itself is `:65-79`; and section 0 claimed every blocker was reproduced locally when
two are code reads. The other two round-three findings needed no edit: the status
block no longer claims GREEN anywhere in this document, and the rate-limit shape the
deferred tool constraints lean on is cited from `server/src/ws/gateway.ts:61`, `:70-71`
and `:296-302`, which define and enforce a 20-per-10-second per-connection cap.
Round three also re-ran both scripts and confirmed the output
matches this document line for line, including a rebuild of the `relsempty` package
with a well-formed empty `<Relationships/>` instead of a zero-byte part, which
LibreOffice also refuses with exit 1, so that row is not an artifact of the zero-byte
part.

Round-four checks, two reviewers again, came back RED twice on the verification log
itself rather than on the plan: the round-two and round-three log paragraphs claimed
twelve and nine items while listing eleven and seven, two fixture promises (the
`w:pStyle` resolution check and the out-of-scope guard) had no owning unit, the MS
Learn style URL 404ed for a missing `/word/` path segment, `validate.ts:834` pointed at
a blank line, the zod pin was described repo-wide when `shared/package.json` pins a
different range, and a quote was attributed to SPEC item 3 that lives at
`AGENTS.md:85`. All of those are fixed, and the final re-check confirmed the counts
now match their lists, both URLs return 200, and every citation it spot-checked
resolves.

**Status: GREEN.** Sources are verified, code claims are re-read with file and line
references, the two measured engine blockers and the whole load table were re-measured
locally with scripts that ship in this document, and both reviewers re-ran them
independently. The final re-check returned RED on one item, a quote attributed to
SPEC item 3 that actually lives at AGENTS.md:85, and both attributions now name their
real files (`AGENTS.md:85`, `SPEC.md:8`). Known residual risk: every reader claim is
LibreOffice 26.2.6.3, no Windows Word was available, and CI installs a distro build of
LibreOffice rather than this version.

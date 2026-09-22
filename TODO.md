# k5-work TODO — core basics

- [x] A: `shared/` types (smallest, defines everything else)
  - `shared/src/` session, prompt, tool-call, permission, event, connector types (Zod at boundaries)
- [x] B: service interface TS signature
  - stable `k5-service`: chat/prompt streaming, session new/load/resume/close, tool routing, permissions, audit, timeouts
- [x] C: fake-harness contract test
  - record/replay JSON-RPC vs fake service, first real plug: `opencode`
- [ ] D: ooxml-core minimal ZIP + validator
  - ZIP + `[Content_Types].xml` + `_rels` + rId allocator + validator, JSON-in/engine-out, create-only first
  - Research (cdres, GREEN): `CD_res/implementation/ooxml-core/ooxml-core-research.md` (consolidated) + `CD_res/implementation/ooxml-core/ooxml-zip-engine-research.md` (ZIP/XML engine deep-dive)
  - Location decided: `server/src/ooxml-core`. License: MIT core, permissive deps only (no GPL/AGPL in core).
  - [x] D-1 + D-2 (single PR): foundation + XmlBuilder + shared schemas (`fflate` dep, `xml.ts`/`errors.ts`, `OoxmlPart/PackageSpec` Zod in `shared`, `xml.test.ts`) + ContentTypes table + RelIds allocator (per-scope rIds, Default/Override ownership, target resolution)
  - [x] D-3: ZipWriter + PackageBuilder create-only (methods {0,8}, bit3=0, bit11=1, pinned mtime, deterministic order)
  - [ ] D-4: Validator write-time + post-hoc (coded spec/heuristic checks, corrupt-fixture tests)
  - [ ] D-5: minimal docx proof fixture + LibreOffice repair gate + mark D done

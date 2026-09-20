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

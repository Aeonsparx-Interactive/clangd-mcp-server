# CLAUDE.md

Guidance for Claude Code when working with this MCP server codebase.

## Project Overview

MCP server that bridges Claude Code with clangd LSP for C++ code intelligence on large codebases (Chromium-scale, Unreal Engine 5.8). Production-ready with 12 MCP tools, a one-shot CLI, crash recovery, and lazy initialization.

## Critical Patterns

### Adding New LSP Tools

1. Create `src/tools/your-tool.ts` with MPL-2.0 header
2. Follow pattern: `fileTracker.ensureFileOpen()` → `withRetry(() => lspClient.request())` → return JSON string
3. Register in `src/index.ts`: import, add to ListToolsRequestSchema, add case to CallToolRequestSchema
4. Build with `npm run build`

See existing tools (find-definition.ts, find-references.ts) for examples.

### Key Gotchas

- **URI handling**: Always use `normalizeToUri()/uriToPath()` from utils/uri.ts, never mix paths and URIs
- **File lifecycle**: Must call `fileTracker.ensureFileOpen()` before any file-based LSP request
- **LSP results**: textDocument/definition returns `Location | Location[] | null` - normalize to array
- **Imports**: Must use `.js` extension (ES modules), not `.ts`
- **Positions**: LSP is 0-indexed on the wire, tools are 1-based. Never hand-write a `+1`/`-1`: go
  through `src/utils/coords.ts` (`toLspLine`, `fromLspLine`, `toLspPosition`, `fromLspStart`,
  `minLine`, `lineDescription`). `COORD_BASE=0` makes the tools 0-based, and every tool stays
  correct because of that indirection.
- **Relative paths**: `pathToUri` resolves a relative path against `PROJECT_ROOT`, not the process
  cwd — the MCP host's cwd is the server directory.
- **Hover contents**: use `extractHoverContents()` from `src/tools/get-hover.ts`. `contents` is
  `string | MarkedString | MarkedString[]` and `MarkedString` can be `{ kind: 'markdown', value }`,
  which `String()` renders as `[object Object]`.
- **Mock LSP URIs in tests**: must be Windows-absolute (`file:///C:/Source/X.h`); `file:///Source/X.h`
  throws `File URL path must be absolute` in `uriToPath` on Windows.
- **Typed mocks**: `let x: jest.Mock` is `Mock<UnknownFunction>` and rejects a typed `jest.fn` with
  TS2322. Write `jest.Mock<Promise<string>, [string]>`, or type the factory inline:
  `jest.fn<(path: string) => Promise<string>>(async (p: string) => ...)`.

## Architecture Notes

- **ClangdManager** (src/clangd-manager.ts): Subprocess lifecycle, auto-restart on crash (max 3 attempts)
- **LSPClient** (src/lsp-client.ts): JSON-RPC over stdio, Content-Length framing, request correlation
- **FileTracker** (src/file-tracker.ts): Manages didOpen/didClose, prevents duplicates
- **ConfigDetector** (src/config-detector.ts): Auto-detects compile_commands.json, project type detection, and project bundled clangd (Chromium auto-detected, others via CLANGD_PATH)
- **settings** (src/utils/settings.ts): Every project knob is an env var read live per request —
  `projectRoot`, `coordBase`, `scanDirs`, `seedFiles`, `namePrefixes`, `lintFilterPath`, and the
  three timeouts. No config file, no Unreal-specific detection. `splitList` splits on `,` and `;`
  only: `SEED_FILES` paths contain spaces, so whitespace is not a separator.
- **coords** (src/utils/coords.ts): the single place that converts between tool coordinates and LSP
- **file-scan** (src/tools/file-scan.ts): `nameVariants`, `walkSourceFiles` (absolute paths),
  `filesByName` (headers first), `filesByContent`, `fileScanSymbols` — the fallback used when the
  background index does not know a name
- **cli** (src/cli.ts): one-shot `node dist/index.js cli <subcommand>`; `src/index.ts` dispatches
  `cli`/`--cli` in argv to `runCli`

Data flow: MCP request → index.ts routes → FileTracker opens file → LSPClient sends request → format response

## Design Decisions

- **Background indexing OFF by default**: MCP sporadic queries don't benefit, saves GBs of memory
- **Lazy initialization**: clangd starts on first query, not at server startup
- **ES modules**: Required by MCP SDK, all imports need .js extension
- **Retry logic**: Exponential backoff for transient LSP errors (100ms → 200ms → 400ms, max 3 attempts)
- **Project bundled clangd**: Auto-detects project bundled clangd (Chromium supported via `.gclient` detection) and allows manual specification via `CLANGD_PATH` for other projects, with version validation and warnings
- **1-based coordinates by default**: chosen for the Unreal use case, where agents read `path:line`
  out of compiler output and editors. `COORD_BASE=0` restores raw LSP. Chosen over auto-detecting a
  project type: the conversion is one helper, the env var is one line, and no UE knowledge enters
  the server.
- **clang-tidy OFF by default, opt-in via `CLANG_TIDY=1`**: UE headers emit a huge tidy volume.
- **`--malloc-trim` is Linux-only**: the VS build of clangd on Windows exits with
  `Unknown command line argument '--malloc-trim'`, which surfaced as
  `ClangdError: Clangd process failed to start` on every tool.
- **`--offset-encoding=utf-16`** is passed to clangd and advertised in the client's
  `general.positionEncodings`, so columns match editor display.
- **Symbol search retries, then scans files**: a UE `compile_commands.json` lists only the editor's
  translation units, so the background index knows a fraction of the project. `workspace_symbol_search`
  opens `SEED_FILES`, retries until `CLANGD_SYMBOL_TIMEOUT`, tries `NAME_PREFIXES` spellings, and only
  then opens name-matched files (`CLANGD_MAX_SCAN_FILES` cap). The answer says which route it took.
- **Not ported from the Lp project script**: `--query-driver=**` (produces phantom references to the bare
  MSVC include directory; `.clangd` already supplies the `/imsvc` paths), `--pch-storage=disk`, and the
  stderr-regex index-progress gate.

## Publishing

The package is `@aeonsparx/clangd-mcp-server` on npm. `package.json` needs `files: ["dist", "README.md",
"LICENSE", "docs"]` (dist is gitignored, so an explicit `files` list is what keeps the tarball
complete), `publishConfig.access: "public"` (scoped packages default to restricted), and
`prepare: npm run build` so git installs compile. `src/index.ts` reads the MCP server version from
`package.json` at runtime — never hardcode a version string in source.

`.github/workflows/publish.yml` does **staged** publishing on a GitHub Release whose tag
`v<version>` matches `package.json` (pre-release -> `next` dist-tag): CI runs
`npm stage publish --access public --tag <tag>` (no 2FA prompt) and a maintainer approves the
stage with 2FA on npmjs.com (Staged Packages tab) or `npm stage approve <stage-id>`. Nothing is
installable until approved. `npm stage` needs npm >= 11.15.0 / Node >= 22.14.0, so the stage job
pins `npm install -g npm@11.15.0` on Node 22. `scripts/ci/find-stage.mjs` parses
`npm stage list <pkg> --json` (shape is undocumented, so it walks the whole tree) to detect an
existing stage and to report the stage id. The `NPM_TOKEN` secret must be a granular token with
**Read and write: stage only** and **Bypass 2FA off** — direct `npm publish` with it fails
`E_STAGE_REQUIRED`.

## License

MPL-2.0. All new source files must include the MPL-2.0 header:

```typescript
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
```

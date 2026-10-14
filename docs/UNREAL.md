# Unreal Engine project

All project configuration is environment variables — there is no project config file and no
Unreal-specific auto-detection. A working UE 5.8 setup:

```json
{"mcpServers": {"clangd": {"command": "node", "args": ["/path/to/clangd-mcp-server/dist/index.js"],
  "env": {
    "PROJECT_ROOT": "C:/Unreal Projects/MyProject",
    "COMPILE_COMMANDS_DIR": "C:/Unreal Projects/MyProject/.vscode/unreal-clangd",
    "CLANGD_PATH": "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/Llvm/x64/bin/clangd.exe",
    "SEED_FILES": "Source/MyProject/Private/Character/MyProjectPawn.cpp"
  }}}}
```

- `COMPILE_COMMANDS_DIR` must point at the directory holding `compile_commands.json`. In UE that
  file lists only the translation units the editor generated, so the background index knows a
  fraction of the project — that is why symbol search retries and, failing that, opens files.
- `SEED_FILES` is the highest-leverage knob: opening a translation unit that includes the header you
  care about makes its symbols searchable in seconds. List the TUs you work in daily.
- `--malloc-trim` is passed on Linux only; the VS build of clangd rejects it on Windows and exits.
- `--offset-encoding=utf-16` is passed by default and the client advertises the same encoding, so
  columns line up with what editors show.
- `--clang-tidy` stays off unless `CLANG_TIDY=1`. UE headers produce a very large volume of tidy
  diagnostics, so filter them with `LINT_FILTER` before turning it on.

### Coordinates

Line and column are **1-based** in every tool input and output — the convention every editor and
clangd's own `--offset-encoding` display uses. Set `COORD_BASE=0` to get raw LSP 0-based numbers
instead. The wire format is always LSP; conversion happens at the tool boundary.

### One-shot CLI

The same operations run without an MCP host, which is how you script them and how you verify a
config. Each invocation starts clangd, does one query, and exits — expect seconds, not milliseconds.

```bash
node dist/index.js cli status
node dist/index.js cli symbols "MyProjectPawn" --limit 20
node dist/index.js cli lint Source/MyProject/Private/Character/MyProjectPawn.cpp --compact
node dist/index.js cli context Source/MyProject/Public/Character/MyProjectPawn.h 26 14
node dist/index.js cli definition Source/MyProject/Public/Character/MyProjectCharacterPawn.h 62 14
node dist/index.js cli outline Source/MyProject/Public/Character/MyProjectPawn.h
```

Subcommands: `status`, `symbols`, `lint`, `context`, `outline`, `definition`, `declaration`,
`references`, `hover`, `implementations`, `type-hierarchy`, `call-hierarchy`, `symbols-in-file`.
Relative paths resolve against `PROJECT_ROOT`, so they work from any working directory.

### Tools

| Tool                      | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `find_definition`         | Where a symbol is declared/defined                                |
| `find_declaration`        | The declaration (header) of a symbol found in a `.cpp`            |
| `find_references`         | Every use of a symbol                                             |
| `find_implementations`    | Overrides of a virtual function                                   |
| `get_hover`               | Signature, doc comment, size/alignment                            |
| `get_diagnostics`         | Compiler and (opt-in) clang-tidy diagnostics for a file           |
| `get_document_symbols`    | Outline of one file                                               |
| `get_call_hierarchy`      | Callers and callees of a function                                 |
| `get_type_hierarchy`      | Supertypes and subtypes of a class                                |
| `workspace_symbol_search` | Name search across the project, with retry and file-scan fallback |
| `get_context`             | Hover + definition + declaration + references in one call         |
| `get_status`              | clangd state, index cache size, settings in effect                |

`workspace_symbol_search` answers `foundBy: "index"` when clangd's background index knew the name,
and `foundBy: "file-scan"` when it had to open matching files to read their symbols — the latter
sets `note` and lists `scannedFiles`. Treat a `file-scan` answer as a hint to add that file to
`SEED_FILES`.

# hvp-language-server — developer map

Full HVP language spec: `../hvp-documentation/Using the HVP Language.md`.

`src/core/*` is a behaviour-identical, editor-agnostic port of the analysis logic that
used to live directly inside `vscode-hvp`; `src/server.ts` wires it up to a real LSP
connection; `tools/gen-grammars.ts` generates both client syntax grammars from
`src/core/keywords.ts`.

## Architecture

- `src/core/keywords.ts` — pure data, no `vscode` dependency. This is the source of
  truth for completion, and every client's generated grammar (`tools/gen-grammars.ts`)
  is what keeps highlighting in sync with it — no hand-copying needed once that's run.
- `src/core/textLines.ts` — `getLines(document)` / `lineRange(lines, i)`. Every other core
  module works off a plain `string[]` instead of an editor's own document/line API.
  Trailing newline is dropped so line indices match `vscode.TextDocument`'s model (what
  the golden test baseline was captured against).
- `src/core/blockAnalysis.ts` — `maskLine()`, `PAIR_SPECS`, `analyzeBlocks()`, re-typed
  onto `vscode-languageserver-types` (`Diagnostic`/`Range`/`DiagnosticSeverity` object
  literals). Also returns `foldingRanges`: one per cleanly-matched block pair, recorded
  in `closeFrame()` for free off the same stack walk.
- `src/core/symbols.ts` — `provideDocumentSymbols(lines)`. LSP `DocumentSymbol` needs an
  explicit `selectionRange` (set equal to the declaration range) that vscode's
  constructor didn't require.
- `src/core/completion.ts` — `provideCompletionItems(lines, position, lineSnapshots)`.
  Takes `lineSnapshots` (the per-line block-stack index `analyzeBlocks()` produces) as a
  parameter instead of reading a module-level cache keyed by document URI — that caching
  lives in `server.ts`, not this module. Items carry `textEdit: TextEdit.replace(range,
  text)` instead of vscode's `item.range` field. Block-opener items (`plan`, `feature`,
  `metric`, …) set `insertTextFormat: InsertTextFormat.Snippet` and their
  `insertText`/`textEdit` body is `BLOCK_SNIPPET_BODY[kind]` from `keywords.ts`
  (tabstops and all), not a plain `"feature "` string.
- `src/core/folding.ts` — `provideFoldingRanges(lines)`, thin wrapper over
  `analyzeBlocks(lines).foldingRanges`.
- `src/server.ts` — the LSP connection. `createConnection(ProposedFeatures.all)` +
  `TextDocuments(TextDocument)`; capabilities: incremental sync, `completionProvider:
  { triggerCharacters: ['.'] }`, `documentSymbolProvider: true`, `foldingRangeProvider:
  true`. Debounces linting 300ms — `blockIndexCache: Map<uri, LineSnapshot[]>` and
  `pendingLints: Map<uri, Timeout>`, both cleared on `onDidClose` along with pushing an
  empty `publishDiagnostics` array. One wrinkle: LSP's `TextDocuments.onDidChangeContent`
  fires for both the initial open *and* every edit (an editor's own API might have
  separate open/change events), so `onDidOpen` still lints immediately and
  `onDidChangeContent` still debounces — but the open also fires one harmless redundant
  debounced re-lint of unchanged content 300ms later. Documented in a comment in the
  file, not treated as a bug.
- `tools/gen-grammars.ts` — reads keyword tables from `src/core/keywords.ts` and writes
  `generated/hvp.tmLanguage.json` (VS Code) and `generated/HVP.sublime-syntax` (Sublime
  Text). One shared scope table drives both: `keyword.control.hvp` (block/filter
  keywords), `storage.type.hvp` (attribute/annotation), `support.type.hvp` (types),
  `variable.other.property.hvp` (fields), `entity.name.type.hvp` (builtin metrics).
  Non-keyword-driven sections (comments, strings, numbers, operators,
  `declaration-name`) are static templates. **Ordering trap:** every alternation is
  sorted longest-first (`longestFirst()`) before joining, so a dotted name's prefix
  (`test`) never wins over the full name (`test.percent.pass`) — see
  `test/genGrammars.test.ts` for a regression test using exactly that pair. Run via
  `npm run gen-grammars`; output isn't committed (see `.gitignore`) since it's fully
  derived and reproducible — client repos check in their own copy.
- `bin/hvp-language-server.js` — `#!/usr/bin/env node` launcher `require()`-ing the
  compiled `out/src/server.js`. `--stdio`/`--node-ipc`/`--socket=` argument parsing is
  handled inside `vscode-languageserver`'s `createConnection()` itself (it reads
  `process.argv`), so this file has no argument-parsing logic of its own.

**Trap to watch for:** `vscode.CompletionItemKind` and LSP `CompletionItemKind` are
numbered differently (e.g. `Keyword` is 13 in vscode's enum, 14 in LSP's). Never compare
completion items by raw kind number against anything captured from vscode's own API —
compare by kind *name*. `test/golden.test.ts` does this via `reverseLookup()`.

## The 7 block pairs

| Open | Close |
|---|---|
| `plan` | `endplan` |
| `feature` | `endfeature` |
| `metric` | `endmetric` |
| `measure` | `endmeasure` |
| `override` | `endoverride` |
| `filter` | `endfilter` |
| `until` | `enduntil` |

`until` is a 3-way branch, not a simple pair: `until ... ; elseuntil ... ; else; ... enduntil`.
Only `until` pushes a stack frame and only `enduntil` pops it — `elseuntil`/`else` are
branches *within* that same logical block and never touch the block stack.

## Tests

Runner: **`node:test`**, no extra test framework — `npm test` runs `tsc -p ./` then
`node --test out/test/`. Picked over vitest/jest to avoid adding dependencies for what is,
for now, one golden-comparison harness plus a handful of `maskLine` unit tests.

- `test/golden.test.ts` — for every fixture in `test/fixtures/*.hvp` (including
  `realistic-sample.hvp`, a synthetic large/deeply-nested fixture standing in for a
  real-world-sized document), runs `analyzeBlocks()` / `provideDocumentSymbols()` /
  `provideCompletionItems()` and deep-compares (normalized: enum values → names) against
  `test/golden/*.json` — the regression reference, not something this package generates
  at test time. Completion scenario → source document mapping (`valid-blocks.hvp` vs.
  `realistic-sample.hvp`) is hardcoded in the test; positions are read straight from the
  golden file rather than re-derived.
- `test/maskLine.test.ts` — targeted edge cases not exercised by the fixtures: escaped
  quote inside a string, `//` inside a string, a block comment spanning multiple lines.
- `test/genGrammars.test.ts` — validates `tools/gen-grammars.ts`'s output: static
  scaffolding present, the longest-first ordering trap actually prevents `test`
  from shadowing `test.percent.pass`/`test.pass`, and the CLI (`node
  out/tools/gen-grammars.js`) writes parseable JSON/sublime-syntax files.
- `test/serverSmoke.test.ts` — end-to-end proof that `src/server.ts`'s LSP wiring works,
  not just the core functions in isolation. Spawns the compiled server as a real child
  process over `--stdio` and drives it with a ~100-line hand-rolled JSON-RPC/
  Content-Length client (no LSP client library dependency): `initialize` → capability
  assertions, `didOpen` → `publishDiagnostics` (immediate, no debounce), `completion`/
  `documentSymbol`/`foldingRange` requests, `didClose` → `publishDiagnostics` with `[]`.
  Does not test the 300ms debounce's timing directly (fragile in CI); the debounce logic
  itself is a small, directly-readable block in `server.ts`.

`npm test` (`tsc -p ./ && node --test out/test/`) runs all of the above. Because `tsc`
doesn't copy non-`.ts` assets into `out/`, tests resolve fixture/golden/fixture paths
from `process.cwd()` (assumed to be the package root, true whenever run via `npm test`),
not `__dirname`.

## Publishing

`npm publish` has not been run yet — it needs npm account auth and is a real
public-registry action. `package.json` has publish-prep fields filled in (`files`
allowlist, `bin`, `main`/`types`, `repository`/`keywords`, `author`, version bumped to
`0.1.0`) and a `prepublishOnly` script that rebuilds `out/`/`generated/` before packing
— `npm login` then `npm publish` is all that's left.

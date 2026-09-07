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
- `src/core/textLines.ts` — `getLines(document)` only. Retained for callers that still
  want a plain `string[]`; core modules work off `PlanDocument`/`SourceText` instead.
- `src/core/tokenizer.ts` — `SourceText` (line starts, `positionAt`/`offsetAt`, `span`,
  `lineRange`/`lineEnd`/`lineText`) and `tokenize()`, which produces identifier/number/
  string/comment/punctuation tokens plus unterminated-string/comment diagnostics.
- `src/core/parser.ts` / `src/core/planModel.ts` — `parseDocument(text)` builds the
  `PlanDocument` (nodes, diagnostics, folding ranges) that every provider reads. This
  replaced the old regex `maskLine()`/`analyzeBlocks()` block scanner, which is gone.
- `src/core/declarations.ts` — `buildDeclarations(model)` and `scopeAt(model, offset)`:
  the per-plan name table (attributes, annotations and metrics in one namespace),
  built-ins first, user declarations shadowing them. Reached through
  `model.declarations`, which memoizes it per parse — completion and hover need it on
  requests that never run diagnostics. It imports `planModel` **types only**, so the
  `planModel → declarations → planModel` cycle never exists at runtime; keep it that way.
- `src/core/values.ts` — `literal(run)` classifies an attribute/annotation value run
  (`integer`/`real`/`percent`/`string`/`identifier`/`expression`/`empty`, leading `-`
  handled), and `checkValue(declaration, run)` types it. Anything classified
  `expression` — `${...}` interpolation, goal-shaped comparisons — is deliberately never
  checked, so unmodelled forms can't produce false positives; neither is `set`, whose
  literal shape the spec never describes.
- `src/core/resolver.ts` — `resolveValues(model, feature, context)`: effective values
  with provenance. Attributes inherit down the scope chain, annotations don't;
  `ResolutionContext` (`instancePath`/`parameters`/`overrides`) is the seam WS5 and WS7
  fill in. `until` branches are transparent to scope lookup, since which branch is live
  is WS7's question.
- `src/core/semanticDiagnostics.ts` — `invalid-value` and `unknown-assignment-target`,
  run from `parser.ts` right after `structuralDiagnostics`. Three deliberate exemptions:
  a left-hand side resolving to a metric is a goal override (WS3), assignments inside
  `override`/`filter` address the instantiated hierarchy (WS7), and a node with
  `incomplete: true` already carries a syntax diagnostic so no semantic error is stacked
  on it.
- `src/core/hover.ts` — `provideHover(model, position, uri?, context?)` for feature/plan
  names, assignment left-hand sides and declaration names. The `uri` is optional on
  purpose: with one, every origin in the value table becomes a `[label](uri#Lline,char)`
  link; without one it stays plain text, so core never assumes a file-backed document.
- `src/core/symbols.ts` — `provideDocumentSymbols(model)`. LSP `DocumentSymbol` needs an
  explicit `selectionRange` (set equal to the declaration range) that vscode's
  constructor didn't require.
- `src/core/completion.ts` — `provideCompletionItems(model, position)`. Cursor context
  comes from the model (`maskedAt`/`blocksAt`); the line text is read off
  `model.source.lineText(...)`, so no per-request full-document split. Model caching
  lives in `server.ts`, not this module. Items carry `textEdit: TextEdit.replace(range,
  text)` instead of vscode's `item.range` field. Block-opener items (`plan`, `feature`,
  `metric`, …) set `insertTextFormat: InsertTextFormat.Snippet` and their
  `insertText`/`textEdit` body is `BLOCK_SNIPPET_BODY[kind]` from `keywords.ts`
  (tabstops and all), not a plain `"feature "` string. The `inTypePosition`/
  `inAggregatorValuePosition`/`inMetricTypePosition` regexes only see the current line,
  which is a pre-WS0 leftover; `assignmentTargetAt()` (which decides whether enum members
  are offered) reads the token stream backwards instead, so a newline or a comment between
  `=` and the cursor doesn't matter. Prefer that shape for anything new.
- `src/core/folding.ts` — `provideFoldingRanges(model)`, thin wrapper over
  `model.foldingRanges`.
- `src/server.ts` — the LSP connection. `createConnection(ProposedFeatures.all)` +
  `TextDocuments(TextDocument)`; capabilities: incremental sync, `completionProvider:
  { triggerCharacters: ['.'] }`, `documentSymbolProvider: true`, `foldingRangeProvider:
  true`, `hoverProvider: true`. Debounces linting 300ms — `modelCache: Map<uri, {version, PlanDocument}>` and
  `pendingLints: Map<uri, Timeout>`, both cleared on `onDidClose` along with pushing an
  empty `publishDiagnostics` array. `modelFor()` re-parses only when the document
  version changed, so requests arriving before the debounce still see the latest text. One wrinkle: LSP's `TextDocuments.onDidChangeContent`
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
for now, one golden-comparison harness plus the parser/tokenizer unit tests.

- `test/golden.test.ts` — for every fixture in `test/fixtures/*.hvp` (including
  `realistic-sample.hvp`, a synthetic large/deeply-nested fixture standing in for a
  real-world-sized document), runs `parseDocument()` / `provideDocumentSymbols()` /
  `provideCompletionItems()` and deep-compares (normalized: enum values → names) against
  `test/golden/*.json` — the regression reference, not something this package generates
  at test time. Completion scenario → source document mapping (`valid-blocks.hvp` vs.
  `realistic-sample.hvp`) is hardcoded in the test; positions are read straight from the
  golden file rather than re-derived.
- `test/tokenizerEdgeCases.test.ts` — targeted lexical edge cases not exercised by the
  fixtures: escaped quote inside a string, `//` inside a string, a block comment spanning
  multiple lines, and unterminated strings/comments running to EOF.
- `test/parser.test.ts` — the statement model itself: hierarchy, recovery from missing
  semicolons/delimiters, UTF-16 and CRLF ranges, and cursor-scoped completion.
- `test/structuralDiagnostics.test.ts` — WS1: identifiers, duplicates, built-in
  redeclarations, placement, the top-level plan rule, and completion scoping.
- `test/semantics.test.ts` — WS2: the declaration table, value typing, unknown assignment
  targets, attribute inheritance vs. local-only annotations, the `ResolutionContext`
  seam, hover output (including the linked origins) and declared-name/enum completion.
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

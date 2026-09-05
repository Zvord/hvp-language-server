# hvp-language-server

A standalone [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
server for the HVP (Hierarchical Verification Plan) language used by Synopsys
Verification Planner.

Language intelligence — syntax-aware completion (with snippet-body block scaffolding),
block-imbalance diagnostics, document outline, folding — lives here, wired up to a real
LSP connection, so it can be shared across editors (VS Code, Zed, Sublime Text) instead
of reimplemented per editor. `npm publish` itself has **not** been run yet — see
"Publishing" below.

## Package layout

```
src/core/             ← editor-agnostic analysis (no vscode or LSP-connection types), unit-testable
src/server.ts         ← LSP wiring: connection, document sync, capabilities, debounced lint
bin/hvp-language-server.js ← #!/usr/bin/env node launcher, invoked by client editors
tools/gen-grammars.ts ← generates syntax-highlighting grammars for client repos from src/core/keywords.ts
generated/            ← gen-grammars.ts output (not committed — see .gitignore, fully derived)
test/                 ← fixtures + golden snapshots + server/grammar-generator tests
```

## Setup

```
npm install
npm test              # tsc -p ./ && node --test out/test/*.test.js
npm run gen-grammars   # tsc -p ./ && node out/tools/gen-grammars.js
```

`npm test` checks statement parsing and recovery, compares `src/core/*` against golden output, validates the grammar
generator's output against the hand-written reference grammar, and drives the compiled
server over `--stdio` as a real child process (see `CLAUDE.md` for the full test
breakdown).

## Statement model

`parseDocument(text)` in `src/core/parser.ts` tokenizes the entire document and
returns a `PlanDocument` from `src/core/planModel.ts`. The server caches this by
URI and document version for diagnostics, completion context, folding and the
feature outline. Requests arriving before the diagnostics debounce still use
the latest version.

- `roots` and ordered `children` preserve syntax hierarchy, including modifier
  blocks outside plans. `nodes` is a flat index; `id` and `parentId` are local to
  one parse and must not be retained across document versions.
- Every node has UTF-16 offsets (`start`, exclusive `end`), an LSP `range`, a
  `header` span and an `incomplete` flag. Named nodes have a `name` token with
  its own range; `close` exists only for correctly matched block endings.
- Types expose enum/aggregate members and optional weights. Subplans expose
  parameters; measures expose metric references; sources expose ordered raw
  value runs. Assignment paths expose individual segments, including wildcards.
- `until.children` contains `branch` nodes; each branch carries its date (except
  `else`) and ordered statements. Assignments inside branches and modifiers
  inside plans remain accepted for compatibility with existing files.
- Expressions remain `TokenRun` values: tokens, exact source text and ranges.
  String escapes and interpolation are preserved, not evaluated. Unknown
  statements are retained as `unknown` nodes. Symbol resolution, type checking,
  placement validation and goal-expression semantics belong to later workstreams.
- `nodeAt`, `parent`, `enclosingFeature`, `enclosingPlan`, `blocksAt` and
  `maskedAt` provide navigation and cursor context. Treat the returned model
  as read-only; reparsing creates a new model.

Missing terminators and delimiters recover at recognizable statement/block
boundaries. A mismatched block closer pops one open block, preserving the
established diagnostic recovery policy. Unterminated strings/comments extend
to EOF and are diagnosed. Correctly matched multiline blocks produce folds.
`parseDocument` is the only entry point: the completion, symbol and folding
providers all take a `PlanDocument` rather than lines or line snapshots.

The implementation is handwritten TypeScript with no added runtime dependencies.
It reparses a changed document in full; incremental parsing can be introduced
behind the same model API if profiling shows a need.

## Running the server

```
node bin/hvp-language-server.js --stdio
```

This is what an editor client's `ServerOptions` should invoke (via
`require.resolve('hvp-language-server/bin/hvp-language-server.js')` or the npm-installed
binary once published). `--node-ipc` and `--socket=<port>` transports are also supported,
handled automatically by `vscode-languageserver`'s `createConnection()`.

## Publishing

Not yet done — `npm publish` is a real public-registry action that needs npm account
auth. `package.json` has the fields a real publish needs (`files` allowlist, `bin`,
`main`/`types`, `repository`/`keywords`, `author`, version `0.1.0`), and a
`prepublishOnly` script rebuilds `out/`/`generated/` before packing. `npm login` then
`npm publish` is all that's left.

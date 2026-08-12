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
npm test              # tsc -p ./ && node --test out/test/
npm run gen-grammars   # tsc -p ./ && node out/tools/gen-grammars.js
```

`npm test` compares `src/core/*` against golden output, validates the grammar
generator's output against the hand-written reference grammar, and drives the compiled
server over `--stdio` as a real child process (see `CLAUDE.md` for the full test
breakdown).

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
`main`/`types`, `repository`/`keywords`, version `0.1.0`), but `repository.url`/
`bugs.url`/`homepage` still carry the same `<your-username>` placeholder as the other
repos in this project — fill those in before publishing.

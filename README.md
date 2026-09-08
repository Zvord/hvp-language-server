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
src/workspaceFiles.ts ← the workspace scan (node:fs), owned by the server: core never reads a file
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
  statements are retained as `unknown` nodes. Symbol resolution, type checking
  and goal-expression semantics belong to later workstreams.
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

## Structural diagnostics

The parser runs `structuralDiagnostics(model)` once after building the model.
Diagnostics include identifier syntax and reserved words, duplicate declarations
(attributes, annotations and metrics share a plan namespace), duplicate sibling
features and measures, and invalid declaration/statement placement. Built-in
redeclarations are warnings because the documentation includes a conflicting
`weight` declaration example. Names are case-sensitive; invalid name candidates
retain their full source range so punctuation is not silently discarded.

For multiple plans in one document, every plan except the last must be referenced
by a `subplan` statement. Cross-file plan ordering, resolution and cycle checks
remain for the workspace index (WS5).

Completion boosts attribute, annotation and metric declarations only inside plans,
and offers only the innermost block's closing keyword. `phase` is a custom
attribute, not a built-in field; generated grammars reflect this too.

## Values and hover

`model.declarations` is a lazily built per-plan table (`src/core/declarations.ts`)
of every attribute, annotation and metric name a plan resolves, seeded with the
built-ins from `keywords.ts` and shadowed by any declaration of the same name.
Attributes, annotations and metrics share one namespace, matching how an
assignment's left-hand side is looked up.

`resolveValues(model, feature, context)` in `src/core/resolver.ts` returns the
effective value of every attribute and annotation at a feature, each with its
origin. Attributes inherit: declaration default, then a subplan parameter for
this instance, then the last assignment in each scope from the plan down.
Annotations take only an assignment in the feature itself. `until` branches are
transparent — their statements belong to the scope containing the `until`, since
only WS7 knows which branch is live. The `ResolutionContext` carries
`instancePath`, `parameters` and `overrides` so instances (WS5, filled in by
`workspace.ts`'s `contextOf`) and modifiers (WS7) are added without rewriting
the resolver; single-file callers pass `{}`.

`semanticDiagnostics(model)` types declaration defaults and assigned values
against their declaration (`invalid-value`) and reports assignments to names no
plan declares (`unknown-assignment-target`). A left-hand side that resolves to a
metric is a feature-level goal override and is left to WS3; assignments inside
`override`/`filter` blocks address the instantiated hierarchy and are left to
WS7. Nothing is checked on a statement the parser had to recover from, and
`set`, expression-shaped and interpolated values are never type-checked.

`provideHover(model, position, { uri?, context?, index? })` covers feature and plan
names (the value table, each origin linked back into the document when a URI is
given), assignment left-hand sides, `subplan` statements and declaration names.

## Metrics, goals and measures

`keywords.ts` carries the documented shape of every built-in metric
(`BUILTIN_METRIC_DECLARATIONS`: type, aggregator and enum or aggregate members)
and Table 2's type/aggregator compatibility (`METRIC_TYPE_AGGREGATORS`), so a
metric `Declaration` from the same table as attributes and annotations answers
what a metric is. `Declaration.metric` adds the aggregator, the goal source text
and the `aggregate {X(weight=...)}` weights.

`parseGoal(source, tokens, fallback)` in `src/core/goals.ts` is the only real
expression parser in the server, following Table 3's precedence — note that `!`
binds *looser* than the comparisons. It keeps `match(...)` and `inside {...}` as
their own node kinds so they can be reported as unsupported rather than as
syntax errors.

`metricDiagnostics(model)` in `src/core/metricDiagnostics.ts` reports
`invalid-metric-type`, `invalid-aggregator`, `unknown-metric`,
`incompatible-aggregate-member`, `invalid-weight`, `invalid-goal-expression`,
`unknown-goal-identifier` (a warning), `unsupported-expression` and
`invalid-goal-operand`. Arithmetic on a ratio metric is a warning, not an error:
the chapter forbids it in one place and converts a ratio to a percentage before
goal evaluation in another. Measures with no `source` keep the parser's existing
warning — real plans leave the source out often enough that the question is
noted in HVP-LANGUAGE-SUPPORT-GAPS.md rather than settled here.

`resolveGoal(model, scope, declaration, context)` in `src/core/metrics.ts`
returns the goal in force at a feature with the same `Origin` provenance the
value resolver uses: the metric's own `goal = ...`, then each feature-level
override (`Group = Group >= 0.8;`) from the plan down, then `context.overrides`
for WS7. Feature-level overrides inherit downward like attributes; the chapter
states that only for the `override` modifier, so WS7 confirms it against the
tool. Hover on a metric name — in its declaration, in a `measure` metric list,
in an `aggregate {...}` type, or on a goal override — shows the signature,
aggregator and that goal. Completion offers declared and built-in metrics where
a metric reference belongs, and qualified members after `Name.`.

## Source expressions

`parseSourceExpression(source, token)` in `src/core/sourceExpressions.ts` reads
the inside of a `source = "..."` string: the optional Table 4 keyword prefix
(`module:`, `instance:`, `tree:`, `property:`, the two `property … 'h###` mask
forms, `group:`, `group bin:`, `group instance:`, `group instance bin:`), the
`?`/`*`/`**` wildcards, the `` `r` ``/`` `n` `` regex tags, the `` `-` `` removal
tag and `${name}` interpolation. Every part carries a range into the *document*,
not an index into the literal: the literal's `\"` and `\\` escapes are decoded
first and each decoded character keeps the offset it came from.

`checkExtendedRegex(pattern)` is a hand-written POSIX 1003.2 ERE check —
`RegExp` is deliberately not used, since JS and POSIX disagree in both
directions (`{` alone, `\d`, lookahead, `[[:alpha:]]`). Only what both flavours
call malformed is reported: unbalanced `(`/`)`, an unterminated bracket
expression, a dangling `\`, and a repetition with nothing to repeat.

`sourceDiagnostics(model)` in `src/core/sourceDiagnostics.ts` reports
`incompatible-source-keyword` (a warning), `invalid-source-regex`,
`unescaped-regex-dot` (a warning), `unknown-interpolation`,
`invalid-interpolation` and `wildcard-source-opportunity` (a hint). It says
nothing where the chapter is not precise enough to be sure: a prefix that is not
one of Table 4's keywords is not a prefix at all, a measure naming any metric
outside Table 4 is not held to it, and a regular expression an interpolation
appears in is not checked at all.

Hover on a source string shows the string as the tool expands it — WS2's
resolver substitutes each `${name}`, and `${objpath}` becomes
`plan.feature.measure`. Completion offers the keyword prefixes at the head of
the string and attribute, annotation and `objpath` names inside `${`.

## Workspace, subplans and instances

The chapter describes a *set* of plan files handed to the tool through
`-plan`/`-mod` arguments, with no include directive: a plan name is global
across that set and is not tied to a file name. The editor approximates the set
with the workspace, so every `.hvp` file under it is indexed.

`WorkspaceIndex` in `src/core/workspace.ts` is the interface the rest of the
analysis codes against — `plans(name)`, `allPlans()`, `documents()`,
`document(uri)` and `instances()` — and `buildIndex(documents)` builds one from
models a caller already holds. Reading the files is `src/workspaceFiles.ts`'s
job, beside `server.ts`, so `src/core` still never assumes a document has a file
behind it: the server scans the workspace folders once at `initialize`, keeps
open documents as an overlay over what is on disk, and re-reads a file when the
client reports it changed. Nothing there runs on a keystroke — `parseDocument`
still sees one document, and hover and completion read whatever index the last
change left.

`instances()` is the instantiated hierarchy: one `PlanInstance` per
instantiation, carrying the `#(name=value)` parameters that instance received
and the path it hangs under, so the same subplan instantiated four times is four
instances with four sets of values. `contextOf(instance)` turns one into the
`ResolutionContext` the resolver already took.

`workspaceDiagnostics(model, uri, index)` is the pass that needs more than one
file, and returns the document's complete diagnostic list. It adds
`unknown-plan`, `unknown-parameter`, `invalid-parameter-value` (the same
`checkValue` rule as any other typed value) and `subplan-cycle`, and it drops
WS1's `unreferenced-plan` when another file instantiates the plan. It is not run
from `parseDocument`: the index changes on a different clock than the parse.

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

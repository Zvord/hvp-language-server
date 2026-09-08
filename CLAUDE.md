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
  Also Table 4 (`SOURCE_KEYWORDS`, `SOURCE_MASK_WORDS`, `TABLE_4_METRICS`), the
  source tag/wildcard spellings (`SOURCE_TAGS`, `SOURCE_WILDCARDS`) that WS8b's
  grammar scopes and `sourceExpressions.ts` both read rather than re-spelling,
  and `OBJPATH`, the one `${...}` name no plan declares. Table 4's rows resolve
  their metric names through `BUILTIN_METRIC_DECLARATIONS` (`table4Row`) instead
  of hand-writing them a second time, and `SnpsAvg` joins a row by testing that
  row against `SnpsAvg`'s own `members` — the link matters because a name that
  silently fell out of `TABLE_4_METRICS` would make the compatibility check stop
  firing rather than fail, which no test would catch. `SOURCE_MASK_WORDS` is
  derived from the mask-bearing keywords for the same reason.
- `src/core/textLines.ts` — `getLines(document)` only. Retained for callers that still
  want a plain `string[]`; core modules work off `PlanDocument`/`SourceText` instead.
- `src/core/tokenizer.ts` — `SourceText` (line starts, `positionAt`/`offsetAt`, `span`,
  `lineRange`/`lineEnd`/`lineText`) and `tokenize()`, which produces identifier/number/
  string/comment/punctuation tokens plus unterminated-string/comment diagnostics. Also
  `covers(span, offset)` (the inclusive-at-both-ends hit test hover and metric-reference
  lookup share) and `numberKind(text)` (the `percent`/`real`/`integer` spelling rule that
  `values.ts` and `goals.ts` both classify literals with).
- `src/core/parser.ts` / `src/core/planModel.ts` — `parseDocument(text)` builds the
  `PlanDocument` (nodes, diagnostics, folding ranges) that every provider reads. This
  replaced the old regex `maskLine()`/`analyzeBlocks()` block scanner, which is gone.
  Two predicates on `PlanDocument` exist so that the rules they state have one
  definition each. `checkable(node)` is the exemption every semantic pass shares
  — a node the parser recovered from (`incomplete`) or one inside a modifier
  block — so WS7, which makes modifier blocks checkable, changes one predicate
  instead of hunting five hand-written copies. `maskAt(offset)` answers
  `'comment' | 'string' | 'source-string' | undefined`: text the model has no
  structure for, *and which kind*, since WS4 made "inside a string literal" no
  longer mean "nothing to say". Providers dispatch on the kind; `maskedAt` stays
  as the boolean derived from it. Both `maskAt` and `sourceStringAt` find the
  token by binary search (`tokenIndexAt`) and consult the node tree only once a
  string is actually in hand — the linear `nodeAt` scan must not run on every
  keystroke just to discover the caret is not in a literal.
- `src/core/declarations.ts` — `buildDeclarations(model)` and `scopeAt(model, offset)`:
  the per-plan name table (attributes, annotations and metrics in one namespace),
  built-ins first, user declarations shadowing them. `lookup`/`metricIn`/`fieldsOf` are
  the accessors over a `Scope`; `metricIn` is also the classifier that tells a goal
  override from an attribute assignment, so hover and both diagnostic passes ask it
  rather than re-testing `kind`. `Declaration.metric` (aggregator,
  goal text, `aggregate` weights) is WS3's addition, filled from
  `BUILTIN_METRIC_DECLARATIONS` or from the declaration's own child statements. Reached through
  `model.declarations`, which memoizes it per parse — completion and hover need it on
  requests that never run diagnostics. It imports `planModel` **types only**, so the
  `planModel → declarations → planModel` cycle never exists at runtime; keep it that way.
- `src/core/values.ts` — `literal(run)` classifies an attribute/annotation value run
  (`integer`/`real`/`percent`/`string`/`identifier`/`expression`/`empty`, leading `-`
  handled), and `checkValue(declaration, run)` types it. Anything classified
  `expression` — `${...}` interpolation, goal-shaped comparisons — is deliberately never
  checked, so unmodelled forms can't produce false positives; neither is `set`, whose
  literal shape the spec never describes.
- `src/core/resolver.ts` — `resolveDeclaration(model, chain, declaration, …)` is the one
  inheritance walk: default → subplan parameter → last assignment in each scope → context
  overrides. `resolveValues` maps it over a feature's attributes and annotations (sharing
  one per-scope assignment table), and `metrics.ts`'s `resolveGoal` calls it for a single
  metric — so goals gain WS5's `parameters` and WS7's `overrides` for free. Attributes and
  metric goals inherit down the scope chain, annotations don't; a metric's "default" is its
  own `goal = ...`, and its assignments keep their raw source slice so an expression reads
  back as written. `ResolutionContext` (`instancePath`/`parameters`/`overrides`) is the seam
  WS5 and WS7 fill in. `until` branches are transparent to scope lookup, since which branch
  is live is WS7's question. Also the two path/name rules that are resolution
  rather than presentation. `objectPath(model, node, context)` is what
  `${objpath}` expands to — plan, feature path, measure — and prefixes
  `context.instancePath`, so a WS5 subplan instance gets the right path from the
  seam instead of from a second walk of the local node tree. And one rule for
  what a `${name}` in a source string may name: attributes and annotations plus
  the reserved `objpath`, **never a metric**, since interpolation substitutes a
  *value* and a metric carries a goal instead. Three shapes of the same rule —
  `interpolates(scope, name)` for the diagnostic ("did it resolve"),
  `resolveInterpolation(model, node, name, context, valuesOf?)` for hover ("to
  what", with a thunk so a string of nothing but `${objpath}` resolves no scope
  at all), `interpolationTargets(scope)` for completion ("what could it"). They
  used to be three different rules, and `${Line}` was accepted by the checker,
  called "not declared" by hover, and never offered by completion.
- `src/core/semanticDiagnostics.ts` — `invalid-value` and `unknown-assignment-target`,
  run from `parser.ts` right after `structuralDiagnostics`. Three deliberate exemptions:
  a left-hand side resolving to a metric is a goal override (WS3), and the two
  `model.checkable` states — assignments inside `override`/`filter` address the
  instantiated hierarchy (WS7), and a node with `incomplete: true` already carries a
  syntax diagnostic so no semantic error is stacked on it. (A declaration's own
  default is still typed inside a modifier block, since the declaration is not
  addressing the modified hierarchy; only the assignment branch asks
  `checkable`.)
- `src/core/goals.ts` — `parseGoal(source, tokens, fallback)`, the goal-expression
  parser, plus `walkGoal`. Table 3's precedence, so `!` binds looser than the
  comparisons (`! a == b` is `!(a == b)`) — deliberate, not a bug. `match(...)` and
  `inside {...}` parse into their own node kinds so WS3 can call them unsupported
  instead of a syntax error. The precedence levels (`LOGICAL`/`COMPARISON`/`ADDITIVE`/
  `MULTIPLICATIVE`/`ARITHMETIC`) are exported, because `metricDiagnostics` classifies the
  very operators these levels accept — one table, so an operator added to the grammar
  can't silently lose its operand checks. Imports `tokenizer` only.
- `src/core/metrics.ts` — `goalIdentifierType` (what a goal may name: the metric, a bare
  member, or `metric.member`), `metricReferenceAt`, and `resolveGoal(model, scope,
  declaration, context)` — the goal in force at a feature, which is `resolveDeclaration`
  applied to a metric, so it carries the same `Origin` provenance as any other value.
  Feature-level goal overrides inherit downward like attributes; the chapter says that
  only for the `override` modifier, so WS7 confirms it.
- `src/core/metricDiagnostics.ts` — WS3's pass, run from `parser.ts` after
  `semanticDiagnostics`. Same exemptions as WS2, through `model.checkable`,
  plus one judgement call: arithmetic on a *ratio* metric is a **warning**,
  because the chapter forbids ratio arithmetic in one place and converts a ratio to a
  percentage before goal evaluation in another. The missing-`source` warning stays in
  `parser.ts` where it has always been.
- `src/core/sourceExpressions.ts` — WS4's reader for the inside of a
  `source = "..."` string: `parseSourceExpression(source, token)` returns the keyword
  prefix, the `?`/`*`/`**` wildcards, the `` `r` ``/`` `n` ``/`` `-` `` tags, the regex
  runs and the `${name}` interpolations. Parts carry **decoded** indices, and
  `expression.spanAt(from, to)` is the single decoded→document mapping every
  consumer goes through — the literal is decoded first (`\"` and `\\` only — no
  other escape table is documented, and a regex's own `\.` has to survive), so a
  range still lands correctly inside a string written with backslashes. That
  mapping has a fast path: a literal with nothing to collapse maps by arithmetic
  and stores one integer, and only a literal that actually collapsed a `\"` or
  `\\` builds the per-character offset table. `unescapeLiteralText` is the same
  escape rule applied to a whole string, so hover's interpolated values and the
  decoder cannot disagree. Two rules keep the
  keyword scan honest: a colon ends the keyword words, so `group: instance.cp1` names a
  covergroup called `instance` and not the `group instance` keyword; and `::` is the
  database's scope separator, never a keyword's colon. A leading word that is not one of
  Table 4's keywords yields no keyword and no complaint — a keywordless userdata region
  may contain colons of its own. The tag and wildcard tables are derived from
  `keywords.ts`'s `SOURCE_TAGS`/`SOURCE_WILDCARDS`, so the reader and WS8b's
  grammar scopes cannot drift. Locating one: `sourceLiteral(run)` is the single
  "is this run one source string literal" predicate and `isTerminated(token)` the
  second half of it — named separately because the diagnostics pass and the
  providers want opposite answers on an unterminated literal;
  `sourceLiterals(model, within?)` walks them as a generator (nothing filtered —
  `checkable` and terminated-ness are the caller's rule — and deliberately
  **uncached**, since re-parsing a literal is microseconds), and
  `sourceStringAt(model, offset)` is the offset lookup hover and completion share.
  Imports `keywords` and `tokenizer` plus `planModel` **types only**, so it stays
  free of any runtime dependency on the model.
- `src/core/extendedRegex.ts` — the hand-written POSIX ERE check, split out of
  `sourceExpressions.ts` because it is pure string functions over a pattern with
  no reference to a document, a token or a model: `checkExtendedRegex(pattern)`
  and `firstUnescapedDot(pattern)`. **Not** `RegExp` — the two flavours disagree
  in both directions (`{` alone, `\d`, lookahead, `[[:alpha:]]`), so only what
  both call malformed is reported. A `RegexProblem` carries a message and an
  index and no width: every construct it finds is one character, and the caller
  renders a one-column span there.
- `src/core/sourceDiagnostics.ts` — WS4's pass, run from `parser.ts` after
  `metricDiagnostics`. Same exemptions as WS2/WS3, through `model.checkable`, asked
  of the measure and of the `source` statement alike, plus a deliberately narrow
  gate on each check: Table 4 compatibility
  (`incompatible-source-keyword`) applies only when *every* metric the measure names is
  a built-in the table describes and none of them accepts the keyword — `test`, a
  declared metric or a redeclared `Line` silences it, since their source format is
  undocumented; a regex run that an interpolation appears in is not checked at all,
  because the substituted value could supply any part of it. Two judgement calls: the
  keyword mismatch is a **warning**, since Table 4's column is headed "Available
  Metrics" and reads as guidance rather than as a rule the tool is stated to enforce;
  and the wildcard hint needs three sibling strings, not two, since the chapter's own
  motivation for it is cutting the number of strings the tool match-tests. That hint is
  the one new diagnostic WS4 adds to `mipi_dphy.hvp` (line 909, 12 strings differing
  only in their last segment) — a true positive, and the only one on that file.
- `src/core/hover.ts` — `provideHover(model, position, uri?, context?)` for feature/plan
  names, assignment left-hand sides and declaration names. The `uri` is optional on
  purpose: with one, every origin in the value table becomes a `[label](uri#Lline,char)`
  link; without one it stays plain text, so core never assumes a file-backed document.
  A `source` string is answered from inside the same
  `sourceLines ?? featureLines ?? assignmentLines ?? metricReference ?? declaration`
  chain as everything else: the guard dispatches on `model.maskAt(offset)` and only
  `'comment'`/`'string'` are holes, so nothing has to be remembered about ordering.
  It shows the string as the tool expands it, with `${name}` and `${objpath}` both
  resolved through `resolver.ts`'s one interpolation rule. A name that resolves to
  nothing is left as written rather than substituted away, so the diagnostic stays
  visible. `markdownTable(headers, rows)` is the table scaffolding; `valueTable` is
  that plus the `EffectiveValue` row mapper.
- `src/core/symbols.ts` — `provideDocumentSymbols(model)`. LSP `DocumentSymbol` needs an
  explicit `selectionRange` (set equal to the declaration range) that vscode's
  constructor didn't require.
- `src/core/completion.ts` — `provideCompletionItems(model, position)`. The cursor's
  mask kind is asked once (`model.maskAt`) and dispatched on, rather than running a
  source branch in front of a boolean guard: inside a `source` literal it offers
  the Table 4 keyword prefixes at the head of the string (only while what has been typed
  is still the start of one, so `"a b"` and any hierarchy path stay empty as before) and
  attribute/annotation/`objpath` names inside `${`. Cursor context otherwise
  comes from the model (`maskedAt`/`blocksAt`); the line text is read off
  `model.source.lineText(...)`, so no per-request full-document split. Model caching
  lives in `server.ts`, not this module. Items carry `textEdit: TextEdit.replace(range,
  text)` instead of vscode's `item.range` field. Block-opener items (`plan`, `feature`,
  `metric`, …) set `insertTextFormat: InsertTextFormat.Snippet` and their
  `insertText`/`textEdit` body is `BLOCK_SNIPPET_BODY[kind]` from `keywords.ts`
  (tabstops and all), not a plain `"feature "` string. The `inTypePosition`/
  `inAggregatorValuePosition` regexes only see the current line, which is a pre-WS0
  leftover; `assignmentTargetAt()` (enum members) and `metricReferencePosition()` (metric
  lists) read the token stream backwards through the shared `tokenBefore()` instead, so a
  newline or a comment between `=` and the cursor doesn't matter. Prefer that shape for
  anything new. `inMetricPosition` deliberately keeps both: the token scan sees past a
  comma or a line break, but stops at the trailing `.` of a half-typed dotted name
  (`measure test.`), which only the line regex catches.
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
`node --test out/test/*.test.js`. The glob is deliberate: a bare `out/test/` directory
argument does not resolve under Node 26. Picked over vitest/jest to avoid adding dependencies for what is,
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
- `test/metrics.test.ts` — WS3: built-in metric metadata, declaration/aggregator
  compatibility, aggregate members and weights, goal-expression precedence and
  identifier/operand rules, feature-level goal overrides, measure metric references,
  `resolveGoal` inheritance, the metric hover and metric completion.
- `test/sourceExpressions.test.ts` — WS4: keyword-prefix parsing (including the two
  spellings of the `'h###` mask and the `group: instance.cp1` trap), wildcard/tag/regex
  part splitting, document ranges across a literal's escapes (via `spanAt`), the
  hand-written ERE check in `extendedRegex.ts`, all six diagnostic codes with their
  silencing cases, source-string completion and the expansion hover. Also pins Table
  4's derivation from `BUILTIN_METRIC_DECLARATIONS` — the one check in this file that
  exists because its absence would fail *open*.
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

`npm test` (`tsc -p ./ && node --test out/test/*.test.js`) runs all of the above. Because `tsc`
doesn't copy non-`.ts` assets into `out/`, tests resolve fixture/golden/fixture paths
from `process.cwd()` (assumed to be the package root, true whenever run via `npm test`),
not `__dirname`.

## Publishing

`npm publish` has not been run yet — it needs npm account auth and is a real
public-registry action. `package.json` has publish-prep fields filled in (`files`
allowlist, `bin`, `main`/`types`, `repository`/`keywords`, `author`, version bumped to
`0.1.0`) and a `prepublishOnly` script that rebuilds `out/`/`generated/` before packing
— `npm login` then `npm publish` is all that's left.

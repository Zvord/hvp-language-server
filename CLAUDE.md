# hvp-language-server — developer map

Full HVP language spec: `../hvp-documentation/Using the HVP Language.md`.

`src/core/*` is a behaviour-identical, editor-agnostic port of the analysis logic that
used to live directly inside `vscode-hvp`; `src/server.ts` wires it up to a real LSP
connection; `tools/gen-grammars.ts` generates both client syntax grammars from
`src/core/keywords.ts`.

## Architecture

- `src/core/keywords.ts` — pure data, no `vscode` dependency. `RESERVED_WORDS` and
  `isValidIdentifier` also live here: `structuralDiagnostics` reports a declaration
  that breaks the rule and `navigation`'s rename refuses a new name that would, and
  a rename onto `plan` would otherwise write a file that no longer parses. This is the source of
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
  Three predicates on `PlanDocument` exist so that the rules they state have one
  definition each. `overridePath(node)` is WS7's: the hierarchy path a modifier
  statement addresses — a dotted assignment target inside an `override`/`filter`
  block, or one in a file with no plan of its own — with a declaration lookup as
  the guard that keeps `test.expected = 5;` an assignment to the one built-in
  whose *name* has a dot in it. `checkable(node)` is the exemption every semantic
  pass shares, and WS7 narrowed it: it used to be "recovered, or anywhere inside
  a modifier block", because nothing could resolve a path; it is now "recovered,
  or an `overridePath`, or a non-assignment inside a modifier block" — so a
  `subplan` written in an `override` still instantiates nothing and a `measure`
  there still describes no measure here, while `override o; Priority = 5;
  endoverride` inside a plan is typed by WS2 like any other assignment. Four
  passes and `navigation.ts` read those two rather than re-deriving them.
  `maskAt(offset)` answers
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
  back as written. `ResolutionContext` (`instancePath`/`parameters`/`overrides`/`branchIsLive`) is
  the seam WS5 and WS7 fill in — WS5 fills the first two from `workspace.ts`'s
  `contextOf`, WS7 the last two from `modifiers.ts`, and the resolver itself did
  not change to accept them. One
  ordering there is a settled reading, not an accident: a subplan parameter
  stands where the *declaration default* stood, so an assignment written inside
  the plan still wins over it. The chapter gives a parameter the job of filling
  in a declared placeholder (`attribute string root_mod = "";` instantiated as
  `#(root_mod="top.")`) and reserves the language of overriding an assignment
  for the `override` modifier, which it applies after the hierarchy is loaded. `until` branches are transparent to scope lookup unless the caller
  supplies `branchIsLive`, and that is WS7's answer to the question WS0 left
  open: **a bare assignment in an `until` branch means exactly what the same
  assignment would mean written where the `until` is** — a scope assignment
  inside a plan or feature, an override statement in a modifier file — and
  applies only while its branch is the live one. A predicate rather than a date,
  so the resolver keeps no calendar; with none (the default, and the preview is
  off by default) every branch stays transparent and the last one written wins,
  exactly as before WS7. Also the two path/name rules that are resolution
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
  `model.checkable` states — an override *path* addresses the instantiated
  hierarchy, which `modifierDiagnostics` types instead (WS7), and a node with
  `incomplete: true` already carries a
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
  Feature-level goal overrides inherit downward like attributes. The chapter states
  propagation only for the `override` modifier, and WS5 settled the rest from the
  sentence "override the goal of a specific metric in a feature **or a plan**": a
  plan holds no measures, so a plan-level goal override that did not reach the
  features below it could never affect anything.
- `src/core/metricDiagnostics.ts` — WS3's pass, run from `parser.ts` after
  `semanticDiagnostics`. `checkGoal` is exported for WS7, so a goal expression
  written in a modifier file is held to the same grammar and gets the same
  messages as one written in the plan. Same exemptions as WS2, through `model.checkable`,
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
- `src/core/workspace.ts` — WS5's index and the instantiated hierarchy, and the
  answer to the open question the gaps document left: the chapter describes a
  *set* of plan files handed to the tool (`-plan`/`-mod`), with no include
  directive, so a plan name is global across that set and is never tied to a
  file name — the editor approximates the set with the workspace and indexes
  every `.hvp` file in it. `WorkspaceIndex` (`plans(name)`, `allPlans()`,
  `documents()`, `document(uri)`, `instances()`) is the interface WS6 and WS7
  code against; `buildIndex(documents)` is the only implementation core ships,
  over models the caller already holds, which is why a test can build a
  four-file workspace out of strings. `instances()` is the hierarchy: one
  `PlanInstance` per instantiation with its own `parameters` and `path`, so the
  chapter's feature-groups example — the same subplan instantiated four times —
  is four instances rather than one plan read four ways, and `contextOf` turns
  one into the `ResolutionContext` WS2 already took. Two walks, deliberately
  different: `instantiate` stops at a plan already on its **ancestor stack**, so
  a hierarchy that reaches a cycle is still built down to the point where it
  closes, while `cyclicSubplans` works over the plan-name graph by reachability,
  because a cycle need not hang under any top-level plan — two plans that only
  instantiate each other are a cycle no hierarchy walk would ever reach.
  Imports `declarations`/`resolver` and `planModel`, and nothing that reads a
  file: `node:fs` lives in `src/workspaceFiles.ts`.
- `src/core/workspaceDiagnostics.ts` — WS5's pass, and the one diagnostic pass
  `parser.ts` does **not** run: it needs the index, which moves on a different
  clock than a per-version parse, and running it there would put the workspace
  scan on the hot path. `workspaceDiagnostics(model, uri, index)` returns the
  document's *complete* list — the parse's own plus `unknown-plan`,
  `unknown-parameter`, `invalid-parameter-value` and `subplan-cycle` — so the
  server has one call and one array. Three false-positive rules shape it. It
  returns the parse's diagnostics untouched when the index has not reached this
  document yet, since a half-built index calls every plan name unknown. A plan
  name the workspace declares twice is reported only when *no* candidate accepts
  a parameter, and typed only when there is exactly one candidate. And the
  top-level plan rule is extended only in the suppressing direction: WS1's
  `unreferenced-plan` is dropped when another file instantiates the plan, but
  several unreferenced plans across a workspace are *not* reported, because a
  workspace routinely holds several unrelated plan sets and each one's top-level
  plan is correct. WS7 rides here too (see `modifierDiagnostics.ts`), and
  `workspaceDiagnostics(model, uri, index, { now })` grew the options object for
  it: the `now` is injected so nothing in core reads a clock.
- `src/core/modifiers.ts` — WS7's reader for all three modifiers, because they
  only mean anything together: an `override` statement addresses the
  *instantiated* hierarchy by path, a `filter` decides which features survive,
  and an `until` block says which of the two is live today. `src/core` owns **no
  clock**: `ModifierSettings.now` and `ModifierWorkspaceOptions.now` are both
  required, and `server.ts`'s `today()` is the one place the wall clock is read
  (the configured evaluation date when there is one, so the expired-branch
  warnings and the preview cannot contradict each other). A check whose answer
  changes at midnight must never be baked into a parse the editor caches by
  document version. One idea underneath:
  a statement is resolved **once** to the set of hierarchy scopes it names
  (`resolveOverride` against `scopeUniverse(index)` — every plan instance plus
  every feature in it, memoized in a `WeakMap` keyed by the index, so it expires
  when `WorkspaceFiles.invalidate` replaces the index and never has to be told
  to), and every consumer reads that resolution instead of re-matching paths.
  `pathMatcher` is Table 5 compiled to a regex over a dotted path — `?` is
  `[^.]`, `*` is `[^.]*`, `**` is `[^]*`, so only `**` crosses a `.` — with two
  anchorings: `matches` (the whole path, which is all an *annotation* override
  reaches, since the chapter's one stated exception to propagation is that
  annotation values are not passed down) and `covers` (the path or any ancestor,
  which is what an attribute or a metric goal reaches). That pair is the whole
  of the ordered-application rule: statements are collected in `model.nodes`
  order, which is document order, every matching one is handed to
  `resolveDeclaration` in that order, and last-wins does the rest — so the
  chapter's worked example (`topplan.subplan1.mem.owner` then
  `topplan.subplan1.owner`) yields Second Owner everywhere including `.mem`
  without a propagation pass of its own. A statement with no path
  (`override o; Priority = 5; endoverride` written inside a plan) resolves to
  every instance of that plan; the BNF does not spell that shape, but WS0
  accepts modifier blocks nested in a plan and so must this. `parseDate` is
  **MM-DD-YYYY** — the BNF says only `INT "-" INT "-" INT`, and the chapter's own
  `elseuntil 04-30-2014;` settles it, since there is no thirtieth month; an
  out-of-range value is reported rather than re-read as `DD-MM`, because the two
  orders disagree on exactly the dates a typo produces. `liveBranch` reads a
  dated branch as live while its day has not passed (the example's "applied
  before 1/31/2014" followed by "between 2/1/2014 - 4/30/2014" makes the named
  day belong to the branch that names it). The filter evaluator reuses
  `goals.ts`'s parser — a filter expression is the same grammar, which is also
  why `inside {...}` and `match(...)` arrive as their own node kinds ready to be
  called unsupported — and returns `undefined` for anything it cannot model,
  which every caller reads as "change nothing". `evaluateModifiers` returns
  **undefined** unless a file is configured: the preview is off by default, and
  applying a modifier nobody asked for would silently change every value the
  editor reports. Imports `workspace` **types only**.
- `src/core/modifierDiagnostics.ts` — WS7's two passes, split by what they need.
  `modifierDiagnostics(model)` is document-local (date spelling, branch order and
  reachability, filter expressions, a wildcard in the *name* an override sets)
  and runs from `parser.ts` beside WS1–WS4. `modifierWorkspaceDiagnostics` needs
  the hierarchy to say whether a path resolves and the calendar to say whether a
  branch has expired, so it runs from `workspaceDiagnostics` — the same reason
  `unknown-plan` lives there, plus one more: a check whose answer changes at
  midnight must not be baked into a parse the editor caches by document version.
  Everything the workspace half reports is a **warning**, deliberately: a
  modifier file is handed to the tool alongside the plan files it modifies and
  the editor only approximates that set with the workspace, so a path that
  resolves to nothing may well be correct against a plan set this window has
  never opened; the pass also says nothing at all until something is
  instantiated. The value an override assigns *is* type-checked once its path
  found a declaration — through `checkValue`, or through `metricDiagnostics`'s
  `checkGoal` for a metric — which is the check the old blanket exemption made
  impossible. Two silences are as deliberate as the checks: a filter block in a
  modifier file names attributes of a plan nothing in the file states, so its
  identifiers are not checked at all; and `!` is not reported as an unsupported
  operator, since the chapter's list is introduced with "you can *also* include
  the following operators" and reads as an addition rather than a closed set.
- `src/core/hover.ts` — `provideHover(model, position, { uri?, context?, index? })` for
  feature/plan names, assignment left-hand sides, `subplan` statements and
  declaration names. With an index, the values shown are the ones the instance
  under the cursor receives, and a `subplan` hover resolves its table in the
  *target* plan's document, so those origins link into the file that declares
  the attribute rather than the file that sets it. A plan instantiated more than
  once has no one instance under the cursor — the file is written once and read
  four ways — so the table stays parameter-free and a line says how many
  instances there are instead of picking one. The `uri` is optional on
  purpose: with one, every origin in the value table becomes a `[label](uri#Lline,char)`
  link; without one it stays plain text, so core never assumes a file-backed document. The trailing three are an
  options bag rather than positional parameters: WS5 added `index` and WS7 adds
  overrides, and callers were already passing `{}` placeholders.
  A `source` string is answered from inside the same
  `sourceLines ?? featureLines ?? assignmentLines ?? metricReference ?? declaration`
  chain as everything else: the guard dispatches on `model.maskAt(offset)` and only
  `'comment'`/`'string'` are holes, so nothing has to be remembered about ordering.
  It shows the string as the tool expands it, with `${name}` and `${objpath}` both
  resolved through `resolver.ts`'s one interpolation rule. A name that resolves to
  nothing is left as written rather than substituted away, so the diagnostic stays
  visible. `markdownTable(headers, rows)` is the table scaffolding; `valueTable` is
  that plus the `EffectiveValue` row mapper.
- `src/core/symbols.ts` — `provideDocumentSymbols(model)` and
  `provideWorkspaceSymbols(index, query)`. WS6 replaced the feature-only outline
  with the whole node tree: plans, attributes, annotations, metrics, features,
  subplans, measures, `override`/`filter`, and `until` with its three branches
  under it. **The trap:** LSP `DocumentSymbol` needs an explicit
  `selectionRange` that vscode's own constructor derived, it must sit inside
  `range`, and a child's `range` must sit inside its parent's — a client drops
  or mis-nests a symbol that breaks either, silently. `contain()` is the first
  guard; the second is `blockRange`, which ends an **unclosed** block at
  `node.range.end.line` rather than at its opening line, because collapsing it
  put its own children outside it (the pre-WS6 outline had that bug too, and
  `test/golden/symbols.json` recorded it). A closed block keeps the exact
  pre-WS6 range rule — whole lines when it owns them, its own span when it
  shares a line — so every feature in the golden file kept its range and only
  gained a parent. Detail lines carry what the name cannot: the declared type, a
  measure's metric list, a subplan's parameters. Workspace symbols match by
  case-insensitive subsequence (`mpl` finds `my_plan`), name the enclosing plan
  as `containerName` since the same attribute name in two plans is two
  declarations, and cap at 1000 — `mipi_dphy.hvp` alone yields 935.
- `src/core/navigation.ts` — WS6's definition, references and rename.
  One idea underneath all three: `targetAt(model, offset, options)` resolves a
  position to a *target* (a declaration, a plan, or an enum member) and
  `findOccurrences(target, model, options)` resolves a target to the ranges that
  mean it; `provideDefinition` takes the declaring ones, `provideReferences`
  takes all of them, `provideRenameEdits` rewrites them. Three providers over
  one search, so they cannot disagree about what an occurrence is.
  The search is **closed, not textual**: a name declared in plan `P` means
  something only inside `P`'s own blocks, in a `#(name=...)` parameter on a
  `subplan P`, and at the end of an override path resolving to `P` — every
  candidate is asked which plan it belongs to (`planNameOf`) instead of being
  matched by spelling, since the same word in another plan is another
  declaration. What counts as an override path is not spelled here any more:
  WS7 moved it to `model.overridePath(node)`, which navigation, `checkable` and
  the modifier passes all read, so "is this a path or a name" has one
  definition. `pathPlanName` is how an override path finds its plan: longest
  prefix match against `index.instances()`, so `topplan.subplan1.mem.owner`
  lands in whatever `subplan1` instantiates, falling back to the first segment,
  the only part the BNF guarantees is a plan name. `${name}` occurrences come
  from WS4's parsed interpolations (real ranges through `spanAt`), never from
  re-scanning the literal; goal-expression mentions come from `goals.ts`'s
  parse, and a range is produced only for the leading identifier or a trailing
  `.member` whose text is verified against the document, because `parseGoal`
  joins a dotted name and the whitespace inside it is not recoverable.
  **Rename is all-or-nothing.** `OccurrenceSet.problems` collects, during the
  same walk, everything a rename would have to touch but the model cannot
  attribute — a filter expression (`remove feature where phase > 2`) which names
  an attribute with no plan in front of it, an override path whose plan cannot
  be pinned down or whose wildcard could also match another plan declaring the
  name, a statement the parser recovered from, an unterminated `source` literal,
  a plain string spelling `${name}` — and any one of them refuses the whole
  rename. Refused outright as well: built-ins, plan names, enum members,
  declarations outside any plan, a plan declared in two files, a name declared
  twice in one plan, an invalid or already-taken new name, and — following the
  server's gate — a request made before the workspace index is available. A
  half-renamed file still parses and still means something, just not what it
  used to, and no diagnostic points at the half left behind. Refusals are
  returned (`{ error }`), not thrown: core has no LSP error type, and
  `server.ts` turns one into a `ResponseError`. `prepareRename` runs the same
  checks so the editor rejects the position before the user types.
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
- `src/workspaceFiles.ts` — the other half of WS5, and the only module outside
  `tools/` that touches `node:fs`. It walks the `initialize` folders once
  (asynchronously — `initialize` answers immediately), parses every `.hvp` file
  it finds, and lays the editor's open documents over the copies on disk so an
  unsaved edit is visible to every other file in the plan set. A client with no
  workspace folder still gets the directory the opened document sits in, and
  only that directory — a single file opened from a home directory must not turn
  into a recursive scan of it. `ready()` is the gate the server publishes
  through: until every scan asked for has finished, a document is linted with
  its own diagnostics only, because a half-built index would put an error on a
  file that is correct and then take it back. Caps (2000 files, 8 MB each, depth
  12, `.git`/`node_modules`/`out`/`dist`/`build` skipped) keep the scan off a
  workspace it has no business walking.
- `src/server.ts` — the LSP connection. `createConnection(ProposedFeatures.all)` +
  `TextDocuments(TextDocument)`; capabilities: incremental sync, `completionProvider:
  { triggerCharacters: ['.'] }`, `documentSymbolProvider: true`, `foldingRangeProvider:
  true`, `hoverProvider: true`, and WS6's `definitionProvider`,
  `referencesProvider`, `renameProvider: { prepareProvider: true }` and
  `workspaceSymbolProvider`. `navigationOptions(uri)` is the one place the index
  is handed to a navigation request, and it withholds it until
  `workspace.ready()` for the same reason the diagnostics and the hover do — a
  half-built index has not seen the file declaring the plan a `subplan` names,
  so definition would answer "nowhere", references with half the workspace, and
  rename refuses outright rather than rewriting a fraction of the occurrences.
  A rename refusal becomes `ResponseError(ErrorCodes.InvalidRequest, message)`
  so the editor shows the sentence; `prepareRename` returning `null` is the
  different thing — "no name here" — which the editor phrases itself. Registers `workspace/didChangeWatchedFiles` for `**/*.hvp` when the client
  supports dynamic registration, so a plan file changed by a rebase or another tool
  re-enters the index; a change anywhere in the plan set re-lints every open
  document through the same debounce, since one file's plan names decide another
  file's diagnostics. `modelFor` invalidates the index rather than rebuilding it,
  and rebuilding is a name-table pass over models that are already parsed —
  nothing is re-read or re-parsed on an edit.
  WS7's preview is configured rather than inferred, and off by default:
  `hvp.modifiers.files` is the `-mod` argument list the chapter describes, which
  the editor has no other way of knowing (a modifier file is an ordinary `.hvp`
  file, and nothing inside one says which plan set it belongs to or whether the
  user wants it applied), and `hvp.modifiers.date` stands in for the day the
  tool would be run on. Both are read through `workspace/configuration` when the
  client advertises it, re-read on `didChangeConfiguration`, and a change
  re-lints the whole plan set, since the preview decides what every hover
  reports. `modifiers()` caches the evaluation against the index object and the
  settings object, so resolving a path — a walk of every scope in the workspace
  — happens when one of those two moves and never on a hover or a completion.
  The configured date is also what the `expired-until-branch` warnings are read
  against, so the diagnostics and the preview cannot contradict each other.
  Debounces linting 300ms — `modelCache: Map<uri, {version, PlanDocument}>` and
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
  WS8b adds five region rules on top, and they too are token-for-token
  `keywords.ts`: `source-statement`/`source-string` scope the inside of a
  `source = "..."` literal — the Table 4 prefix (`SOURCE_KEYWORDS`, both `'h###`
  mask spellings, `SOURCE_MASK_WORDS`) as `keyword.other.source.hvp` with the
  mask value as `constant.numeric.hex.hvp`, `SOURCE_TAGS` as
  `keyword.other.tag.hvp`, `SOURCE_WILDCARDS` as `keyword.operator.wildcard.hvp`
  — plus `enum-members` (`variable.other.enummember.hvp`), `aggregate-members`
  (members as `entity.name.type.hvp`, `weight` as the field scope it already is)
  and `subplan-parameters` (`variable.parameter.hvp`). The source string is found
  through its **statement**, not by recognising a keyword prefix, so a keywordless
  `source = "top.cpu.*"` still gets its wildcards; that also puts
  `#source-statement`/`#strings` ahead of `#subplan-parameters` in the include
  list, which is what keeps the `#(10)` inside `..._cg#(10)::cg...` from reading
  as a parameter list. `:(?!:)` is the `::` rule the reader states in prose:
  the database's scope separator is never a keyword's colon. Two spellings of
  the mask word are emitted rather than an `(?i:...)` group — both engines are
  Oniguruma and would take it, but nothing that can *test* a generated pattern
  does. Non-keyword-driven sections (comments, strings, numbers, operators) are
  static templates; `declaration-name` selects *which* openers take a name here
  but reads their spelling from `BLOCK_OPEN_KEYWORD`. **Ordering trap:** every
  alternation is sorted longest-first (`longestFirst()`) before joining, so a
  dotted name's prefix (`test`) never wins over the full name
  (`test.percent.pass`), `group instance bin` over `group instance` over `group`,
  and `**` over `*` — see `test/genGrammars.test.ts` for regression tests on all
  three. A second ordering matters too: `INCLUDE_ORDER` is the top-level rule
  sequence, written once and mapped into both emitters, because
  `#source-statement` must precede `#strings` (a source string is its own little
  language and the plain string rule would swallow it first) and both must
  precede `#subplan-parameters` (so the `#(` in `..._cg#(10)::cg...` is never
  reached). Two hand-kept copies of that sequence is exactly the drift this
  generator exists to kill. Run via `npm run gen-grammars`; output isn't committed (see `.gitignore`)
  since it's fully derived and reproducible — client repos check in their own copy
  (`vscode-hvp/syntaxes/hvp.tmLanguage.json` is the one that ships, and
  `test/genGrammars.test.ts` compares against it, so re-copy it after every run).
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
  at test time. `symbols.json` was regenerated once, for WS6: the outline it
  pinned was the deliverable being replaced. Every feature entry kept its exact
  range and gained a `plan` parent; the one real change beyond the new kinds is
  that an unclosed block now spans what the parser recovered into it instead of
  its opening line alone (see `symbols.ts`). Completion scenario → source document mapping (`valid-blocks.hvp` vs.
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
  from shadowing `test.percent.pass`/`test.pass` (and `group` from shadowing
  `group instance bin`, and `*` from shadowing `**`), and the CLI (`node
  out/tools/gen-grammars.js`) writes parseable JSON/sublime-syntax files. WS8b's
  source-string rules are checked by replaying the pattern *list* the way a
  TextMate engine would (`scanSourceString`: leftmost match wins, ties by listed
  order), since a source string is one rule list rather than one alternation per
  scope — that is what pins the `::` trap, both mask spellings, and the escape
  rule beating the wildcard rule on `\*`. The two output formats are tied
  together by un-escaping the sublime file's YAML single-quoted scalars and
  requiring each one to read back byte-identical to the tmLanguage pattern.
- `test/workspace.test.ts` — WS5: multi-file subplan resolution, parameter names and
  types, the chapter's feature-groups example instantiated four times (each instance's
  values and object paths), cycles (direct, mutual with no root above them, and one
  deeper than the plan that reaches it), the top-level plan rule across files, the
  subplan and feature hovers, and the index queries WS6/WS7 will call. Every workspace
  in it is built from strings through `buildIndex`, so nothing in this file touches
  disk.
- `test/navigation.test.ts` — WS6: the outline across every block and
  declaration kind (with the `selectionRange`/parent-containment invariant
  checked on recovered text too), workspace-symbol matching, cross-file
  definition and references from a `subplan`, an override path, a `#(...)`
  parameter and a `${...}` interpolation, the same name in two plans staying two
  names, rename across files including the interpolation and the override path,
  and one case per refusal rule. Every workspace is built from strings through
  `buildIndex`, like `workspace.test.ts`, so nothing here touches disk.
- `test/modifiers.test.ts` — WS7: Table 5's wildcards (including the two the
  literal reading settles — `*` does not cross a `.`, and `top.**` does not
  match `top` itself), path resolution against the instantiated hierarchy and
  each of the three ways a path fails, the chapter's ordered-application example
  verbatim and the same two statements written the other way round, annotation-
  vs-attribute-vs-metric propagation, an override beating an assignment written
  in the plan, filter typing and the two unsupported forms, `remove` removing
  and `keep` keeping, date spelling (`31-01-2014` reported rather than re-read),
  branch ordering and reachability, branch selection on either side of a named
  day, what a bare assignment in an `until` branch means with and without an
  evaluation date, the preview being off until it is configured, both hovers,
  path completion, and one case per state of the narrowed `checkable`. Every
  workspace is built from strings through `buildIndex` and **every date is
  injected**, so nothing here touches disk or a clock — the suite must not start
  failing on a calendar day.
- `test/serverSmoke.test.ts` — end-to-end proof that `src/server.ts`'s LSP wiring works,
  not just the core functions in isolation. Spawns the compiled server as a real child
  process over `--stdio` and drives it with a ~100-line hand-rolled JSON-RPC/
  Content-Length client (no LSP client library dependency): `initialize` → capability
  assertions, `didOpen` → `publishDiagnostics` (immediate, no debounce), `completion`/
  `documentSymbol`/`foldingRange` requests, `didClose` → `publishDiagnostics` with `[]`.
  Does not test the 300ms debounce's timing directly (fragile in CI); the debounce logic
  itself is a small, directly-readable block in `server.ts`. A second test proves WS5
  through the same wiring: a real temporary workspace of two files, `initialize` with a
  workspace folder, a `subplan` resolved out of the other file (hover included, linking
  into it), and a third file appearing on disk clearing the `unknown-plan` it had. The
  client keeps a backlog of every `publishDiagnostics` and waits for one that *matches*,
  because WS5 republishes a document when the workspace around it changes — and it drops
  that backlog before the disk change, since the publish from before the scan settled
  would have satisfied the predicate without proving anything. WS6 rides on that
  same two-file workspace: `definition` on the `subplan` lands in the other
  file, `references`/`prepareRename`/`rename` on the `#(root_mod=...)` parameter
  reach the declaration and the `${root_mod}` in `cache.hvp`'s source string,
  a rename of the plan name comes back as a JSON-RPC *error* rather than a
  partial edit, and `workspace/symbol` answers from the settled index.
  WS7 adds a third test, for the one path only the wiring can prove: the client
  answers `workspace/configuration` with a modifier file and an evaluation date,
  and the server's hover then reports the value the override gives a feature
  rather than the one written in the plan, its diagnostics carry the
  `expired-until-branch` the configured date implies, and completion inside the
  override path answers from the hierarchy. Turning the preview back off and
  waiting for the re-lint it triggers puts the plan's own value back — the
  re-lint is the synchronisation point, since it only happens once the new
  settings are in.

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

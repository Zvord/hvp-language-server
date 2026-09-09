/**
 * WS8c: semantic tokens.
 *
 * The TextMate grammar (WS8b) colours what a regular expression can see: the
 * keywords, the built-in field and metric names, the parts of a `source`
 * string. What it cannot see is which *declared* name is which — `phase`,
 * `MyAgg` and `reviewed` are the same word shape, and only the plan's own
 * declaration table says one is an attribute, one a metric and one an enum
 * member. That is exactly what a semantic token carries, and it is why this
 * module answers from `declarations.ts` rather than from the token stream.
 *
 * Two rules shape everything below.
 *
 * **Nothing unresolved is coloured.** A semantic token *overrides* the
 * grammar's guess, so a wrong one is worse than none: an assignment whose
 * target no scope declares, a `${name}` naming nothing, an override path whose
 * plan the workspace cannot pin down all get no token and keep the lexical
 * colour they already had.
 *
 * **One traversal.** An editor asks for the whole document's tokens on
 * essentially every keystroke, so this is the hottest provider in the package.
 * `navigation.ts` already knows where every occurrence of a name is written,
 * but `findOccurrences` answers about one name at a time and re-walks every
 * document to do it; asking it about every declared name in a 2500-line plan
 * would be quadratic. So the walk here is its own single pass over
 * `model.nodes`, and what it reuses from `navigation.ts` is the two pieces of
 * *judgement* that would otherwise be re-derived and could then disagree:
 * `goalNames` (which spellings inside a goal expression can be located in the
 * source at all) and `pathPlanName` (which plan an override path addresses).
 * Everything else comes from `declarations.ts`'s name table, which the parse
 * already memoized.
 *
 * Editor-agnostic like the rest of `src/core`: the legend and the LSP delta
 * encoding live here — they are plain numbers, and the encoding is the part
 * most worth testing directly — while `server.ts` only declares the capability
 * from the same exported legend, so core and server cannot disagree about
 * which index means which colour.
 */
import { Range, SemanticTokensLegend } from 'vscode-languageserver-types';
import { Declaration, DeclarationKind, Scope, declarationFromNode, lookup, metricIn, scopeOf } from './declarations';
import { OBJPATH } from './keywords';
import { goalNames, pathPlanName } from './navigation';
import { WorkspaceIndex } from './workspace';
import { PlanDocument, PlanNode, TokenRun, nameToken, runText } from './planModel';
import { isTerminated, parseSourceExpression, sourceLiteral } from './sourceExpressions';
import { Span } from './tokenizer';
import { literal } from './values';

/**
 * The token types this server emits, in legend order.
 *
 * Standard LSP types throughout, so a theme that knows nothing about HVP still
 * colours a plan file. The mapping is a reading, and each one is deliberate:
 *
 * - `namespace` — a plan. It is the naming scope every declaration lives in and
 *   the thing a `subplan` statement and an override path address.
 * - `type` — a metric, built-in or declared. The grammar already scopes the
 *   built-in metrics as `entity.name.type.hvp`, so this keeps a declared metric
 *   the same colour as `Line` and lets the `defaultLibrary` modifier — not a
 *   different colour — be what separates them.
 * - `parameter` — a `#(name=value)` binding on a `subplan`, which is exactly a
 *   parameter of the plan being instantiated.
 * - `property` — an attribute. A field of the feature it is written in, and one
 *   that propagates down the hierarchy.
 * - `variable` — an annotation. There is no annotation-shaped type in the
 *   standard set (`decorator` is 3.17-only and thinly themed), and the reading
 *   that survives is the one distinction the language itself draws: an
 *   annotation is a local value that is *not* passed down, where an attribute
 *   is a property of the sub-tree.
 * - `enumMember` — a member of an `enum {...}` declaration, wherever it is
 *   written: in the member list, as a value that selects it, or inside a goal.
 */
export const SEMANTIC_TOKEN_TYPES = ['namespace', 'type', 'parameter', 'property', 'variable', 'enumMember'] as const;

/** `declaration` marks the defining occurrence, `defaultLibrary` a built-in —
 * the standard way to say "this name came with the language, not with this
 * plan", and the only thing separating `Line` from a metric a plan declares. */
export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'defaultLibrary'] as const;

export type SemanticTokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];
export type SemanticTokenModifier = (typeof SEMANTIC_TOKEN_MODIFIERS)[number];

/** The legend the server advertises. One table, exported: two hand-kept lists
 * whose order drifted would shift every colour in the file and nothing would
 * report it. */
export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_TYPES],
  tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
};

const TYPE_INDEX: ReadonlyMap<SemanticTokenType, number> =
  new Map(SEMANTIC_TOKEN_TYPES.map((name, index) => [name, index]));
const MODIFIER_BIT: ReadonlyMap<SemanticTokenModifier, number> =
  new Map(SEMANTIC_TOKEN_MODIFIERS.map((name, index) => [name, 1 << index]));

/** What a declared name is coloured as, by the kind the plan declared it with.
 * The three share one namespace (`declarations.ts`), and telling them apart is
 * the whole reason this provider exists. */
const KIND_TYPE: Record<DeclarationKind, SemanticTokenType> = {
  attribute: 'property',
  annotation: 'variable',
  metric: 'type',
};

/** One token, before the delta encoding. Line and character are LSP's — UTF-16
 * code units — and `length` is on one line, which LSP requires. */
export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  type: SemanticTokenType;
  modifiers: readonly SemanticTokenModifier[];
}

export interface SemanticTokensOptions {
  /** The workspace, when the server has one. Without it the cross-file half —
   * a `subplan`'s parameter names, an override path's target — is simply not
   * coloured, rather than guessed at. */
  index?: WorkspaceIndex;
  /** `textDocument/semanticTokens/range`: only tokens intersecting this range
   * are produced, and most of the walk is skipped. */
  range?: Range;
}

const WILDCARD = /[*?]/;

/** Whether a value run selects one of `declaration`'s enum members. */
function selectsMember(declaration: Declaration, run: TokenRun): boolean {
  if (declaration.type !== 'enum' || !declaration.members.length) return false;
  const value = literal(run);
  return value.kind === 'identifier' && declaration.members.includes(value.text);
}

class TokenCollector {
  readonly tokens: SemanticToken[] = [];
  constructor(private readonly from: number, private readonly to: number) {}

  /** True when a span is worth looking inside at all — the range request's one
   * saving, applied at the statement level so a skipped statement costs one
   * comparison rather than a scope lookup and a value classification. */
  intersects(span: Span): boolean {
    return span.end >= this.from && span.start <= this.to;
  }

  push(span: Span, type: SemanticTokenType, ...modifiers: SemanticTokenModifier[]): void {
    if (!this.intersects(span)) return;
    const { start, end } = span.range;
    // LSP has no multi-line token: a name broken across lines (`test\n.expected`)
    // is left to the grammar rather than mis-encoded as a long first line.
    if (start.line !== end.line || end.character <= start.character) return;
    this.tokens.push({ line: start.line, character: start.character,
      length: end.character - start.character, type, modifiers });
  }

  /** A declared name, wherever it is written. */
  declared(span: Span, declaration: Declaration, ...modifiers: SemanticTokenModifier[]): void {
    this.push(span, KIND_TYPE[declaration.kind], ...modifiers,
      ...(declaration.builtin ? ['defaultLibrary' as const] : []));
  }
}

/**
 * Every semantic token in the document, sorted by position.
 *
 * Sorted here rather than in the encoder because the order is part of what a
 * caller sees and the delta encoding below is meaningless without it. The sort
 * is not defensive padding either: a declaration writes its `enum {...}`
 * members and its `aggregate {...}` metrics *before* its own name, so the walk
 * produces out-of-order tokens on the most ordinary input there is.
 */
export function semanticTokens(model: PlanDocument, options: SemanticTokensOptions = {}): SemanticToken[] {
  const { index, range } = options;
  const collector = new TokenCollector(
    range ? model.source.offsetAt(range.start) : 0,
    range ? model.source.offsetAt(range.end) : model.source.text.length);

  /** The plan a name resolves to: the workspace's, or this document's own when
   * there is no index yet (the server withholds one until the scan settles, and
   * a single-file caller never has one). */
  const planOf = (name: string | undefined): { model: PlanDocument; node: PlanNode } | undefined => {
    if (!name) return undefined;
    const entry = index?.plans(name)[0];
    if (entry) return entry;
    const local = model.plans.find(plan => nameToken(plan)?.text === name);
    return local && { model, node: local };
  };

  for (const node of model.nodes) {
    // Everything a node contributes is written inside its own header; its
    // children are separate nodes with headers of their own.
    if (!collector.intersects(node.header)) continue;
    const name = nameToken(node);
    switch (node.kind) {
      case 'plan':
        if (name) collector.push(name, 'namespace', 'declaration');
        break;
      case 'subplan':
        subplanTokens(node, planOf, collector);
        break;
      case 'attribute': case 'annotation': case 'metric':
        declarationTokens(model, node, collector);
        break;
      case 'measure': {
        const scope = scopeOf(model, node);
        for (const reference of node.metrics) {
          const declaration = metricIn(scope, runText(reference));
          if (declaration) collector.declared(reference, declaration);
        }
        break;
      }
      case 'goal': {
        const metric = model.enclosingOf(node, 'metric');
        const scope = scopeOf(model, node);
        const declaration = metric && lookup(scope, nameToken(metric)?.text ?? '');
        if (declaration?.kind === 'metric') {
          goalTokens(model, node.value, node.header, declaration, scope, collector);
        }
        break;
      }
      case 'assignment':
        assignmentTokens(model, node, index, collector);
        break;
      case 'source':
        interpolationTokens(model, node, collector);
        break;
    }
  }
  collector.tokens.sort((a, b) => a.line - b.line || a.character - b.character);
  return collector.tokens;
}

/** A `subplan p #(name=value)` statement: the plan it names, and the parameters
 * it binds — which are that *other* plan's attributes, so they are looked up in
 * its scope and not in this file's. */
function subplanTokens(node: PlanNode & { kind: 'subplan' },
                       planOf: (name?: string) => { model: PlanDocument; node: PlanNode } | undefined,
                       collector: TokenCollector): void {
  const name = nameToken(node);
  const target = planOf(name?.text);
  // A plan name nothing in the workspace declares is left alone: WS5 already
  // reports it, and colouring it as a namespace would assert it resolves.
  if (!target || !name) return;
  collector.push(name, 'namespace');
  if (!node.parameters.length) return;
  const scope = scopeOf(target.model, target.node);
  for (const parameter of node.parameters) {
    const declaration = lookup(scope, runText(parameter.name));
    // Only an attribute can be a parameter (workspace.ts states that rule).
    if (declaration?.kind !== 'attribute') continue;
    collector.push(parameter.name, 'parameter');
    if (selectsMember(declaration, parameter.value)) collector.push(parameter.value, 'enumMember');
  }
}

/** An `attribute`/`annotation`/`metric` declaration: its own name, its enum
 * members, the metrics an `aggregate {...}` names, and a default value that
 * selects one of its members. */
function declarationTokens(model: PlanDocument, node: PlanNode & { kind: DeclarationKind },
                           collector: TokenCollector): void {
  const name = nameToken(node);
  if (name) collector.push(name, KIND_TYPE[node.kind], 'declaration');
  const type = node.type.name?.text;
  if (type === 'enum') {
    for (const member of node.type.members) collector.push(member.name, 'enumMember', 'declaration');
    // The declaration this node *states* — `declarationFromNode` again rather
    // than a second reading of the member list — so a default naming one of its
    // own members is coloured even when a duplicate declaration won the name.
    if (node.kind !== 'metric' && selectsMember(declarationFromNode(node), node.value)) {
      collector.push(node.value, 'enumMember');
    }
    return;
  }
  // An `aggregate {...}` member names another metric, which the scope resolves;
  // an unknown one is WS3's diagnostic and gets no colour here.
  if (type === 'aggregate' && node.kind === 'metric') {
    const scope = scopeOf(model, node);
    for (const member of node.type.members) {
      const declaration = metricIn(scope, runText(member.name));
      if (declaration) collector.declared(member.name, declaration);
    }
  }
}

/**
 * An assignment: `name = value` inside a plan, or `plan.feature.name = value`
 * inside a modifier block.
 *
 * The two are told apart by `model.overridePath` — WS7's one definition of that
 * question, which `checkable` and the modifier passes read too.
 */
function assignmentTokens(model: PlanDocument, node: PlanNode & { kind: 'assignment' },
                          index: WorkspaceIndex | undefined, collector: TokenCollector): void {
  if (model.overridePath(node)) return overridePathTokens(model, node, index, collector);
  const scope = scopeOf(model, node);
  const declaration = lookup(scope, runText(node.target));
  if (!declaration) return;
  collector.declared(node.target, declaration);
  valueTokens(model, node, declaration, scope, collector);
}

/** The right-hand side: a goal expression when the target is a metric, an enum
 * member when it selects one, and nothing otherwise. */
function valueTokens(model: PlanDocument, node: PlanNode & { kind: 'assignment' }, declaration: Declaration,
                     scope: Scope, collector: TokenCollector): void {
  if (declaration.kind === 'metric') goalTokens(model, node.value, node.header, declaration, scope, collector);
  else if (selectsMember(declaration, node.value)) collector.push(node.value, 'enumMember');
}

/**
 * An override path's two resolvable ends.
 *
 * The BNF makes the first segment a plan and the last an attribute, annotation
 * or metric; the segments between name features of a plan the path has not
 * finished identifying and may carry Table 5's wildcards, so they are left
 * uncoloured — the same two ends `navigation.ts` resolves, through the same
 * `pathPlanName`.
 */
function overridePathTokens(model: PlanDocument, node: PlanNode & { kind: 'assignment' },
                            index: WorkspaceIndex | undefined, collector: TokenCollector): void {
  const { segments } = node.target;
  const first = segments[0], last = segments[segments.length - 1];
  const firstText = runText(first);
  if (!WILDCARD.test(firstText) && index?.plans(firstText).length) collector.push(first, 'namespace');
  if (!index) return;
  const planName = pathPlanName(index, segments.slice(0, -1).map(runText));
  const entry = planName ? index.plans(planName)[0] : undefined;
  if (!entry) return;
  const scope = scopeOf(entry.model, entry.node);
  const declaration = lookup(scope, runText(last));
  if (!declaration) return;
  collector.declared(last, declaration);
  valueTokens(model, node, declaration, scope, collector);
}

/**
 * The identifiers inside a goal expression.
 *
 * `goalNames` is `navigation.ts`'s — it is the rule about which spellings can be
 * located in the source at all (`parseGoal` joins a dotted name, and the
 * whitespace inside it is not recoverable), and having it stated twice would let
 * a rename and a colour disagree about the same word.
 */
function goalTokens(model: PlanDocument, value: TokenRun, header: Span, metric: Declaration,
                    scope: Scope, collector: TokenCollector): void {
  if (!value.tokens.length || !collector.intersects(value)) return;
  for (const goal of goalNames(model, value, header)) {
    const head = model.source.span(goal.span.start, goal.span.start + goal.head.length);
    const named = metricIn(scope, goal.head);
    if (named) collector.declared(head, named);
    else if (metric.type === 'enum' && metric.members.includes(goal.head)) collector.push(head, 'enumMember');
    if (!goal.tail) continue;
    const owner = named ?? metric;
    const tail = model.source.span(goal.span.end - goal.tail.length, goal.span.end);
    // An `aggregate` member is a metric of its own; an `enum` member is a value.
    const submetric = owner.type === 'aggregate' ? metricIn(scope, goal.tail) : undefined;
    if (submetric) collector.declared(tail, submetric);
    else if (owner.type === 'enum' && owner.members.includes(goal.tail)) collector.push(tail, 'enumMember');
  }
}

/**
 * `${name}` inside a `source = "..."` string.
 *
 * The literals are walked here rather than through `sourceExpressions.ts`'s
 * `sourceLiterals` generator so the whole provider stays one pass over
 * `model.nodes`; the two helpers that decide what a literal *is*
 * (`sourceLiteral`, `isTerminated`) are the generator's own, so the answer
 * cannot differ. An unterminated literal is skipped: its contents are whatever
 * happened to follow on the line.
 *
 * What may be interpolated is `resolver.ts`'s rule — attributes and annotations
 * plus the reserved `objpath`, never a metric, since interpolation substitutes a
 * value and a metric carries a goal instead.
 */
function interpolationTokens(model: PlanDocument, node: PlanNode & { kind: 'source' },
                             collector: TokenCollector): void {
  let scope: Scope | undefined;
  for (const run of node.values) {
    const token = sourceLiteral(run);
    // The text test comes before the parse: a literal with no `${` in it — most
    // of them — costs one `indexOf` rather than a decode and a scan.
    if (!token || !isTerminated(token) || !token.text.includes('${')) continue;
    if (!collector.intersects(token)) continue;
    for (const interpolation of parseSourceExpression(model.source, token).interpolations) {
      if (!interpolation.name) continue;
      if (interpolation.name === OBJPATH) {
        // The one interpolation name no plan declares: a built-in value, marked
        // as one rather than left to look like an undeclared name.
        collector.push(interpolation.nameSpan, 'variable', 'defaultLibrary');
        continue;
      }
      const declaration = lookup(scope ??= scopeOf(model, node), interpolation.name);
      if (declaration && declaration.kind !== 'metric') collector.declared(interpolation.nameSpan, declaration);
    }
  }
}

/**
 * LSP's delta encoding: five integers per token, each relative to the one
 * before it — `deltaLine`, `deltaStartChar` (relative only within a line),
 * `length`, the token type's legend index, and the modifier bitset.
 *
 * The input must be sorted by position, which `semanticTokens` guarantees. An
 * overlapping token is dropped rather than encoded: LSP gives no meaning to two
 * tokens covering the same character, and clients differ on what they do with
 * one, so the earlier token wins and the file stays predictable.
 */
export function encodeSemanticTokens(tokens: readonly SemanticToken[]): number[] {
  const data: number[] = [];
  let line = 0, character = 0, previousEnd = -1;
  for (const token of tokens) {
    if (token.line === line && token.character < previousEnd) continue;
    const deltaLine = token.line - line;
    data.push(deltaLine, deltaLine === 0 ? token.character - character : token.character,
      token.length, TYPE_INDEX.get(token.type)!,
      token.modifiers.reduce((bits, modifier) => bits | (MODIFIER_BIT.get(modifier) ?? 0), 0));
    line = token.line;
    character = token.character;
    previousEnd = token.character + token.length;
  }
  return data;
}

/** The LSP response body: `{ data }`, encoded against `SEMANTIC_TOKENS_LEGEND`. */
export function provideSemanticTokens(model: PlanDocument, options: SemanticTokensOptions = {}): { data: number[] } {
  return { data: encodeSemanticTokens(semanticTokens(model, options)) };
}

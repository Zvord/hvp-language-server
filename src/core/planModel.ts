import { Diagnostic, FoldingRange } from 'vscode-languageserver-types';
import { buildDeclarations, DeclarationTable } from './declarations';
import { PairKind } from './keywords';
import { SourceText, Span, Token, tokenIndexAt } from './tokenizer';

export interface TokenRun extends Span { tokens: readonly Token[]; text: string }
export interface Reference extends TokenRun { segments: readonly TokenRun[] }
export interface TypeSpec extends TokenRun {
  name?: Token;
  members: readonly { name: TokenRun; weight?: TokenRun }[];
}
export interface Parameter extends Span { name: TokenRun; value: TokenRun }
export interface NodeBase extends Span {
  id: number;
  parentId?: number;
  header: Span;
  children: PlanNode[];
  incomplete: boolean;
  /** Present only for a correctly matched closer. */
  close?: Token;
}
export interface NamedNode extends NodeBase { name?: Token }
export type PlanNode =
  | (NamedNode & { kind: 'plan' | 'feature' | 'override' | 'filter' })
  | (NamedNode & { kind: 'attribute' | 'annotation'; type: TypeSpec; value: TokenRun })
  | (NamedNode & { kind: 'metric'; type: TypeSpec })
  | (NamedNode & { kind: 'measure'; metrics: Reference[] })
  | (NamedNode & { kind: 'subplan'; parameters: Parameter[] })
  | (NodeBase & { kind: 'assignment'; target: Reference; value: TokenRun })
  | (NodeBase & { kind: 'source'; values: TokenRun[] })
  | (NodeBase & { kind: 'goal' | 'aggregator' | 'apply'; value: TokenRun })
  | (NodeBase & { kind: 'keep' | 'remove'; condition: TokenRun })
  | (NodeBase & { kind: 'until' })
  | (NodeBase & { kind: 'branch'; branchKind: 'until' | 'elseuntil' | 'else'; date?: TokenRun })
  | (NodeBase & { kind: 'unknown'; tokens: TokenRun });

export const isBlock = (node: PlanNode): boolean =>
  ['plan', 'feature', 'metric', 'measure', 'override', 'filter', 'until'].includes(node.kind);

/** The run's tokens joined back together, dropping the whitespace and comments
 * that sat between them. Deliberately not `TokenRun.text`, which is the raw
 * source slice and keeps both. */
export const runText = (run?: TokenRun): string => run?.tokens.map(t => t.text).join('') ?? '';

/** Where a diagnostic about `value` lands. An empty value run has no range of
 * its own, so the statement header carries the message instead. */
export const valueSpan = (value: TokenRun, header: Span): Span => value.tokens.length ? value : header;

/** Modifier blocks address the instantiated hierarchy by path, which only WS7
 * can resolve, so their assignments name nothing in this file. */
const MODIFIER_BLOCKS = new Set<PlanNode['kind']>(['override', 'filter']);

/** The name token of the node kinds that carry one, so callers do not each
 * repeat the `'name' in node` narrowing. */
export const nameToken = (node?: PlanNode): Token | undefined =>
  node && 'name' in node ? node.name : undefined;

/** What a document offset sits inside, as far as the token stream and the node
 * tree are concerned. `source-string` is the one string a provider can say
 * something about: WS4 models its contents. */
export type Mask = 'comment' | 'string' | 'source-string';

/** A syntax model, not a symbol table: duplicates, unresolved names and invalid
 * placements are preserved for semantic workstreams to diagnose. */
export class PlanDocument {
  readonly roots: PlanNode[] = [];
  readonly nodes: PlanNode[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly foldingRanges: FoldingRange[] = [];
  private declarationTable?: DeclarationTable;
  constructor(readonly source: SourceText, readonly tokens: readonly Token[]) {}
  get plans(): PlanNode[] { return this.roots.filter(n => n.kind === 'plan'); }
  /** Built once per parse, on first use: completion and hover need it on
   * requests that never run diagnostics. */
  get declarations(): DeclarationTable { return this.declarationTable ??= buildDeclarations(this); }
  nodeAt(offset: number): PlanNode | undefined {
    let found: PlanNode | undefined;
    for (const node of this.nodes) {
      if (node.start <= offset && (offset < node.end || (node.incomplete && offset === node.end))) found = node;
    }
    return found;
  }
  parent(node: PlanNode): PlanNode | undefined {
    return node.parentId === undefined ? undefined : this.nodes[node.parentId];
  }
  enclosing(offset: number, kind: PlanNode['kind']): PlanNode | undefined {
    return this.enclosingOf(this.nodeAt(offset), kind);
  }
  /** Ancestor walk from a node already in hand: O(depth) pointer hops instead of
   * the full `nodes` scan `enclosing(offset)` needs to find that node first. */
  enclosingOf(node: PlanNode | undefined, kind: PlanNode['kind']): PlanNode | undefined {
    while (node && node.kind !== kind) node = this.parent(node);
    return node;
  }
  /** True when `node` sits inside a modifier block, whose assignments address
   * the plan being modified rather than anything declared here. */
  insideModifier(node: PlanNode): boolean {
    for (let parent = this.parent(node); parent; parent = this.parent(parent)) {
      if (MODIFIER_BLOCKS.has(parent.kind)) return true;
    }
    return false;
  }
  /**
   * The hierarchy path an assignment addresses, or undefined when the statement
   * names something this file declares.
   *
   * This is the rule WS7 narrowed `checkable` down to. A modifier statement's
   * left-hand side is an XMR-style path into the *modified* plan
   * (`topplan.subplan1.mem.owner`), so nothing in the file it is written in can
   * type it — but a single-segment statement inside an `override` block written
   * inside a plan names that plan's own declaration, and every pass can check
   * it exactly as it checks an assignment anywhere else. Two shapes count as a
   * path: a dotted target inside an `override`/`filter` block, and a dotted
   * target in a modifier file, which has no plan of its own to name.
   *
   * The declaration lookup is the guard that keeps `test.expected = 5;` an
   * assignment to the built-in attribute whose *name* has a dot in it rather
   * than a two-segment path — the only dotted name the language declares.
   */
  overridePath(node: PlanNode): Reference | undefined {
    if (node.kind !== 'assignment' || node.target.segments.length < 2) return undefined;
    const plan = this.enclosingOf(node, 'plan');
    if (plan && !this.insideModifier(node)) return undefined;
    const key = plan?.id ?? 'root';
    const scope = this.declarations.get(key) ?? this.declarations.get('root');
    return scope?.declarations.has(runText(node.target)) ? undefined : node.target;
  }
  /**
   * Whether a semantic pass should say anything about `node`.
   *
   * Two exemptions, stated once for every pass instead of once per check: a
   * statement the parser recovered from already carries a syntax diagnostic and
   * its runs are unreliable, and a statement that addresses the instantiated
   * hierarchy rather than this file, which `modifierDiagnostics` checks instead.
   *
   * WS7 is the workstream that narrowed the second one. It used to be "anything
   * inside an `override`/`filter` block", because nothing could resolve a path;
   * it is now the path itself (`overridePath`) plus the statements a modifier
   * block can hold that belong to the plan being modified rather than to this
   * one — a `subplan` written inside an `override` instantiates nothing, and a
   * `measure`/`source` there describes no measure here.
   */
  checkable(node: PlanNode): boolean {
    if (node.incomplete) return false;
    if (this.overridePath(node)) return false;
    return !this.insideModifier(node) || node.kind === 'assignment';
  }
  enclosingFeature(offset: number): PlanNode | undefined { return this.enclosing(offset, 'feature'); }
  enclosingPlan(offset: number): PlanNode | undefined { return this.enclosing(offset, 'plan'); }
  blocksAt(offset: number): PairKind[] {
    return this.nodes.filter(n => isBlock(n) && n.header.end <= offset &&
      (offset < (n.close?.end ?? n.end) || (n.incomplete && offset === n.end))).map(n => n.kind as PairKind);
  }
  /**
   * What the caret sits inside, as a kind rather than a yes/no.
   *
   * `maskedAt` used to be the whole answer: text the model has no structure for,
   * which a provider should refuse to complete or hover in. WS4 made that false
   * for one case — the inside of a `source = "..."` string *is* modelled — and
   * the shape that invites a bug is a provider hoisting its source branch in
   * front of a boolean guard, since the ordering is then load-bearing and
   * nothing enforces it. Dispatching on the kind is what WS6's definition
   * lookup and WS8c's semantic tokens should do instead.
   *
   * A caret on the opening quote or the closing one has not entered the token,
   * matching `covers`'s counterpart for structure: only an unterminated literal
   * and a `//` comment mask their own end offset, since neither has a closer the
   * caret could be past.
   */
  maskAt(offset: number): Mask | undefined {
    // Tokens are offset-ordered and never overlap, so the only token that can
    // start before `offset` and still reach it is the one before the first token
    // starting at or after it.
    const token = this.tokens[tokenIndexAt(this.tokens, offset) - 1];
    if (!token || token.kind !== 'comment' && token.kind !== 'string') return undefined;
    if (token.start >= offset) return undefined;
    if (!(offset < token.end ||
          (offset === token.end && (token.terminated === false || token.text.startsWith('//'))))) return undefined;
    if (token.kind === 'comment') return 'comment';
    return this.nodeAt(token.start)?.kind === 'source' ? 'source-string' : 'string';
  }
  /** The boolean `maskAt` used to be, for callers that only need "is this a
   * hole" — every kind is one, including `source-string`, which the providers
   * that understand it answer before asking. */
  maskedAt(offset: number): boolean {
    return this.maskAt(offset) !== undefined;
  }
}

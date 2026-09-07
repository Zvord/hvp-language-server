import { Diagnostic, FoldingRange } from 'vscode-languageserver-types';
import { buildDeclarations, DeclarationTable } from './declarations';
import { PairKind } from './keywords';
import { SourceText, Span, Token } from './tokenizer';

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

/** Modifier blocks address the instantiated hierarchy by path, which only WS7
 * can resolve, so their assignments name nothing in this file. */
const MODIFIER_BLOCKS = new Set<PlanNode['kind']>(['override', 'filter']);

/** The name token of the node kinds that carry one, so callers do not each
 * repeat the `'name' in node` narrowing. */
export const nameToken = (node?: PlanNode): Token | undefined =>
  node && 'name' in node ? node.name : undefined;

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
  enclosingFeature(offset: number): PlanNode | undefined { return this.enclosing(offset, 'feature'); }
  enclosingPlan(offset: number): PlanNode | undefined { return this.enclosing(offset, 'plan'); }
  blocksAt(offset: number): PairKind[] {
    return this.nodes.filter(n => isBlock(n) && n.header.end <= offset &&
      (offset < (n.close?.end ?? n.end) || (n.incomplete && offset === n.end))).map(n => n.kind as PairKind);
  }
  maskedAt(offset: number): boolean {
    return this.tokens.some(t => (t.kind === 'comment' || t.kind === 'string') && t.start < offset &&
      (offset < t.end || (offset === t.end && (t.terminated === false || t.text.startsWith('//')))));
  }
}

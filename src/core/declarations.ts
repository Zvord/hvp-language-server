import { Range } from 'vscode-languageserver-types';
import { BUILTIN_FIELD_DECLARATIONS, BUILTIN_METRIC_DECLARATIONS } from './keywords';
import { PlanDocument, PlanNode, runText } from './planModel';

export type DeclarationKind = 'attribute' | 'annotation' | 'metric';

/** What a metric declares beyond its name and type. Built-ins carry the
 * documented table's values; a declared metric carries what its block states,
 * so an omitted `goal` or `aggregator` stays empty rather than guessed. */
export interface MetricShape {
  aggregator: string;
  /** Source text of the `goal = ...` expression, empty when none is declared. */
  goal: string;
  /** `aggregate {X(weight=...)}` weights by member name; a member written
   * without a weight is absent and takes the documented default of 1. */
  weights: ReadonlyMap<string, string>;
}

/** One name a plan can resolve. Built-ins carry no node; declared ones keep the
 * declaration node so hover and navigation can link back to the source. */
export interface Declaration {
  name: string;
  kind: DeclarationKind;
  /** Declared type keyword, or '' when the built-in has no declared shape. */
  type: string;
  members: readonly string[];
  /** Source text of the default value, empty when the declaration omits one. */
  defaultText: string;
  builtin: boolean;
  node?: PlanNode;
  /** Name range of the declaration; absent for built-ins. */
  range?: Range;
  /** Metrics only. */
  metric?: MetricShape;
}

/** Attributes, annotations and metrics share one namespace per plan, matching
 * how assignment left-hand sides are looked up. */
export interface Scope {
  declarations: ReadonlyMap<string, Declaration>;
}

export type DeclarationTable = ReadonlyMap<number | 'root', Scope>;

const builtin = (name: string, kind: DeclarationKind, type: string, defaultText: string): Declaration =>
  ({ name, kind, type, members: [], defaultText, builtin: true });

const BUILTINS: readonly Declaration[] = [
  ...BUILTIN_FIELD_DECLARATIONS.filter(f => f.field !== 'statement')
    .map(f => builtin(f.name, f.field as DeclarationKind, f.type, f.default)),
  ...BUILTIN_METRIC_DECLARATIONS.map(m => ({
    ...builtin(m.name, 'metric', m.type, ''),
    members: m.members,
    metric: { aggregator: m.aggregator, goal: '', weights: new Map<string, string>() },
  })),
];

/** The `goal`/`aggregator` a metric block states, and the weights its
 * `aggregate {...}` type spells out. */
function metricShape(node: PlanNode & { kind: 'metric' }): MetricShape {
  const statement = (kind: 'goal' | 'aggregator') =>
    node.children.find(child => child.kind === kind) as (PlanNode & { kind: 'goal' | 'aggregator' }) | undefined;
  const weights = new Map<string, string>();
  for (const member of node.type.members) {
    if (member.weight) weights.set(runText(member.name), runText(member.weight));
  }
  // The goal keeps its raw source slice: an expression reads as it was written,
  // where a name only needs its tokens joined back together.
  return { aggregator: runText(statement('aggregator')?.value), goal: statement('goal')?.value.text ?? '', weights };
}

/** The declaration a declaring node states, independent of which one wins in
 * its plan: the semantic pass types a node's own default against this. */
export function declarationFromNode(node: PlanNode & { kind: DeclarationKind }): Declaration {
  return {
    name: node.name?.text ?? '',
    kind: node.kind,
    type: node.type.name?.text ?? '',
    members: node.type.members.map(m => runText(m.name)),
    defaultText: node.kind === 'metric' ? '' : runText(node.value),
    builtin: false,
    node,
    range: node.name?.range,
    metric: node.kind === 'metric' ? metricShape(node) : undefined,
  };
}

/** Declarations win over built-ins of the same name: WS1 already warns about the
 * redeclaration, and the written declaration is what the rest of the file means. */
export function buildDeclarations(model: PlanDocument): DeclarationTable {
  const table = new Map<number | 'root', { declarations: Map<string, Declaration> }>();
  const scopeFor = (plan?: PlanNode) => {
    const key = plan?.id ?? 'root';
    let scope = table.get(key);
    if (!scope) table.set(key, scope = { declarations: new Map(BUILTINS.map(d => [d.name, d])) });
    return scope;
  };
  scopeFor(undefined);
  for (const plan of model.plans) scopeFor(plan);
  for (const node of model.nodes) {
    if (node.kind !== 'attribute' && node.kind !== 'annotation' && node.kind !== 'metric') continue;
    if (!node.name) continue;
    const scope = scopeFor(model.enclosingPlan(node.start));
    // The first declaration wins; WS1 reports the later duplicates.
    const existing = scope.declarations.get(node.name.text);
    if (existing && !existing.builtin) continue;
    scope.declarations.set(node.name.text, declarationFromNode(node));
  }
  return table;
}

export function scopeAt(model: PlanDocument, offset: number): Scope {
  return scopeOf(model, model.nodeAt(offset));
}

/** Same lookup from a node already in hand, so callers holding one skip the
 * offset-to-node scan. */
export function scopeOf(model: PlanDocument, node?: PlanNode): Scope {
  const table = model.declarations;
  // A plan nested inside another plan is not a root plan and so has no scope of
  // its own; its declarations landed in the root scope.
  return table.get(model.enclosingOf(node, 'plan')?.id ?? 'root') ?? table.get('root')!;
}

export const lookup = (scope: Scope, name: string): Declaration | undefined => scope.declarations.get(name);

/** The metric `name` resolves to in `scope`, or undefined when the name is
 * absent or declares an attribute or annotation instead. This is also what
 * tells a goal override from an attribute assignment. */
export const metricIn = (scope: Scope, name: string): Declaration | undefined => {
  const declaration = lookup(scope, name);
  return declaration?.kind === 'metric' ? declaration : undefined;
};

export const fieldsOf = (scope: Scope, kind: DeclarationKind): Declaration[] =>
  [...scope.declarations.values()].filter(d => d.kind === kind);

import { Range } from 'vscode-languageserver-types';
import { BUILTIN_FIELD_DECLARATIONS, BUILTIN_METRICS } from './keywords';
import { PlanDocument, PlanNode, runText } from './planModel';

export type DeclarationKind = 'attribute' | 'annotation' | 'metric';

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
  ...BUILTIN_METRICS.map(m => builtin(m.name, 'metric', '', '')),
];

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

export const fieldsOf = (scope: Scope, kind: DeclarationKind): Declaration[] =>
  [...scope.declarations.values()].filter(d => d.kind === kind);

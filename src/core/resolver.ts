import { Declaration, Scope, scopeOf } from './declarations';
import { PlanDocument, PlanNode, TokenRun, nameToken, runText } from './planModel';

/**
 * Everything the resolver needs beyond the document itself. The single-file
 * caller passes `{}`; WS5 fills in `instancePath`/`parameters` per subplan
 * instantiation and WS7 fills in `overrides`, without the resolver changing.
 */
export interface ResolutionContext {
  /** Instance path of the plan instance being resolved, outermost first. */
  instancePath?: readonly string[];
  /** `#(name=value)` values this plan instance received, by attribute name. */
  parameters?: ReadonlyMap<string, string>;
  /** Modifier overrides that already won for this instance, in application order. */
  overrides?: readonly { name: string; text: string; label: string }[];
}

/** The one node kind `assignmentsIn` collects, named so callers can hold it
 * without re-testing `kind`. */
export type AssignmentNode = Extract<PlanNode, { kind: 'assignment' }>;

export type Origin =
  | { kind: 'default' }
  | { kind: 'parameter'; label: string }
  | { kind: 'override'; label: string }
  | { kind: 'assignment'; node: AssignmentNode; scope: string; local: boolean };

export interface EffectiveValue {
  declaration: Declaration;
  text: string;
  origin: Origin;
}

/** Scopes from the enclosing plan down to `feature`, outermost first. */
export function scopeChain(model: PlanDocument, feature?: PlanNode): PlanNode[] {
  const chain: PlanNode[] = [];
  for (let node = feature; node; node = model.parent(node)!) {
    if (node.kind === 'feature' || node.kind === 'plan') chain.unshift(node);
  }
  return chain;
}

/** Dotted feature path within its plan, e.g. `cpu.memory.read`. */
export function featurePath(model: PlanDocument, feature: PlanNode): string {
  return scopeChain(model, feature).filter(n => n.kind === 'feature')
    .map(n => nameToken(n)?.text || '?').join('.');
}

export const scopeLabel = (model: PlanDocument, node: PlanNode): string =>
  node.kind === 'plan' ? (nameToken(node)?.text || 'plan') : featurePath(model, node);

/** Blocks the resolver looks straight through: their statements belong to the
 * feature or plan containing them, since only WS7 knows which branch is live. */
const TRANSPARENT = new Set<PlanNode['kind']>(['until', 'branch']);

/**
 * The last direct assignment to each name inside `scope`, looking through
 * `until` branches but not into nested features, measures or modifier blocks.
 *
 * Built in one pass and looked up per declaration, rather than rescanning the
 * children once for every declared name.
 */
export function assignmentsIn(scope: PlanNode): Map<string, AssignmentNode> {
  const found = new Map<string, AssignmentNode>();
  const visit = (nodes: PlanNode[]) => {
    for (const node of nodes) {
      if (TRANSPARENT.has(node.kind)) visit(node.children);
      else if (node.kind === 'assignment') found.set(runText(node.target), node);
    }
  };
  visit(scope.children);
  return found;
}

/**
 * The scope `resolveValues` attributes `node` to, or undefined when none does.
 * A measure-local or modifier-block assignment is invisible to the resolver, so
 * callers must not report an effective value for it.
 */
export function resolutionScope(model: PlanDocument, node: PlanNode): PlanNode | undefined {
  for (let parent = model.parent(node); parent; parent = model.parent(parent)) {
    if (parent.kind === 'feature' || parent.kind === 'plan') return parent;
    if (!TRANSPARENT.has(parent.kind)) return undefined;
  }
  return undefined;
}

/** Text an assignment contributes. A metric's value is a goal expression, which
 * keeps its raw source slice so it reads back as it was written; every other
 * value joins its tokens, dropping the whitespace and comments between them. */
const assignedText = (declaration: Declaration, value: TokenRun): string =>
  declaration.kind === 'metric' ? value.text : runText(value);

/**
 * The value `declaration` takes at the end of `chain`.
 *
 * Attributes and metric goals inherit: the declaration default, then any
 * subplan parameter for this instance, then the last assignment in each scope
 * from the plan down. Annotations do not inherit — only an assignment in the
 * innermost scope itself, or the default. Overrides are applied last, in order.
 *
 * `assignmentsOf` lets a caller resolving many declarations at once share one
 * per-scope assignment table instead of rebuilding it for every name.
 */
export function resolveDeclaration(model: PlanDocument, chain: readonly PlanNode[], declaration: Declaration,
                                   context: ResolutionContext = {},
                                   assignmentsOf: (scope: PlanNode) => Map<string, AssignmentNode> = assignmentsIn): EffectiveValue {
  const local = chain[chain.length - 1];
  // A metric declares no default value; what it starts from is its own goal.
  const defaultText = declaration.kind === 'metric' ? declaration.metric?.goal ?? '' : declaration.defaultText;
  let value: EffectiveValue = { declaration, text: defaultText, origin: { kind: 'default' } };
  // A subplan parameter is the value the instance starts from; assignments
  // written inside the plan still apply on top of it. WS5 confirms this
  // ordering against the tool once instance resolution lands.
  const parameter = declaration.kind === 'attribute' ? context.parameters?.get(declaration.name) : undefined;
  if (parameter !== undefined) value = { declaration, text: parameter, origin: { kind: 'parameter', label: 'subplan parameter' } };
  const scopes = declaration.kind === 'annotation' ? (local ? [local] : []) : chain;
  for (const node of scopes) {
    const assignment = assignmentsOf(node).get(declaration.name);
    if (!assignment) continue;
    value = { declaration, text: assignedText(declaration, assignment.value),
      origin: { kind: 'assignment', node: assignment, scope: scopeLabel(model, node), local: node === local } };
  }
  for (const override of context.overrides ?? []) {
    if (override.name === declaration.name) value = { declaration, text: override.text, origin: { kind: 'override', label: override.label } };
  }
  return value;
}

/**
 * Effective values for every attribute and annotation visible at `feature`
 * (or at plan level when `feature` is a plan).
 *
 * Metrics are left out: their value is a goal expression rather than a literal,
 * and `resolveGoal` asks for one metric at a time (see metrics.ts).
 */
export function resolveValues(model: PlanDocument, feature: PlanNode | undefined,
                              context: ResolutionContext = {}): EffectiveValue[] {
  const scope: Scope = scopeOf(model, feature);
  const chain = scopeChain(model, feature);
  const assignments = new Map(chain.map(node => [node, assignmentsIn(node)] as const));
  const values: EffectiveValue[] = [];
  for (const declaration of scope.declarations.values()) {
    if (declaration.kind === 'metric') continue;
    values.push(resolveDeclaration(model, chain, declaration, context, node => assignments.get(node)!));
  }
  return values;
}

/** The value `name` takes at `feature`, or undefined when it is not declared. */
export function resolveValue(model: PlanDocument, feature: PlanNode | undefined, name: string,
                             context: ResolutionContext = {}): EffectiveValue | undefined {
  return resolveValues(model, feature, context).find(v => v.declaration.name === name);
}

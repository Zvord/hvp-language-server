import { Declaration, Scope, lookup, scopeOf } from './declarations';
import { OBJPATH } from './keywords';
import { PlanDocument, PlanNode, TokenRun, nameToken, runText } from './planModel';
import { unescapeLiteralText } from './sourceExpressions';

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

/**
 * The full path of the measure hierarchy `node` sits in: the plan name, the
 * feature path and the measure name. This is what `${objpath}` expands to.
 *
 * `context.instancePath` is prefixed when the caller has one. For the top-level
 * plan there is none and the path is exactly the names written in the file; for
 * a WS5 subplan instance the same measure is reached through the instantiation,
 * and the resolver's own seam — not a second walk of the local node tree — is
 * what says so. Path resolution, so it lives here beside `featurePath` rather
 * than in a presentation module.
 */
export function objectPath(model: PlanDocument, node: PlanNode, context: ResolutionContext = {}): string {
  const feature = model.enclosingOf(node, 'feature');
  return [...(context.instancePath ?? []),
    nameToken(model.enclosingOf(node, 'plan'))?.text,
    feature && featurePath(model, feature),
    nameToken(model.enclosingOf(node, 'measure'))?.text].filter(Boolean).join('.');
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

// ---------------------------------------------------------------------------
// `${name}` inside a `source` string
// ---------------------------------------------------------------------------

/**
 * What a `${name}` may name: an attribute or an annotation, never a metric.
 *
 * Interpolation substitutes a *value* into a source string, and a metric has a
 * goal expression rather than a value — there is nothing to substitute. The
 * reserved `objpath` is the one name no plan declares.
 *
 * One rule, three askers, so they cannot drift apart the way they had:
 * `sourceDiagnostics` asks whether a name resolved, `hover` asks what it
 * resolved to, and `completion` asks what could go there.
 */
const substitutable = (declaration?: Declaration): boolean => !!declaration && declaration.kind !== 'metric';

/** Whether `${name}` names something a source string can substitute here. */
export const interpolates = (scope: Scope, name: string): boolean =>
  name === OBJPATH || substitutable(lookup(scope, name));

/** Every name a `${...}` may carry here, for completion. `objpath` is not among
 * them — it is reserved rather than declared, so the caller offers it itself. */
export const interpolationTargets = (scope: Scope): Declaration[] =>
  [...scope.declarations.values()].filter(declaration => substitutable(declaration));

/** The value an interpolation substitutes: a string attribute contributes its
 * contents, not its quotes, and every other type the decimal text it was
 * written with. */
export function interpolatedText(value: EffectiveValue): string {
  const text = value.text.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? unescapeLiteralText(text.slice(1, -1)) : text;
}

export type Interpolated =
  | { kind: 'objpath'; text: string }
  | { kind: 'value'; text: string; value: EffectiveValue };

/**
 * What `${name}` expands to at `node`, or undefined when it names nothing a
 * source string can substitute.
 *
 * `valuesOf` lets a caller expanding a whole string resolve the enclosing scope
 * once and share it across the names — and, being a thunk like
 * `resolveDeclaration`'s `assignmentsOf`, lets it not resolve at all when every
 * `${...}` turns out to be `objpath`.
 */
export function resolveInterpolation(model: PlanDocument, node: PlanNode, name: string,
                                     context: ResolutionContext = {},
                                     valuesOf: () => ReadonlyMap<string, EffectiveValue> =
                                       () => interpolationValues(model, node, context)): Interpolated | undefined {
  if (name === OBJPATH) return { kind: 'objpath', text: objectPath(model, node, context) };
  const value = valuesOf().get(name);
  return value && substitutable(value.declaration) ? { kind: 'value', text: interpolatedText(value), value } : undefined;
}

/** Every value a `${name}` at `node` could substitute, by name. The scope a
 * source string reads is the feature holding its measure, or the plan when
 * there is no feature. */
export function interpolationValues(model: PlanDocument, node: PlanNode,
                                    context: ResolutionContext = {}): ReadonlyMap<string, EffectiveValue> {
  const scope = model.enclosingOf(node, 'feature') ?? model.enclosingOf(node, 'plan');
  return new Map(resolveValues(model, scope, context).map(value => [value.declaration.name, value]));
}

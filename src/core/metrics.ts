import { Declaration } from './declarations';
import { PlanDocument, PlanNode, TokenRun } from './planModel';
import { EffectiveValue, ResolutionContext, resolveDeclaration, scopeChain } from './resolver';
import { GoalType } from './goals';
import { covers } from './tokenizer';

/** A goal is an effective value like any other — the metric's own `goal = ...`
 * is its default, and a goal override is an assignment to it. */
export type EffectiveGoal = EffectiveValue;

/**
 * The goal expression in force for a metric at `scope`.
 *
 * The metric's own `goal = ...` is the starting point; a feature- or plan-level
 * goal override (`Group = Group >= 0.8;`) replaces it, and — like an attribute
 * assignment — applies to the sub-features below it. The documentation states
 * downward propagation for the `override` modifier and shows the feature form
 * without saying either way, so this mirrors the hierarchy's other values; WS7
 * confirms it against the tool when modifier evaluation lands.
 */
export function resolveGoal(model: PlanDocument, scope: PlanNode | undefined, declaration: Declaration,
                            context: ResolutionContext = {}): EffectiveGoal {
  return resolveDeclaration(model, scopeChain(model, scope), declaration, context);
}

/**
 * What a goal expression written for `metric` may name.
 *
 * The documentation allows the metric itself, a bare enum member, or
 * `metric.member`. An aggregate type lists sub-metric names rather than enum
 * members; those are accepted in the same positions, since the tool substitutes
 * a score for each one alike.
 */
export function goalIdentifierType(metric: Declaration, name: string): GoalType | undefined {
  if (name === metric.name) return metric.type as GoalType;
  const member = name.startsWith(`${metric.name}.`) ? name.slice(metric.name.length + 1) : name;
  if (!metric.members.includes(member)) return undefined;
  // An enum member carries the count of that named value; an aggregate member
  // is a metric of its own, whose type this table does not track.
  return metric.type === 'enum' ? 'integer' : 'unknown';
}

/** The metric reference under `offset` in a `measure` statement, or the
 * `aggregate {...}` member under it in a metric declaration. */
export function metricReferenceAt(node: PlanNode, offset: number): TokenRun | undefined {
  if (node.kind === 'measure') return node.metrics.find(run => covers(run, offset));
  if (node.kind === 'metric') return node.type.members.find(m => covers(m.name, offset))?.name;
  return undefined;
}

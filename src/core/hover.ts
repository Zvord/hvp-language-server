import { Hover, MarkupKind, Position, Range } from 'vscode-languageserver-types';
import { Declaration, metricIn, scopeOf } from './declarations';
import { EffectiveGoal, metricReferenceAt, resolveGoal } from './metrics';
import { PlanDocument, PlanNode, nameToken, runText } from './planModel';
import {
  EffectiveValue,
  ResolutionContext,
  featurePath,
  interpolationValues,
  resolutionScope,
  resolveInterpolation,
  resolveValue,
  resolveValues,
} from './resolver';
import { FilterRemoval, ModifierEvaluation, ResolvedOverride, modifierStatements, resolveOverride } from './modifiers';
import { sourceStringAt } from './sourceExpressions';
import { covers } from './tokenizer';
import {
  PlanInstance,
  WorkspaceIndex,
  PlanEntry,
  contextOf,
  instanceOfSubplan,
  instanceViewAt,
  parametersOf,
  subplanTargets,
} from './workspace';

/** HVP strings carry backtick tags (`\`r\``), so the fence has to outrun the
 * longest backtick run in the value; a span touching one needs padding too. */
const code = (text: string): string => {
  if (!text) return '—';
  const body = text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...[...body.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
};

/** `enum`/`aggregate` carry their member list, and an aggregate keeps the
 * weights it was declared with, so the signature reads like the declaration. */
const signature = (declaration: Declaration): string => {
  const members = declaration.members.map(member => {
    const weight = declaration.metric?.weights.get(member);
    return weight ? `${member}(weight=${weight})` : member;
  });
  const type = members.length && ['enum', 'aggregate'].includes(declaration.type)
    ? `${declaration.type} {${members.join(', ')}}` : declaration.type;
  return [type, declaration.name].filter(Boolean).join(' ');
};

/** A link when the request carried a document URI, plain text otherwise —
 * the core modules never assume they are serving a file-backed document. */
const linker = (uri?: string) => (label: string, range?: Range): string =>
  uri && range
    ? `[${label}](${uri.replace(/\(/g, '%28').replace(/\)/g, '%29')}#L${range.start.line + 1},${range.start.character + 1})`
    : label;

/** Every origin links back to where the value came from. A built-in carries no
 * declaration range, so its default stays plain text. */
function originText(value: EffectiveValue, link: (label: string, range?: Range) => string): string {
  const origin = value.origin;
  switch (origin.kind) {
    case 'default': return link('declaration default', value.declaration.range);
    case 'parameter': case 'override': return origin.label;
    case 'assignment':
      return link(origin.local ? `assigned in ${origin.scope}` : `inherited from ${origin.scope}`,
        origin.node.target.range);
  }
}

const byInterest = (a: EffectiveValue, b: EffectiveValue): number =>
  Number(a.declaration.builtin) - Number(b.declaration.builtin) || a.declaration.name.localeCompare(b.declaration.name);

/** A GitHub-flavoured markdown table, or nothing at all when there are no rows
 * — a heading with no body under it reads as a mistake. The one place the
 * scaffolding is spelled; callers supply cells. */
function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (!rows.length) return [];
  return ['', `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(cells => `| ${cells.join(' | ')} |`)];
}

const valueTable = (heading: string, values: EffectiveValue[],
                    link: (label: string, range?: Range) => string): string[] =>
  markdownTable([heading, 'Effective value', 'Origin'],
    values.sort(byInterest).map(v => [code(v.declaration.name), code(v.text), originText(v, link)]));

function declarationLines(model: PlanDocument, declaration: Declaration,
                          link: (label: string, range?: Range) => string): string[] {
  const plan = nameToken(model.enclosingOf(declaration.node, 'plan'));
  const where = declaration.builtin ? 'built-in'
    : link(plan ? `declared in plan ${plan.text}` : 'declared in this file', declaration.range);
  const lines = [`**${declaration.kind}** \`${signature(declaration)}\``, ''];
  if (declaration.kind !== 'metric') return [...lines, `${where} · default ${code(declaration.defaultText)}`];
  // An aggregate metric has no aggregator of its own; nor do the derived test
  // metrics, so the row is stated only where the language defines one.
  const aggregator = declaration.metric?.aggregator;
  return [...lines, aggregator ? `${where} · aggregator ${code(aggregator)}` : where];
}

/** The metric's declaration followed by the goal in force at `scope`, which is
 * the metric's own `goal = ...` until a feature overrides it. */
function metricLines(model: PlanDocument, declaration: Declaration, scope: PlanNode | undefined,
                     link: (label: string, range?: Range) => string, context: ResolutionContext): string[] {
  const goal = resolveGoal(model, scope, declaration, context);
  return [...declarationLines(model, declaration, link), ...goalLines(goal, link)];
}

function goalLines(goal: EffectiveGoal, link: (label: string, range?: Range) => string): string[] {
  if (!goal.text) return ['', 'No goal.'];
  return ['', `Goal: ${code(goal.text)}${goal.origin.kind === 'default' ? '' : ` (${originText(goal, link)})`}`];
}

/** Whether the caller stated a context of its own. An explicit one wins over
 * the index — a preview evaluating one instance says which. */
const stated = (context: ResolutionContext): boolean =>
  !!(context.instancePath || context.parameters || context.overrides);

/**
 * Hover for feature names, assignment targets, subplan statements and
 * declaration names.
 *
 * With a `index`, the values shown are the ones the instance under the cursor
 * receives: WS2 built the `ResolutionContext` seam, WS5's `instanceViewAt`
 * fills it in from the workspace. A plan instantiated more than once has no one
 * instance under the cursor, so the table stays parameter-free and a note says
 * how many instances read the same text.
 */
export interface HoverOptions {
  /** With one, every origin becomes a link; without one it stays plain text,
   * so core never assumes a file-backed document. */
  uri?: string;
  /** An explicit context wins over the one `index` would derive. */
  context?: ResolutionContext;
  index?: WorkspaceIndex;
  /**
   * WS7's preview, when the user configured one. With it, a feature's table
   * shows the value the winning `override` gives it and says which block that
   * was, and a feature a `filter` drops says so. Off by default: an evaluation
   * nothing asked for would quietly change every value the editor reports.
   */
  modifiers?: ModifierEvaluation;
}

/** One feature or plan under the cursor, as the preview sees it. */
interface Preview {
  evaluation: ModifierEvaluation;
  /** Hierarchy path of the scope under the cursor. */
  path: string;
  removal?: FilterRemoval;
}

/**
 * What the configured modifiers do to the scope under the cursor.
 *
 * Only a plan with exactly one instance gets one: the path an override matches
 * is a path through the hierarchy, and a file instantiated four times sits at
 * four of them — the same reason `instanceViewAt` refuses to pick one for the
 * parameter table.
 */
function previewAt(model: PlanDocument, node: PlanNode, options: HoverOptions,
                   view: { instances: readonly PlanInstance[] }): Preview | undefined {
  const evaluation = options.modifiers;
  if (!evaluation || view.instances.length !== 1) return undefined;
  const instance = view.instances[0];
  const feature = model.enclosingOf(node, 'feature');
  const path = [...instance.path, instance.plan.name, ...(feature ? [featurePath(model, feature)] : [])].join('.');
  return { evaluation, path };
}

/** The overrides in force at `preview`, as the resolver's own seam takes
 * them — so a previewed value reaches the hover through `resolveDeclaration`
 * rather than through a second value walk that could disagree with it. */
function previewContext(model: PlanDocument, node: PlanNode, preview: Preview | undefined,
                        context: ResolutionContext): ResolutionContext {
  if (!preview) return context;
  return {
    ...context,
    branchIsLive: preview.evaluation.branchIsLive,
    overrides: preview.evaluation.overridesAt(preview.path, scopeOf(model, node)),
  };
}

export function provideHover(model: PlanDocument, position: Position,
                             options: HoverOptions = {}): Hover | undefined {
  const { uri, context: given = {}, index } = options;
  const offset = model.source.offsetAt(position);
  const node = model.nodeAt(offset);
  if (!node) return undefined;
  const link = linker(uri);
  // A comment or a plain string literal is text the model has no structure for.
  // A `source` string is not — WS4 models its contents — so it takes its place
  // in the chain below instead of being hoisted in front of the guard, which is
  // what used to make the ordering here load-bearing and unenforced.
  const mask = model.maskAt(offset);
  if (mask === 'comment' || mask === 'string') return undefined;
  const view = instanceViewAt(index, uri, model, node);
  const preview = previewAt(model, node, options, view);
  const context = previewContext(model, node, preview, stated(given) ? given : view.context);
  const hover = sourceLines(model, offset, link, context)
    ?? featureLines(model, node, offset, link, context, view.instances, preview)
    ?? subplanLines(model, node, offset, uri, index, context)
    ?? overridePathLines(model, node, offset, index)
    ?? assignmentLines(model, node, offset, link, context)
    ?? metricReference(model, node, offset, link, context)
    ?? declaration(model, node, offset, link, context);
  if (!hover) return undefined;
  return { contents: { kind: MarkupKind.Markdown, value: hover.lines.join('\n') }, range: hover.range };
}

interface HoverLines { lines: string[]; range?: Range }
const at = (lines: string[], range?: Range): HoverLines => ({ lines, range });

function featureLines(model: PlanDocument, node: PlanNode, offset: number,
                      link: (label: string, range?: Range) => string, context: ResolutionContext,
                      instances: readonly PlanInstance[] = [], preview?: Preview): HoverLines | undefined {
  const name = nameToken(node);
  if ((node.kind !== 'feature' && node.kind !== 'plan') || !covers(name, offset)) return undefined;
  const values = resolveValues(model, node, context);
  const title = node.kind === 'plan' ? `**Plan** \`${name!.text}\`` : `**Feature** \`${featurePath(model, node)}\``;
  return at([title, ...instanceLines(instances), ...filterLines(node, preview, values),
    ...valueTable('Attribute', values.filter(v => v.declaration.kind === 'attribute'), link),
    ...valueTable('Annotation', values.filter(v => v.declaration.kind === 'annotation'), link)], name!.range);
}

const instancePath = (instance: PlanInstance): string =>
  [...instance.path, instance.plan.name].join('.');

/**
 * Whether the configured filters drop this feature.
 *
 * Stated on the feature rather than on every measure under it, because that is
 * the unit the chapter filters: "if a feature is filtered out, Verification
 * Planner excludes the corresponding measure score of the feature from
 * propagating through the entire plan hierarchy".
 */
function filterLines(node: PlanNode, preview: Preview | undefined,
                     values: readonly EffectiveValue[]): string[] {
  if (!preview || node.kind !== 'feature') return [];
  const table = new Map(values.map(value => [value.declaration.name, value.text]));
  const removal = preview.evaluation.removalOf(name => table.get(name));
  if (!removal) return [];
  const statement = removal.statement;
  return ['', `**Removed** by \`${statement.keep ? 'keep' : 'remove'} feature where `
    + `${statement.condition.text.trim()}\`${removal.label ? ` in filter \`${removal.label}\`` : ''}. `
    + 'Its measure scores do not propagate through the plan hierarchy.'];
}

/**
 * Hover on an `override`/`filter` path: what it resolves to.
 *
 * The path is the one thing in a modifier file that reads as a name and is not
 * one — `topplan.subplan1.mem.owner` names a scope in the *instantiated*
 * hierarchy, which no amount of reading this file reveals. So the hover shows
 * the resolution itself: the declaration the last segment found, and how many
 * scopes a wildcard reached, listing the first few by path.
 */
const MAX_LISTED_SCOPES = 8;

function overridePathLines(model: PlanDocument, node: PlanNode, offset: number,
                           index: WorkspaceIndex | undefined): HoverLines | undefined {
  const path = model.overridePath(node);
  if (!path || !covers(path, offset)) return undefined;
  const statement = modifierStatements(model).overrides.find(entry => entry.node.id === node.id);
  if (!statement) return undefined;
  const lines = [`**Override path** \`${runText(path)}\``];
  if (!index) return at([...lines, '', 'The workspace index is not available here, so the path was not resolved.'], path.range);
  const resolved = resolveOverride(index, statement);
  return at([...lines, '', ...scopeLines(resolved), ...targetLines(resolved)], path.range);
}

function scopeLines(resolved: ResolvedOverride): string[] {
  const { scopes } = resolved;
  if (resolved.problem?.kind === 'wildcard-name') {
    return ['A wildcard may stand for a plan or a feature name, not for the name this statement sets.'];
  }
  if (!scopes.length) return ['Matches no plan or feature in the instantiated hierarchy.'];
  const listed = scopes.slice(0, MAX_LISTED_SCOPES).map(scope => code(scope.path)).join(', ');
  const more = scopes.length > MAX_LISTED_SCOPES ? `, and ${scopes.length - MAX_LISTED_SCOPES} more` : '';
  return [`Matches ${scopes.length} ${scopes.length === 1 ? 'scope' : 'scopes'}: ${listed}${more}.`];
}

function targetLines(resolved: ResolvedOverride): string[] {
  const declaration = resolved.declaration;
  if (!declaration) return [];
  const owner: PlanEntry | undefined = resolved.declaredAt?.instance.plan;
  // An attribute or a metric goal is passed down to the leaves below every
  // scope it matched; an annotation is not, which is the chapter's one stated
  // exception to propagation.
  return ['', `Sets **${declaration.kind}** \`${signature(declaration)}\``
    + `${owner ? ` of plan ${owner.name}` : ''}, `
    + (declaration.kind === 'annotation'
      ? 'which is **not** passed down the hierarchy.'
      : 'which is passed down to every feature below.')];
}

/** What the file the cursor is in is instantiated as. One instance is named so
 * the reader can see whose parameters the table below carries; several are
 * counted, because the values differ per instance and the table cannot show a
 * value that depends on which one you mean. */
function instanceLines(instances: readonly PlanInstance[]): string[] {
  if (instances.length < 2) {
    const path = instances[0] && instancePath(instances[0]);
    return path && instances[0].origin ? ['', `Instance ${code(path)}.`] : [];
  }
  return ['', `Instantiated ${instances.length} times (${instances.map(i => code(instancePath(i))).join(', ')}); `
    + 'the values below take no instance parameters, since they differ per instance.'];
}

/**
 * Hover on a `subplan` statement: the plan it names, wherever it is declared,
 * and the values that instance receives.
 *
 * The table is resolved in the *target* plan's document, so its origins link
 * into that file rather than this one — a parameter's whole point is that the
 * value and the declaration it lands on live in different files.
 */
function subplanLines(model: PlanDocument, node: PlanNode, offset: number, uri: string | undefined,
                      index: WorkspaceIndex | undefined, context: ResolutionContext): HoverLines | undefined {
  const name = nameToken(node);
  if (node.kind !== 'subplan' || !covers(name, offset)) return undefined;
  const written = [...parametersOf(node)].map(([key, value]) => `${key}=${value}`).join(', ');
  const lines = [`**Subplan** \`${name!.text}\`${written ? ` \`#(${written})\`` : ''}`];
  const target = index && subplanTargets(index, node)[0];
  if (!target) {
    return at([...lines, '', index ? 'No plan of this name is declared in the workspace.'
      : 'The workspace index is not available here, so the plan was not resolved.'], name!.range);
  }
  const instance = instanceOfSubplan(index, uri, model, node);
  const targetLink = linker(target.uri);
  const values = resolveValues(target.model, target.node,
    instance ? contextOf(instance) : { instancePath: context.instancePath, parameters: parametersOf(node) });
  return at([...lines, '',
    targetLink(`plan ${target.name}`, nameToken(target.node)?.range),
    ...(instance ? ['', `Instance ${code(instancePath(instance))}.`] : []),
    ...valueTable('Attribute', values.filter(v => v.declaration.kind === 'attribute'), targetLink),
    ...valueTable('Annotation', values.filter(v => v.declaration.kind === 'annotation'), targetLink)],
    name!.range);
}

function assignmentLines(model: PlanDocument, node: PlanNode, offset: number,
                         link: (label: string, range?: Range) => string, context: ResolutionContext): HoverLines | undefined {
  if (node.kind !== 'assignment' || !covers(node.target, offset)) return undefined;
  const name = runText(node.target);
  const found = scopeOf(model, node).declarations.get(name);
  // A modifier block, or a modifier file with no plan of its own, names the
  // declarations of the plan it modifies — WS5/WS7 resolve those, so there is
  // nothing to assert about the name here.
  // An override path was answered above; what is left here either names a
  // declaration of the plan the statement sits in, or sits in a modifier file
  // with no plan of its own, where there is nothing to assert about the name.
  const elsewhere = !model.enclosingOf(node, 'plan');
  if (!found) {
    return elsewhere ? undefined : at([`\`${name}\` is not declared in this plan.`], node.target.range);
  }
  if (found.kind === 'metric') {
    // The statement under the cursor is the override itself, so the goal shown
    // is the one it establishes for this feature and the features below it.
    return at([...metricLines(model, found, resolutionScope(model, node), link, context), '',
      `Feature-level goal override for \`${name}\`.`], node.target.range);
  }
  // Omitted for an assignment no scope resolves (inside a measure, or a
  // modifier block): stating a value here would contradict the statement itself.
  const scope = resolutionScope(model, node);
  const effective = scope && resolveValue(model, scope, name, context);
  return at([...declarationLines(model, found, link),
    ...(effective ? ['', `Effective value here: ${code(effective.text)} (${originText(effective, link)})`] : [])],
    node.target.range);
}

/** A metric named in a `measure` statement or in an `aggregate {...}` type. */
function metricReference(model: PlanDocument, node: PlanNode, offset: number,
                         link: (label: string, range?: Range) => string,
                         context: ResolutionContext): HoverLines | undefined {
  const reference = metricReferenceAt(node, offset);
  if (!reference) return undefined;
  const found = metricIn(scopeOf(model, node), runText(reference));
  if (!found) return undefined;
  // A measure's metric takes the goal in force in the feature holding it; a
  // sub-metric of an aggregate is read at its declaring plan.
  return at(metricLines(model, found, model.enclosingOf(node, 'feature') ?? model.enclosingOf(node, 'plan'),
    link, context), reference.range);
}

function declaration(model: PlanDocument, node: PlanNode, offset: number,
                     link: (label: string, range?: Range) => string,
                     context: ResolutionContext): HoverLines | undefined {
  const name = nameToken(node);
  if (node.kind !== 'attribute' && node.kind !== 'annotation' && node.kind !== 'metric') return undefined;
  if (!covers(name, offset)) return undefined;
  const found = scopeOf(model, node).declarations.get(name!.text);
  if (!found) return undefined;
  return at(found.kind === 'metric'
    ? metricLines(model, found, model.enclosingOf(node, 'plan'), link, context)
    : declarationLines(model, found, link), name!.range);
}

/**
 * Hover on a `source = "..."` string: the string as the tool expands it.
 *
 * `${name}` is replaced by the value WS2's resolver reports at this feature, and
 * `${objpath}` by the measure's own path. A name that resolves to nothing is
 * left as written — the diagnostic pass has already said so, and inventing an
 * empty string here would hide it.
 */
function sourceLines(model: PlanDocument, offset: number, link: (label: string, range?: Range) => string,
                     context: ResolutionContext): HoverLines | undefined {
  const found = sourceStringAt(model, offset);
  if (!found) return undefined;
  const { statement, expression } = found;
  // The scope walk behind `resolveValues` is a quarter of this hover, and a
  // string with no `${...}` in it renders no variable table at all — so it is
  // paid for at the first interpolation and not before.
  let values: ReadonlyMap<string, EffectiveValue> | undefined;
  const valuesOf = () => values ??= interpolationValues(model, statement, context);
  const rows: string[][] = [];
  const queue = [...expression.interpolations];
  let expanded = '';
  for (const part of expression.parts) {
    if (part.kind !== 'interpolation') { expanded += part.text; continue; }
    const name = queue.shift()?.name ?? '';
    const resolved = resolveInterpolation(model, statement, name, context, valuesOf);
    expanded += resolved?.text ?? part.text;
    rows.push([code(part.text), code(resolved?.text ?? ''),
      resolved?.kind === 'value' ? originText(resolved.value, link)
        : resolved ? 'reserved variable' : 'not declared']);
  }
  const keyword = expression.keyword;
  return at(['**Source expression**', '', `Expands to ${code(expanded)}`,
    ...(keyword ? ['', `Keyword ${code(`${keyword.info.name}:`)} — ${keyword.info.detail}. `
      + `Available for ${keyword.info.metrics.join(', ')}.`] : []),
    ...(expression.hasRemoval ? ['', 'Carries a removal expression: the part after the `` `-` `` tag is subtracted from the match.'] : []),
    ...markdownTable(['Variable', 'Value', 'Origin'], rows)],
    expression.literal.range);
}

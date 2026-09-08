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
import { sourceStringAt } from './sourceExpressions';
import { covers } from './tokenizer';

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

/**
 * Hover for feature names, assignment targets and declaration names.
 *
 * `context` is the single-file empty context today; WS5 passes the instance the
 * cursor sits in so the values shown are that instance's.
 */
export function provideHover(model: PlanDocument, position: Position, uri?: string,
                             context: ResolutionContext = {}): Hover | undefined {
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
  const hover = sourceLines(model, offset, link, context)
    ?? featureLines(model, node, offset, link, context)
    ?? assignmentLines(model, node, offset, link, context)
    ?? metricReference(model, node, offset, link, context)
    ?? declaration(model, node, offset, link, context);
  if (!hover) return undefined;
  return { contents: { kind: MarkupKind.Markdown, value: hover.lines.join('\n') }, range: hover.range };
}

interface HoverLines { lines: string[]; range?: Range }
const at = (lines: string[], range?: Range): HoverLines => ({ lines, range });

function featureLines(model: PlanDocument, node: PlanNode, offset: number,
                      link: (label: string, range?: Range) => string, context: ResolutionContext): HoverLines | undefined {
  const name = nameToken(node);
  if ((node.kind !== 'feature' && node.kind !== 'plan') || !covers(name, offset)) return undefined;
  const values = resolveValues(model, node, context);
  const title = node.kind === 'plan' ? `**Plan** \`${name!.text}\`` : `**Feature** \`${featurePath(model, node)}\``;
  return at([title,
    ...valueTable('Attribute', values.filter(v => v.declaration.kind === 'attribute'), link),
    ...valueTable('Annotation', values.filter(v => v.declaration.kind === 'annotation'), link)], name!.range);
}

function assignmentLines(model: PlanDocument, node: PlanNode, offset: number,
                         link: (label: string, range?: Range) => string, context: ResolutionContext): HoverLines | undefined {
  if (node.kind !== 'assignment' || !covers(node.target, offset)) return undefined;
  const name = runText(node.target);
  const found = scopeOf(model, node).declarations.get(name);
  // A modifier block, or a modifier file with no plan of its own, names the
  // declarations of the plan it modifies — WS5/WS7 resolve those, so there is
  // nothing to assert about the name here.
  const elsewhere = model.insideModifier(node) || !model.enclosingOf(node, 'plan');
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

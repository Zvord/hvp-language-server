import { Hover, MarkupKind, Position, Range } from 'vscode-languageserver-types';
import { Declaration, scopeOf } from './declarations';
import { PlanDocument, PlanNode, nameToken, runText } from './planModel';
import { EffectiveValue, ResolutionContext, featurePath, resolutionScope, resolveValue, resolveValues } from './resolver';
import { Span } from './tokenizer';

const covers = (span: Span | undefined, offset: number): boolean =>
  !!span && span.start <= offset && offset <= span.end;

/** HVP strings carry backtick tags (`\`r\``), so the fence has to outrun the
 * longest backtick run in the value; a span touching one needs padding too. */
const code = (text: string): string => {
  if (!text) return '—';
  const body = text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...[...body.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
};

const signature = (declaration: Declaration): string => {
  const type = declaration.type === 'enum' && declaration.members.length
    ? `enum {${declaration.members.join(', ')}}` : declaration.type;
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
        origin.node.kind === 'assignment' ? origin.node.target.range : undefined);
  }
}

const byInterest = (a: EffectiveValue, b: EffectiveValue): number =>
  Number(a.declaration.builtin) - Number(b.declaration.builtin) || a.declaration.name.localeCompare(b.declaration.name);

function valueTable(heading: string, values: EffectiveValue[], link: (label: string, range?: Range) => string): string[] {
  if (!values.length) return [];
  return ['', `| ${heading} | Effective value | Origin |`, '| --- | --- | --- |',
    ...values.sort(byInterest).map(v => `| ${code(v.declaration.name)} | ${code(v.text)} | ${originText(v, link)} |`)];
}

function declarationLines(model: PlanDocument, declaration: Declaration,
                          link: (label: string, range?: Range) => string): string[] {
  const plan = nameToken(model.enclosingOf(declaration.node, 'plan'));
  const where = declaration.builtin ? 'built-in'
    : link(plan ? `declared in plan ${plan.text}` : 'declared in this file', declaration.range);
  // Metric goals and aggregators are WS3's to describe; only the shape is known here.
  return [`**${declaration.kind}** \`${signature(declaration)}\``, '',
    declaration.kind === 'metric' ? where : `${where} · default ${code(declaration.defaultText)}`];
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
  if (!node || model.maskedAt(offset)) return undefined;
  const link = linker(uri);
  const hover = featureLines(model, node, offset, link, context)
    ?? assignmentLines(model, node, offset, link, context)
    ?? declaration(model, node, offset, link);
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
    return at([`**metric** \`${signature(found)}\``, '', `Feature-level goal override for \`${name}\`.`], node.target.range);
  }
  // Omitted for an assignment no scope resolves (inside a measure, or a
  // modifier block): stating a value here would contradict the statement itself.
  const scope = resolutionScope(model, node);
  const effective = scope && resolveValue(model, scope, name, context);
  return at([...declarationLines(model, found, link),
    ...(effective ? ['', `Effective value here: ${code(effective.text)} (${originText(effective, link)})`] : [])],
    node.target.range);
}

function declaration(model: PlanDocument, node: PlanNode, offset: number,
                     link: (label: string, range?: Range) => string): HoverLines | undefined {
  const name = nameToken(node);
  if (node.kind !== 'attribute' && node.kind !== 'annotation' && node.kind !== 'metric') return undefined;
  if (!covers(name, offset)) return undefined;
  const found = scopeOf(model, node).declarations.get(name!.text);
  return found ? at(declarationLines(model, found, link), name!.range) : undefined;
}

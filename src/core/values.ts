import { Declaration } from './declarations';
import { TokenRun, runText } from './planModel';

/** `expression` covers anything the attribute-value BNF does not describe as a
 * literal — including `${...}` interpolation and goal-style comparisons — and is
 * never type-checked, so unmodelled forms cannot produce false positives. */
export type LiteralKind = 'integer' | 'real' | 'percent' | 'string' | 'identifier' | 'expression' | 'empty';

export interface Literal { kind: LiteralKind; text: string }

export function literal(run: TokenRun): Literal {
  const tokens = run.tokens;
  const text = runText(run);
  if (!tokens.length) return { kind: 'empty', text };
  const signed = tokens[0].text === '-' || tokens[0].text === '+';
  const token = tokens[signed ? 1 : 0];
  if (tokens.length !== (signed ? 2 : 1) || !token) return { kind: 'expression', text };
  if (token.kind === 'string') return { kind: signed ? 'expression' : 'string', text };
  if (token.kind === 'number') {
    return { kind: token.text.endsWith('%') ? 'percent' : token.text.includes('.') ? 'real' : 'integer', text };
  }
  return { kind: token.kind === 'identifier' ? 'identifier' : 'expression', text };
}

const ACCEPTS: Record<string, readonly LiteralKind[]> = {
  integer: ['integer'],
  real: ['integer', 'real'],
  string: ['string'],
};

const ARTICLE = (type: string) => (/^[aeiou]/.test(type) ? 'an' : 'a');

/**
 * Type-checks one attribute or annotation value literal.
 *
 * Returns a message, or undefined when the value is acceptable or when the
 * declared type has no settled literal shape: `set` is listed as a type but
 * never described (see HVP-LANGUAGE-SUPPORT-GAPS.md), and metric-only types
 * carry no attribute literals. Both are deliberately not checked.
 */
export function checkValue(declaration: Declaration, run: TokenRun): string | undefined {
  const value = literal(run);
  if (value.kind === 'empty') return `'${declaration.name}' needs ${ARTICLE(declaration.type)} ${declaration.type} value.`;
  if (value.kind === 'expression') return undefined;
  if (declaration.type === 'enum') {
    if (!declaration.members.length) return undefined;
    if (value.kind === 'string') return `'${declaration.name}' is an enum: expected one of ${declaration.members.join(', ')}.`;
    return declaration.members.includes(value.text) ? undefined
      : `'${value.text}' is not a member of enum '${declaration.name}': expected one of ${declaration.members.join(', ')}.`;
  }
  const accepted = ACCEPTS[declaration.type];
  if (!accepted) return undefined;
  return accepted.includes(value.kind) ? undefined
    : `'${declaration.name}' is declared ${declaration.type}, but the value is ${ARTICLE(value.kind)} ${value.kind}.`;
}

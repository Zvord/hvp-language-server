import { Span, SourceText, Token, numberKind } from './tokenizer';

/**
 * Goal expression parsing.
 *
 * A goal is the one place HVP has a real expression grammar, so unlike the
 * attribute values in `values.ts` it gets a parser rather than a literal
 * classifier. The tree is only as detailed as the documented restrictions need:
 * operand types and identifier shapes. Evaluation is a tool concern.
 */

/** The operand types a goal expression can carry. `unknown` is the honest
 * answer for an identifier no declaration explains, and suppresses every
 * operand check that would otherwise fire on it. */
export type GoalType = 'integer' | 'real' | 'percent' | 'ratio' | 'enum' | 'aggregate' | 'string' | 'boolean' | 'unknown';

export type GoalNode =
  | { kind: 'name'; span: Span; text: string }
  | { kind: 'literal'; span: Span; type: GoalType; text: string }
  | { kind: 'unary'; span: Span; op: string; operand: GoalNode }
  | { kind: 'binary'; span: Span; op: string; left: GoalNode; right: GoalNode }
  /** `match(a, b)` and friends: the BNF's string-op form, which no tool implements. */
  | { kind: 'call'; span: Span; name: string; args: GoalNode[] }
  /** `x inside {...}`, documented as unsupported. */
  | { kind: 'inside'; span: Span; operand: GoalNode }
  /** A run the parser could not read; already reported, and never checked again. */
  | { kind: 'error'; span: Span };

export interface GoalProblem { span: Span; message: string }

/** Precedence from Table 3, lowest first. `!` sits between the comparisons and
 * `&&`, so `!a == b` groups as `!(a == b)` — unusual, but what the table says.
 * Exported because the operand checks in `metricDiagnostics` classify the very
 * operators these levels accept; one table keeps the two from drifting. */
export const LOGICAL = ['||', '&&'];
export const COMPARISON = ['>', '<', '>=', '<=', '==', '!='];
export const ADDITIVE = ['+', '-'];
export const MULTIPLICATIVE = ['*', '/'];
export const ARITHMETIC = [...MULTIPLICATIVE, ...ADDITIVE];

export interface ParsedGoal { expression: GoalNode; problems: GoalProblem[] }

/**
 * Parses one goal expression out of a statement's token run.
 *
 * `fallback` is the span a problem is reported on when the run itself is empty
 * — the statement header, so an empty `goal =` still lands somewhere visible.
 */
export function parseGoal(source: SourceText, tokens: readonly Token[], fallback: Span): ParsedGoal {
  return new GoalParser(source, tokens, fallback).parse();
}

class GoalParser {
  private i = 0;
  private readonly problems: GoalProblem[] = [];
  constructor(private readonly source: SourceText, private readonly tokens: readonly Token[],
              private readonly fallback: Span) {}

  parse(): ParsedGoal {
    if (!this.tokens.length) {
      this.problems.push({ span: this.fallback, message: 'Goal expression is empty.' });
      return { expression: { kind: 'error', span: this.fallback }, problems: this.problems };
    }
    const expression = this.or();
    if (this.i < this.tokens.length) {
      this.problems.push({ span: this.spanFrom(this.i, this.tokens.length),
        message: `Unexpected '${this.tokens[this.i].text}' after the goal expression.` });
    }
    return { expression, problems: this.problems };
  }

  private peek(): Token | undefined { return this.tokens[this.i]; }
  private spanFrom(from: number, to: number): Span {
    const first = this.tokens[from], last = this.tokens[to - 1];
    return first && last ? this.source.span(first.start, last.end) : this.fallback;
  }
  private binaryLevel(next: () => GoalNode, operators: readonly string[]): GoalNode {
    let left = next();
    for (let token = this.peek(); token && operators.includes(token.text); token = this.peek()) {
      this.i++;
      const right = next();
      left = { kind: 'binary', span: this.source.span(left.span.start, right.span.end), op: token.text, left, right };
    }
    return left;
  }

  private or(): GoalNode { return this.binaryLevel(() => this.and(), ['||']); }
  private and(): GoalNode { return this.binaryLevel(() => this.not(), ['&&']); }
  private not(): GoalNode {
    const token = this.peek();
    if (token?.text !== '!') return this.comparison();
    this.i++;
    const operand = this.not();
    return { kind: 'unary', span: this.source.span(token.start, operand.span.end), op: '!', operand };
  }
  private comparison(): GoalNode { return this.binaryLevel(() => this.additive(), COMPARISON); }
  private additive(): GoalNode { return this.binaryLevel(() => this.multiplicative(), ADDITIVE); }
  private multiplicative(): GoalNode { return this.binaryLevel(() => this.postfix(), MULTIPLICATIVE); }

  /** `inside {...}` binds to the primary in front of it; the whole form is
   * unsupported, so the set contents are consumed without being read. */
  private postfix(): GoalNode {
    const operand = this.primary();
    if (this.peek()?.text !== 'inside') return operand;
    const keyword = this.tokens[this.i++];
    const end = this.skipBraces() ?? keyword.end;
    return { kind: 'inside', span: this.source.span(operand.span.start, end), operand };
  }

  /** Consumes a balanced `{ ... }` run when one starts here, returning its end
   * offset. Unbalanced input is reported and consumed to the end. */
  private skipBraces(): number | undefined {
    const start = this.peek();
    if (start?.text !== '{') return undefined;
    let depth = 0;
    for (; this.i < this.tokens.length; this.i++) {
      const text = this.tokens[this.i].text;
      if (text === '{') depth++;
      else if (text === '}' && --depth === 0) return this.tokens[this.i++].end;
    }
    this.problems.push({ span: this.source.span(start.start, this.tokens[this.tokens.length - 1].end),
      message: "Unclosed '{' in the goal expression." });
    return this.tokens[this.tokens.length - 1].end;
  }

  private primary(): GoalNode {
    const token = this.peek();
    if (!token) {
      const span = this.spanFrom(Math.max(0, this.i - 1), this.tokens.length);
      this.problems.push({ span, message: 'Goal expression ends with a missing operand.' });
      return { kind: 'error', span };
    }
    if (token.text === '-' || token.text === '+') {
      this.i++;
      const operand = this.primary();
      return { kind: 'unary', span: this.source.span(token.start, operand.span.end), op: token.text, operand };
    }
    if (token.text === '(') {
      const start = this.i;
      this.i++;
      const inner = this.or();
      const closer = this.peek();
      if (closer?.text !== ')') {
        const span = this.spanFrom(start, this.tokens.length);
        this.problems.push({ span, message: "Missing ')' in the goal expression." });
        return { kind: 'error', span };
      }
      this.i++;
      return { ...inner, span: this.source.span(token.start, closer.end) };
    }
    if (token.kind === 'number') {
      this.i++;
      return { kind: 'literal', span: token, type: numberKind(token.text), text: token.text };
    }
    if (token.kind === 'string') {
      this.i++;
      return { kind: 'literal', span: token, type: 'string', text: token.text };
    }
    if (token.kind === 'identifier') {
      const start = this.i;
      const segments = [this.tokens[this.i++].text];
      while (this.peek()?.text === '.' && this.tokens[this.i + 1]?.kind === 'identifier') {
        this.i++;
        segments.push(this.tokens[this.i++].text);
      }
      const name = segments.join('.');
      if (this.peek()?.text === '(') {
        const args = this.arguments();
        return { kind: 'call', span: this.source.span(this.tokens[start].start, args.end), name, args: args.nodes };
      }
      return { kind: 'name', span: this.source.span(this.tokens[start].start, this.tokens[this.i - 1].end), text: name };
    }
    this.i++;
    this.problems.push({ span: token, message: `Unexpected '${token.text}' in the goal expression.` });
    return { kind: 'error', span: token };
  }

  private arguments(): { nodes: GoalNode[]; end: number } {
    const open = this.tokens[this.i++];
    const nodes: GoalNode[] = [];
    while (this.i < this.tokens.length && this.peek()!.text !== ')') {
      nodes.push(this.or());
      if (this.peek()?.text === ',') this.i++;
      else break;
    }
    const closer = this.peek();
    if (closer?.text !== ')') {
      this.problems.push({ span: this.source.span(open.start, this.tokens[this.tokens.length - 1].end),
        message: "Missing ')' after the argument list." });
      return { nodes, end: this.tokens[this.tokens.length - 1].end };
    }
    this.i++;
    return { nodes, end: closer.end };
  }
}

/** Every node in the tree, parents before children. Collected into one array
 * rather than spread at each level, which re-copied the whole subtree. */
export function walkGoal(node: GoalNode, into: GoalNode[] = []): GoalNode[] {
  into.push(node);
  switch (node.kind) {
    case 'unary': case 'inside': walkGoal(node.operand, into); break;
    case 'binary': walkGoal(node.left, into); walkGoal(node.right, into); break;
    case 'call': for (const argument of node.args) walkGoal(argument, into); break;
  }
  return into;
}

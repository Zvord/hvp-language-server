import { DiagnosticSeverity, FoldingRange, Range } from 'vscode-languageserver-types';
import { BLOCK_CLOSE_KEYWORD, PairKind } from './keywords';
import { NodeBase, Parameter, PlanDocument, PlanNode, Reference, TokenRun, TypeSpec } from './planModel';
import { SourceText, Token, tokenIndexAt, tokenize } from './tokenizer';
import { metricDiagnostics } from './metricDiagnostics';
import { semanticDiagnostics } from './semanticDiagnostics';
import { structuralDiagnostics } from './structuralDiagnostics';

const openKinds = new Set(Object.keys(BLOCK_CLOSE_KEYWORD));
const closeKinds = new Map(Object.entries(BLOCK_CLOSE_KEYWORD).map(([kind, close]) => [close, kind as PairKind]));
const starters = new Set([...openKinds, 'attribute', 'annotation', 'subplan', 'keep', 'remove']);
/** Contextual statement keywords only trigger missing-semicolon recovery
 * at the head of a line, preserving declaration names for validation. */
const lineStarters = new Set(['source', 'goal', 'aggregator', 'apply']);
const branchKeywords = new Set(['elseuntil', 'else']);
const delimiterClose: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
const delimiterClosers = new Set(Object.values(delimiterClose));
const dropEquals = (tokens: readonly Token[]): readonly Token[] =>
  tokens[0]?.text === '=' ? tokens.slice(1) : tokens;
const nodeName = (node: PlanNode): string => ('name' in node ? node.name?.text : undefined) ?? '';

/** Full-document parsing is intentional for now. No semantic expression parser
 * is needed here: balanced token runs retain the source for WS2–WS4 and WS7. */
export function parseDocument(text: string): PlanDocument {
  return new Parser(text).parse();
}

class Parser {
  private readonly model: PlanDocument;
  private readonly tokens: Token[];
  private i = 0;
  private readonly stack: PlanNode[] = [];
  constructor(text: string) {
    const source = new SourceText(text);
    const lexed = tokenize(source);
    this.model = new PlanDocument(source, lexed.tokens);
    this.model.diagnostics.push(...lexed.diagnostics);
    this.tokens = lexed.tokens.filter(t => t.kind !== 'comment');
  }
  private report(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error): void {
    this.model.diagnostics.push({ range, message, severity, source: 'hvp' });
  }
  private run(tokens: readonly Token[], fallback = this.tokens[this.i]?.start ?? this.model.source.text.length): TokenRun {
    const start = tokens[0]?.start ?? fallback, end = tokens[tokens.length - 1]?.end ?? start;
    return { ...this.model.source.span(start, end), tokens, text: this.model.source.text.slice(start, end) };
  }
  private split(tokens: readonly Token[], separator = ','): Token[][] {
    const result: Token[][] = [], current: Token[] = [];
    let depth = 0;
    for (const token of tokens) {
      if (token.text === separator && depth === 0) { result.push(current.splice(0)); continue; }
      current.push(token);
      if (delimiterClose[token.text]) depth++;
      if (delimiterClosers.has(token.text)) depth--;
    }
    if (current.length) result.push(current);
    return result;
  }
  private reference(tokens: readonly Token[]): Reference {
    return { ...this.run(tokens), segments: this.split(tokens, '.').map(t => this.run(t)) };
  }
  private type(tokens: readonly Token[]): { type: TypeSpec; rest: readonly Token[] } {
    let end = Math.min(1, tokens.length);
    if (tokens[1]?.text === '{') {
      let depth = 0;
      for (end = 1; end < tokens.length; end++) {
        if (tokens[end].text === '{') depth++;
        if (tokens[end].text === '}') {
          depth--;
          if (depth === 0) { end++; break; }
        }
      }
    }
    const typeTokens = tokens.slice(0, end);
    const memberTokens = typeTokens[1]?.text === '{'
      ? typeTokens.slice(2, typeTokens[typeTokens.length - 1]?.text === '}' ? -1 : undefined) : [];
    const members = this.split(memberTokens).map(part => {
      const paren = part.findIndex(t => t.text === '(');
      const equal = part.findIndex(t => t.text === '=');
      return { name: this.run(paren < 0 ? part : part.slice(0, paren)),
        weight: equal < 0 ? undefined : this.run(part.slice(equal + 1, part[part.length - 1]?.text === ')' ? -1 : undefined)) };
    });
    return { type: { ...this.run(typeTokens), name: typeTokens[0], members }, rest: tokens.slice(end) };
  }
  private parent(): PlanNode | undefined {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === 'until' ? top.children[top.children.length - 1] : top;
  }
  private add(node: PlanNode, parent = this.parent()): void {
    node.id = this.model.nodes.length;
    node.parentId = parent?.id;
    this.model.nodes.push(node);
    (parent?.children ?? this.model.roots).push(node);
  }
  private looksLikeAssignment(index: number): boolean {
    if (this.tokens[index]?.kind !== 'identifier' && !['*', '**', '?'].includes(this.tokens[index]?.text)) return false;
    let j = index + 1;
    while (['.', '*', '**', '?'].includes(this.tokens[j]?.text)) {
      if (this.tokens[j++].text === '.' && this.tokens[j]?.kind === 'identifier') j++;
    }
    return this.tokens[j]?.text === '=';
  }
  private boundary(index: number): boolean {
    const token = this.tokens[index];
    return token?.kind === 'identifier' && (openKinds.has(token.text) || closeKinds.has(token.text) ||
      branchKeywords.has(token.text) || starters.has(token.text) || this.looksLikeAssignment(index));
  }
  private statement(): { tokens: Token[]; header: TokenRun; incomplete: boolean } {
    const start = this.i, delimiters: Token[] = [];
    let semicolon: Token | undefined;
    let hasAssignment = false;
    while (this.i < this.tokens.length) {
      const token = this.tokens[this.i];
      if (token.text === ';') { semicolon = token; this.i++; break; }
      const previous = this.tokens[this.i - 1];
      const opensLine = this.i > start && token.range.start.line > previous.range.end.line;
      const starter = starters.has(token.text) || (opensLine && lineStarters.has(token.text));
      const nameBeforeTerminator = [';', '='].includes(this.tokens[this.i + 1]?.text) && (
        (['plan', 'feature', 'override', 'filter', 'subplan'].includes(this.tokens[start].text) && this.i === start + 1) ||
        (['attribute', 'annotation', 'metric'].includes(this.tokens[start].text) &&
          this.type(this.tokens.slice(start + 1, this.i)).rest.length === 0) ||
        (this.tokens[start].text === 'measure' && this.i === start + 2));
      if (this.i > start && !nameBeforeTerminator && this.boundary(this.i) &&
        (!this.looksLikeAssignment(this.i) || hasAssignment || starter || closeKinds.has(token.text))) {
        // Inside a balanced list, parameter assignments and keywords are data.
        // A block boundary, or a fresh statement on a later line, recovers an
        // unfinished list without consuming the rest of the document.
        const hardBoundary = closeKinds.has(token.text) || branchKeywords.has(token.text) || (starter && opensLine);
        if (hardBoundary ||
          (!delimiters.length && this.i > start + 1 && !['=', '.', ',', '#'].includes(previous.text))) break;
      }
      if (token.text === '=' && delimiters.length === 0) hasAssignment = true;
      if (delimiterClose[token.text]) delimiters.push(token);
      else if (delimiterClosers.has(token.text)) {
        const opener = delimiters.pop();
        if (!opener || delimiterClose[opener.text] !== token.text) {
          this.report(token.range, `Unexpected delimiter '${token.text}'.`);
        }
      }
      this.i++;
    }
    const tokens = this.tokens.slice(start, semicolon ? this.i - 1 : this.i);
    for (const opener of delimiters) this.report(opener.range, `Unclosed '${opener.text}': missing '${delimiterClose[opener.text]}'.`);
    const header = this.run(semicolon ? [...tokens, semicolon] : tokens);
    if (!semicolon) {
      const last = tokens[tokens.length - 1];
      // Retain the old masked-line anchor for a trailing string literal.
      const anchor = last?.kind === 'string' ? tokens[tokens.length - 2] ?? last : last;
      this.report(this.model.source.span(Math.max(header.start, (anchor?.end ?? header.end) - 1), anchor?.end ?? header.end).range,
        "Statement is missing a terminating semicolon (';').");
    }
    return { tokens, header, incomplete: !semicolon || delimiters.length > 0 };
  }
  /** Preserve the complete candidate, including illegal punctuation, for diagnostics. */
  private name(tokens: readonly Token[]): Token | undefined {
    if (!tokens.length) return undefined;
    return { ...tokens[0], ...this.run(tokens) };
  }
  private makeNode(tokens: Token[], base: NodeBase): PlanNode {
    const [first, ...tail] = tokens;
    const keyword = first.text;
    switch (keyword) {
      case 'plan': case 'feature': case 'override': case 'filter':
        return { ...base, kind: keyword, name: this.name(tail) };
      case 'attribute': case 'annotation': case 'metric': {
        const { type, rest } = this.type(tail);
        if (keyword === 'metric') return { ...base, kind: keyword, name: this.name(rest), type };
        const equal = rest.findIndex(t => t.text === '=');
        return { ...base, kind: keyword, name: this.name(equal < 0 ? rest : rest.slice(0, equal)), type, value: this.run(equal < 0 ? [] : rest.slice(equal + 1), base.header.end) };
      }
      case 'measure': {
        let nameStart = 0;
        do {
          nameStart++;
          while (tail[nameStart]?.text === '.' && tail[nameStart + 1]) nameStart += 2;
          if (tail[nameStart]?.text !== ',') break;
          nameStart++;
        } while (nameStart < tail.length);
        return { ...base, kind: keyword, name: this.name(tail.slice(nameStart)),
          metrics: this.split(tail.slice(0, nameStart)).map(t => this.reference(t)) };
      }
      case 'subplan': {
        const hash = tail.findIndex(t => t.text === '#');
        const parameterTokens = hash < 0 ? [] : tail.slice(hash + 2, tail[tail.length - 1]?.text === ')' ? -1 : undefined);
        const parameters: Parameter[] = this.split(parameterTokens).map(part => {
          const equal = part.findIndex(t => t.text === '=');
          return { ...this.run(part), name: this.run(equal < 0 ? part : part.slice(0, equal)),
            value: this.run(equal < 0 ? [] : part.slice(equal + 1), part[part.length - 1]?.end) };
        });
        return { ...base, kind: keyword, name: this.name(hash < 0 ? tail : tail.slice(0, hash)), parameters };
      }
      case 'until': return { ...base, kind: 'until' };
      case 'source':
        return { ...base, kind: keyword, values: this.split(dropEquals(tail)).map(t => this.run(t)) };
      case 'goal': case 'aggregator': case 'apply':
        return { ...base, kind: keyword, value: this.run(dropEquals(tail), base.header.end) };
      case 'keep': case 'remove': {
        const where = tail.findIndex(t => t.text === 'where');
        return { ...base, kind: keyword, condition: this.run(where < 0 ? tail : tail.slice(where + 1), base.header.end) };
      }
      default: {
        const equal = tokens.findIndex(t => t.text === '=');
        if (equal >= 0) return { ...base, kind: 'assignment', target: this.reference(tokens.slice(0, equal)), value: this.run(tokens.slice(equal + 1), base.header.end) };
        return { ...base, kind: 'unknown', tokens: this.run(tokens) };
      }
    }
  }
  private finish(node: PlanNode, end: number): void {
    Object.assign(node, this.model.source.span(node.start, end));
    if (node.kind === 'until') {
      const branch = node.children[node.children.length - 1];
      if (branch) Object.assign(branch, this.model.source.span(branch.start, node.close?.start ?? end));
    }
  }
  private diagnosticRange(node: PlanNode): Range {
    const line = node.range.start.line;
    const lineEnd = this.model.source.lineEnd(line);
    let sharesLine = false;
    for (let j = tokenIndexAt(this.tokens, this.model.source.lineStarts[line]);
         j < this.tokens.length && this.tokens[j].start < lineEnd; j++) {
      const start = this.tokens[j].start;
      if (start < node.header.start || start >= node.header.end) { sharesLine = true; break; }
    }
    return sharesLine || node.header.range.end.line !== line
      ? node.header.range : this.model.source.lineRange(line);
  }
  private close(token: Token, kind: PairKind): void {
    const top = this.stack.pop();
    if (!top) {
      this.report(token.range, `Unexpected '${token.text}': no matching '${kind}' block is open here.`); return;
    }
    if (top.kind !== kind) {
      top.incomplete = true;
      this.finish(top, token.end);
      this.report(token.range, `Mismatched close: expected '${BLOCK_CLOSE_KEYWORD[top.kind as PairKind]}' to close '${top.kind}' opened at line ${top.range.start.line + 1}, but found '${token.text}'.`);
      return;
    }
    // Set before finish(): an `until` block ends its last branch at `close.start`.
    top.close = token;
    this.finish(top, token.end);
    if (kind === 'feature' && !top.children.some(n => ['feature', 'measure', 'subplan'].includes(n.kind))) {
      this.report(this.diagnosticRange(top), `Feature '${nodeName(top)}' is empty: it has no nested features or measures.`, DiagnosticSeverity.Warning);
    }
    if (kind === 'measure' && !top.children.some(n => n.kind === 'source')) {
      this.report(this.diagnosticRange(top), `Measure '${nodeName(top)}' has no source.`, DiagnosticSeverity.Warning);
    }
    if (token.range.start.line > top.range.start.line) this.model.foldingRanges.push(FoldingRange.create(top.range.start.line, token.range.start.line));
  }
  parse(): PlanDocument {
    while (this.i < this.tokens.length) {
      const token = this.tokens[this.i];
      const closeKind = closeKinds.get(token.text);
      if (closeKind) { this.i++; this.close(token, closeKind); continue; }
      const { tokens, header, incomplete } = this.statement();
      if (!tokens.length) { this.report(header.range, 'Unexpected semicolon.'); continue; }
      const base: NodeBase = { ...header, id: -1, header, children: [], incomplete };
      if (branchKeywords.has(token.text)) {
        const top = this.stack[this.stack.length - 1];
        if (top?.kind !== 'until') {
          this.report(token.range, `Unexpected '${token.text}': no matching 'until' block is open here.`);
          this.add({ ...base, kind: 'unknown', tokens: this.run(tokens) });
        } else {
          const previous = top.children[top.children.length - 1];
          Object.assign(previous, this.model.source.span(previous.start, token.start));
          this.add({ ...base, kind: 'branch', branchKind: token.text as 'elseuntil' | 'else',
            date: token.text === 'else' ? undefined : this.run(tokens.slice(1)) }, top);
        }
        continue;
      }
      const node = this.makeNode(tokens, base);
      this.add(node);
      if (openKinds.has(node.kind)) {
        this.stack.push(node);
        if (node.kind === 'until') this.add({ ...base, children: [], kind: 'branch', branchKind: 'until', date: this.run(tokens.slice(1)) }, node);
      }
    }
    for (const node of this.stack) {
      node.incomplete = true;
      this.finish(node, this.model.source.text.length);
      this.report(this.diagnosticRange(node), `Unclosed '${node.kind}' block: missing '${BLOCK_CLOSE_KEYWORD[node.kind as PairKind]}'.`);
    }
    this.model.diagnostics.push(...structuralDiagnostics(this.model), ...semanticDiagnostics(this.model),
      ...metricDiagnostics(this.model));
    return this.model;
  }
}

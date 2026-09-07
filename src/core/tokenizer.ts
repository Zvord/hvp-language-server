import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver-types';

/** Offsets and LSP characters are UTF-16 code units; ends are exclusive. */
export interface Span { start: number; end: number; range: Range }
export interface Token extends Span {
  kind: 'identifier' | 'number' | 'string' | 'comment' | 'punctuation';
  text: string;
  terminated?: boolean;
}

/** Index of the first token starting at or after `offset`; tokens are ordered. */
export function tokenIndexAt(tokens: readonly Token[], offset: number): number {
  let lo = 0, hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tokens[mid].start < offset) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class SourceText {
  readonly lineStarts = [0];
  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\r') {
        if (text[i + 1] === '\n') i++;
        this.lineStarts.push(i + 1);
      } else if (text[i] === '\n') this.lineStarts.push(i + 1);
    }
  }
  positionAt(offset: number): Position {
    offset = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0, hi = this.lineStarts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lineStarts[mid] <= offset) lo = mid; else hi = mid;
    }
    return Position.create(lo, offset - this.lineStarts[lo]);
  }
  offsetAt(position: Position): number {
    const line = Math.max(0, Math.min(position.line, this.lineStarts.length - 1));
    const end = this.lineStarts[line + 1] ?? this.text.length;
    return Math.min(this.lineStarts[line] + Math.max(0, position.character), end);
  }
  span(start: number, end: number): Span {
    return { start, end, range: Range.create(this.positionAt(start), this.positionAt(end)) };
  }
  /** Offset of the line's last character, excluding its newline. */
  lineEnd(line: number): number {
    const start = this.lineStarts[line] ?? this.text.length;
    let end = this.lineStarts[line + 1] ?? this.text.length;
    while (end > start && /[\r\n]/.test(this.text[end - 1])) end--;
    return end;
  }
  lineRange(line: number): Range {
    return this.span(this.lineStarts[line], this.lineEnd(line)).range;
  }
  lineText(line: number): string {
    const start = this.lineStarts[line];
    return start === undefined ? '' : this.text.slice(start, this.lineEnd(line));
  }
}

export function tokenize(source: SourceText): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const text = source.text;
  const tokens: Token[] = [], diagnostics: Diagnostic[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const start = i;
    let kind: Token['kind'] = 'punctuation';
    let terminated: boolean | undefined;
    if (text.startsWith('//', i)) {
      kind = 'comment'; i += 2;
      while (i < text.length && !/[\r\n]/.test(text[i])) i++;
    } else if (text.startsWith('/*', i)) {
      kind = 'comment';
      const end = text.indexOf('*/', i + 2);
      terminated = end !== -1; i = terminated ? end + 2 : text.length;
    } else if (text[i] === '"') {
      kind = 'string'; i++; terminated = false;
      while (i < text.length) {
        if (text[i] === '\\') { i = Math.min(i + 2, text.length); continue; }
        if (text[i++] === '"') { terminated = true; break; }
      }
    } else if (/[A-Za-z_]/.test(text[i])) {
      kind = 'identifier'; i++;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
    } else if (/[0-9]/.test(text[i])) {
      kind = 'number'; i++;
      while (i < text.length && /[0-9]/.test(text[i])) i++;
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
        i++; while (i < text.length && /[0-9]/.test(text[i])) i++;
      }
      if (text[i] === '%') i++;
    } else {
      i += ['>=', '<=', '==', '!=', '&&', '||', '**'].includes(text.slice(i, i + 2)) ? 2 : 1;
    }
    const token: Token = { ...source.span(start, i), kind, text: text.slice(start, i), terminated };
    tokens.push(token);
    if (terminated === false) diagnostics.push({ range: token.range, severity: DiagnosticSeverity.Error,
      source: 'hvp', message: kind === 'string' ? 'Unterminated string literal.' : 'Unterminated block comment.' });
  }
  return { tokens, diagnostics };
}

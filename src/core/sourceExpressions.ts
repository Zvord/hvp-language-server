/**
 * WS4: the contents of a `source = "..."` string.
 *
 * A source string is its own little language sitting inside a string literal:
 * an optional keyword prefix, then a pattern made of literal text, simplified
 * wildcards, POSIX extended regular expressions delimited by backtick tags, an
 * optional removal expression, and `${name}` interpolations.
 *
 * Indices on the parts are into the *decoded* literal; `expression.spanAt(from,
 * to)` maps any decoded slice to a document `Span`, which is not
 * `body.start + from`: an escape sequence is two characters in the document and
 * one after decoding. Every consumer that needs an LSP range goes through it,
 * so the decoded→document mapping has exactly one definition.
 *
 * Imports `keywords` and `tokenizer`, plus `planModel` **types only** — so it
 * still holds no runtime dependency on the document model.
 */
import { SOURCE_KEYWORDS, SOURCE_MASK_WORDS, SOURCE_TAGS, SOURCE_WILDCARDS, SourceKeywordInfo } from './keywords';
import type { PlanDocument, PlanNode, TokenRun } from './planModel';
import { SourceText, Span, Token, covers, tokenIndexAt } from './tokenizer';

export type SourcePartKind =
  /** The keyword prefix, including its `:` and any `'h###` mask. */
  | 'keyword'
  /** Literal text matched character for character. */
  | 'literal'
  /** `?`, `*` or `**` in wildcard mode. */
  | 'wildcard'
  /** A `` `r` ``, `` `n` `` or `` `-` `` tag. */
  | 'tag'
  /** Text that the tool reads as a POSIX ERE (after a `` `r` `` tag). */
  | 'regex'
  /** `${name}`. */
  | 'interpolation';

/** A decoded half-open slice `[start, end)` of the literal's contents. Plain
 * indices, not a `Span`: `expression.spanAt(part.start, part.end)` is how a
 * consumer gets the document range, and computing one eagerly for every part of
 * every literal would pay for ranges nobody asks for. */
export interface SourcePart {
  kind: SourcePartKind;
  start: number;
  end: number;
  /** Decoded text of this part, as the tool would see it. */
  text: string;
}

export interface SourceMask {
  /** `categoryMask` or `severityMask`, as written. */
  word: string;
  /** The `'h###` literal, as written; empty when the prefix omits its value. */
  value: string;
}

export interface SourceKeyword extends Span {
  /** Table 4 entry this keyword resolves to; `info.name` is its canonical,
   * space-normalised spelling (`group instance bin`, `property`, …). */
  info: SourceKeywordInfo;
  /** Span of the keyword words alone, without the `:` or the mask. */
  wordsSpan: Span;
  mask?: SourceMask;
}

export interface Interpolation extends Span {
  /** The name between `${` and `}`, trimmed; `''` when the braces are empty. */
  name: string;
  /** Span of the name alone, so completion can replace just what was typed. */
  nameSpan: Span;
  /** False when the `${` has no closing `}` inside the literal. */
  terminated: boolean;
}

/** A maximal run of text the tool reads as one regular expression: everything
 * between a `` `r` `` tag and the next `` `n` `` or `` `-` `` tag, or the end of
 * the string. `interpolated` runs are never validated — the substituted value
 * could supply any part of the expression. */
export interface RegexRun {
  text: string;
  /** Index of the run's first character in the decoded body, so a problem found
   * at an index into `text` maps back with `expression.spanAt`. */
  textStart: number;
  interpolated: boolean;
}

export interface SourceExpression {
  /** The string literal token, quotes included. */
  literal: Span;
  /** The decoded contents. */
  text: string;
  keyword?: SourceKeyword;
  /** Everything after the keyword prefix, decoded and untrimmed. */
  pattern: string;
  parts: SourcePart[];
  interpolations: Interpolation[];
  regexRuns: RegexRun[];
  /** True when the expression carries a `` `-` `` removal expression. */
  hasRemoval: boolean;
  /** The document span of the decoded slice `[from, to)`. */
  spanAt(from: number, to: number): Span;
}

/** Longest first, so `group instance bin` is tried before `group instance`. */
const KEYWORD_WORDS: readonly (readonly string[])[] = SOURCE_KEYWORDS
  .filter(k => !k.mask)
  .map(k => k.name.split(' '))
  .sort((a, b) => b.length - a.length);

/** Case-insensitive on the mask word alone: Table 4 writes `categoryMask` and
 * the prose below it writes `categorymask`. */
const keywordInfo = (name: string): SourceKeywordInfo | undefined =>
  SOURCE_KEYWORDS.find(k => k.name === name) ??
  SOURCE_KEYWORDS.find(k => k.mask && k.name.toLowerCase() === name.toLowerCase());

const isCompleteKeyword = (words: readonly string[]): boolean =>
  KEYWORD_WORDS.some(candidate => candidate.length === words.length && candidate.every((w, i) => w === words[i]));

const extendsKeyword = (words: readonly string[]): boolean =>
  KEYWORD_WORDS.some(candidate => candidate.length >= words.length && words.every((w, i) => candidate[i] === w));

const isMaskWord = (text: string): boolean =>
  SOURCE_MASK_WORDS.some(word => word.toLowerCase() === text.toLowerCase());

/** The tag letter → the mode it switches the reader into. Which tags exist is
 * `keywords.ts`'s table (the grammar generator scopes the same three); what each
 * one means is this module's reading of the chapter. */
const TAGS: ReadonlyMap<string, 'regex' | 'wildcard' | 'removal'> = new Map(
  SOURCE_TAGS.map(tag => {
    const letter = tag.slice(1, -1);
    return [letter, letter === 'r' ? 'regex' : letter === '-' ? 'removal' : 'wildcard'] as const;
  }));

/** Longest first, so `**` is matched before the `*` that prefixes it. */
const WILDCARDS: readonly string[] = [...SOURCE_WILDCARDS].sort((a, b) => b.length - a.length);

/**
 * The two escapes a `"..."` literal's contents collapse.
 *
 * Exactly the two the document tokenizer had to consume to find the closing
 * quote, and nothing more: the language documents no escape table, and a
 * regular expression's own `\.` must survive into the pattern. One definition,
 * applied character by character by `decodeLiteral` (which needs to keep track
 * of where each decoded character came from) and whole-string by
 * `unescapeLiteralText`.
 */
const LITERAL_ESCAPE = /\\(["\\])/;
const LITERAL_ESCAPES = new RegExp(LITERAL_ESCAPE.source, 'g');

/** A literal's contents with `\"` and `\\` collapsed. */
export const unescapeLiteralText = (raw: string): string => raw.replace(LITERAL_ESCAPES, '$1');

/**
 * The decoded→document offset mapping for one literal.
 *
 * A literal with no `\"` or `\\` to collapse — nearly all of them — maps by
 * arithmetic: decoded index `i` came from `base + i`. Only a literal that
 * actually collapsed something needs the per-character table, so the common case
 * stores one integer instead of an array of boxed numbers.
 */
class DecodedSpans {
  constructor(private readonly source: SourceText, private readonly base: number,
              private readonly length: number, private readonly offsets?: readonly number[]) {}
  private offsetOf(index: number): number {
    const clamped = Math.max(0, Math.min(index, this.length));
    return this.offsets ? this.offsets[clamped] : this.base + clamped;
  }
  readonly span = (from: number, to: number): Span =>
    this.source.span(this.offsetOf(from), this.offsetOf(to));
}

interface Decoded { text: string; spans: DecodedSpans }

/** The literal's contents, decoded, with the mapping back to the document. */
function decodeLiteral(source: SourceText, token: Token): Decoded {
  const raw = token.text;
  const closed = token.terminated !== false && raw.length > 1 && raw.endsWith('"');
  const end = closed ? raw.length - 1 : raw.length;
  // The guard names `\"` and `\\` specifically, not any backslash: a regular
  // expression's own `\.` decodes to itself and must stay on this path.
  if (!LITERAL_ESCAPE.test(raw)) {
    const text = raw.slice(1, end);
    return { text, spans: new DecodedSpans(source, token.start + 1, text.length) };
  }
  const chars: string[] = [], offsets: number[] = [];
  for (let i = 1; i < end; i++) {
    const next = raw[i + 1];
    if (raw[i] === '\\' && i + 1 < end && (next === '"' || next === '\\')) {
      chars.push(next); offsets.push(token.start + i); i++;
      continue;
    }
    chars.push(raw[i]); offsets.push(token.start + i);
  }
  // `offsets[text.length]` is the exclusive end, so `offsets[i]` and `offsets[j]`
  // bound the decoded slice `[i, j)`.
  offsets.push(token.start + end);
  const text = chars.join('');
  return { text, spans: new DecodedSpans(source, token.start + 1, text.length, offsets) };
}

interface PrefixItem { kind: 'word' | 'colon' | 'mask'; text: string; start: number; end: number }

/** The prefix region, item by item, stopping at the first character that can
 * never belong to a keyword prefix. `::` is a scope separator in the Synopsys
 * database, never a keyword's colon, so it ends the scan. */
function prefixItems(text: string): PrefixItem[] {
  const items: PrefixItem[] = [];
  let i = 0;
  // Every branch either consumes a character or breaks, so the scan terminates
  // on its own; the longest legal prefix is four items anyway.
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    const start = i;
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
    if (word) { i += word.length; items.push({ kind: 'word', text: word, start, end: i }); continue; }
    if (text[i] === ':') {
      if (text[i + 1] === ':') break;
      i++; items.push({ kind: 'colon', text: ':', start, end: i }); continue;
    }
    if (text[i] === "'" && (text[i + 1] === 'h' || text[i + 1] === 'H')) {
      i += 2;
      while (/[0-9A-Fa-f]/.test(text[i] ?? '')) i++;
      items.push({ kind: 'mask', text: text.slice(start, i), start, end: i });
      continue;
    }
    break;
  }
  return items;
}

/**
 * The keyword prefix, or undefined when the string carries none.
 *
 * A name that is not one of Table 4's keywords produces no keyword and no
 * diagnostic: a keywordless userdata region is legal and may contain colons of
 * its own, so there is nothing here to be confident about.
 *
 * A colon ends the keyword words. `group: instance.cp1` therefore names a
 * covergroup called `instance`, not the `group instance` keyword. The one
 * exception is the mask word of `property`, which Table 4 writes after the
 * colon (`property: categoryMask 'h123`) while the work plan writes it before
 * (`property categoryMask 'h123:`) — both are accepted, since the chapter
 * contradicts itself and either reading is a guess.
 *
 * `span` is the caller's decoded→document mapping, passed in rather than rebuilt
 * here: that mapping is this module's central invariant and has one definition.
 */
function parseKeyword(text: string, span: (from: number, to: number) => Span):
    { keyword?: SourceKeyword; patternStart: number } {
  const items = prefixItems(text);
  const words: string[] = [];
  let wordsEnd = -1, afterColon = false, lastEnd = -1;
  let maskWord: PrefixItem | undefined, mask: PrefixItem | undefined;
  for (const item of items) {
    if (item.kind === 'word') {
      if (!afterColon && extendsKeyword([...words, item.text])) {
        words.push(item.text); wordsEnd = item.end; lastEnd = item.end; continue;
      }
      if (words.join(' ') === 'property' && !maskWord && isMaskWord(item.text)) {
        maskWord = item; lastEnd = item.end; continue;
      }
      break;
    }
    if (item.kind === 'mask') {
      if (!maskWord || mask) break;
      mask = item; lastEnd = item.end; continue;
    }
    // A colon only ends a complete keyword; `grou:` is not `group:`.
    if (!isCompleteKeyword(words)) break;
    afterColon = true; lastEnd = item.end;
  }
  // A prefix with no colon is not a prefix, and a mask word with no `'h###`
  // value is a shape the chapter never shows — neither is guessed at.
  if (!afterColon || !isCompleteKeyword(words) || (maskWord && !mask)) return { patternStart: 0 };
  const info = keywordInfo(maskWord ? `property ${maskWord.text}` : words.join(' '));
  if (!info) return { patternStart: 0 };
  return {
    keyword: {
      ...span(items[0].start, lastEnd),
      info,
      wordsSpan: span(items[0].start, wordsEnd),
      mask: maskWord && mask ? { word: maskWord.text, value: mask.text } : undefined,
    },
    patternStart: lastEnd,
  };
}

/**
 * Parses one `source` string literal.
 *
 * Wildcard mode is the default; a `` `r` `` tag switches to regex mode and
 * `` `n` `` switches back. A `` `-` `` tag opens the removal expression and also
 * returns to wildcard mode: the chapter states that the effect of `` `r` `` does
 * not span the `-` operator.
 */
export function parseSourceExpression(source: SourceText, token: Token): SourceExpression {
  const { text, spans } = decodeLiteral(source, token);
  const span = spans.span;
  const { keyword, patternStart } = parseKeyword(text, span);

  const parts: SourcePart[] = [];
  const interpolations: Interpolation[] = [];
  const regexRuns: RegexRun[] = [];
  let hasRemoval = false;
  if (keyword) parts.push({ kind: 'keyword', start: 0, end: patternStart, text: text.slice(0, patternStart) });

  let mode: 'wildcard' | 'regex' = 'wildcard';
  let pending = patternStart;   // start of the literal/regex run being accumulated
  let runStart = -1;            // start of the regex run in progress, in regex mode
  let runInterpolated = false;

  const part = (kind: SourcePartKind, start: number, end: number): void => {
    parts.push({ kind, start, end, text: text.slice(start, end) });
  };
  const flush = (at: number): void => {
    if (at <= pending) { pending = at; return; }
    part(mode === 'regex' ? 'regex' : 'literal', pending, at);
    pending = at;
  };
  /** Closes the regex run open since the last `` `r` `` tag. */
  const endRun = (at: number): void => {
    if (runStart === -1) return;
    regexRuns.push({ text: text.slice(runStart, at), textStart: runStart, interpolated: runInterpolated });
    runStart = -1; runInterpolated = false;
  };

  let i = patternStart;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      flush(i);
      const close = text.indexOf('}', i + 2);
      const end = close === -1 ? text.length : close + 1;
      const nameStart = i + 2, nameEnd = close === -1 ? text.length : close;
      interpolations.push({
        ...span(i, end),
        name: text.slice(nameStart, nameEnd).trim(),
        nameSpan: span(nameStart, nameEnd),
        terminated: close !== -1,
      });
      part('interpolation', i, end);
      if (runStart !== -1) runInterpolated = true;
      i = pending = end;
      continue;
    }
    const tag = text[i] === '`' && text[i + 2] === '`' ? TAGS.get(text[i + 1]) : undefined;
    if (tag) {
      flush(i);
      endRun(i);
      part('tag', i, i + 3);
      if (tag === 'removal') { hasRemoval = true; mode = 'wildcard'; }
      else mode = tag;
      i = pending = i + 3;
      if (mode === 'regex') runStart = i;
      continue;
    }
    if (mode === 'wildcard') {
      if (text[i] === '\\' && i + 1 < text.length) { i += 2; continue; }
      const wildcard = WILDCARDS.find(w => text.startsWith(w, i));
      if (wildcard) {
        flush(i);
        part('wildcard', i, i + wildcard.length);
        i = pending = i + wildcard.length;
        continue;
      }
    }
    i++;
  }
  flush(text.length);
  endRun(text.length);

  return {
    literal: source.span(token.start, token.end),
    text,
    keyword,
    pattern: text.slice(patternStart),
    parts,
    interpolations,
    regexRuns,
    hasRemoval,
    spanAt: span,
  };
}

/**
 * The single string literal a `source` value run holds, or undefined when the
 * run is anything else — an identifier, several tokens. Nothing is asserted
 * about a shape the parser could not reduce to one string.
 *
 * Terminated-ness is deliberately not part of it: see `isTerminated`.
 */
export function sourceLiteral(run: TokenRun): Token | undefined {
  const [token] = run.tokens;
  return run.tokens.length === 1 && token.kind === 'string' ? token : undefined;
}

/**
 * Whether a literal actually closed. (`terminated` is `undefined` on the token
 * kinds the question does not apply to, so the test is against `false`.)
 *
 * The second half of "is this a source string literal", named rather than folded
 * into `sourceLiteral`, because the two callers want opposite answers: an
 * unterminated literal already carries a syntax error and its contents are
 * whatever happened to follow on the line, so the diagnostics pass says nothing
 * about them — while hover and completion do answer inside one, since that is
 * exactly where the caret is while the string is being typed.
 */
export const isTerminated = (token: Token): boolean => token.terminated !== false;

/** A `source` statement's string literal, with the measure holding it. */
export interface SourceLiteral {
  measure: PlanNode & { kind: 'measure' };
  statement: PlanNode & { kind: 'source' };
  token: Token;
}

/**
 * Every `source = "..."` literal in document order — the whole document, or just
 * the measure passed as `within`.
 *
 * A generator: a measure with no `source` child costs nothing, which most of
 * them are. Deliberately uncached, and the expressions are deliberately not
 * parsed here — a caller that only wants the tokens (WS6's definition lookup,
 * WS8c's semantic tokens) should not pay for a parse it throws away. Nothing is
 * filtered out either: which literals a caller is willing to speak about is the
 * caller's rule (`model.checkable`, terminated-ness), stated where it applies.
 */
export function* sourceLiterals(model: PlanDocument, within?: PlanNode): Generator<SourceLiteral> {
  for (const measure of (within ? [within] : model.nodes)) {
    if (measure.kind !== 'measure') continue;
    for (const statement of measure.children) {
      if (statement.kind !== 'source') continue;
      for (const run of statement.values) {
        const token = sourceLiteral(run);
        if (token) yield { measure, statement, token };
      }
    }
  }
}

/** A `source` statement's string literal, located by document offset. */
export interface SourceStringContext {
  statement: PlanNode & { kind: 'source' };
  token: Token;
  expression: SourceExpression;
}

/**
 * The `source` string literal `offset` sits in, parsed.
 *
 * Inclusive at both ends of the literal, like `covers`, so a hover with the
 * caret on either quote still answers. Callers that need the caret strictly
 * inside the quotes — completion — test that themselves.
 *
 * The *token* is found first, by binary search over the offset-ordered token
 * stream: the enclosing-node scan is linear in the document, and running it on
 * every hover and completion request only to discover the caret is not in a
 * string is the one thing this lookup must not do.
 */
export function sourceStringAt(model: PlanDocument, offset: number): SourceStringContext | undefined {
  const { tokens } = model;
  const index = tokenIndexAt(tokens, offset);
  // The caret is in the token before `index` (the usual case) or on the opening
  // quote of the one at it. The earlier is preferred, matching the old scan over
  // a statement's values, for the caret between two adjacent literals.
  const token = [tokens[index - 1], tokens[index]].find(t => t?.kind === 'string' && covers(t, offset));
  if (!token) return undefined;
  const statement = model.nodeAt(token.start);
  if (statement?.kind !== 'source') return undefined;
  const run = statement.values.find(value => value.tokens[0] === token);
  if (!run || !sourceLiteral(run)) return undefined;
  return { statement, token, expression: parseSourceExpression(model.source, token) };
}

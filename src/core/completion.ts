import { CompletionItem, CompletionItemKind, InsertTextFormat, Position, Range, TextEdit } from 'vscode-languageserver-types';
import { Declaration, DeclarationKind, fieldsOf, scopeAt, scopeOf } from './declarations';
import { PlanDocument } from './planModel';
import { interpolationTargets } from './resolver';
import { isTerminated, sourceStringAt } from './sourceExpressions';
import { Token, covers, tokenIndexAt } from './tokenizer';
import {
  AGGREGATOR_NAMES,
  BLOCK_CLOSE_KEYWORD,
  BLOCK_OPEN_KEYWORD,
  BLOCK_SNIPPET_BODY,
  BUILTIN_FIELDS,
  KeywordInfo,
  NON_PAIRED_KEYWORDS,
  OBJPATH,
  PairKind,
  SOURCE_KEYWORDS,
  SourceKeywordInfo,
  TYPE_KEYWORDS,
} from './keywords';

const TOKEN_CHAR = /[A-Za-z0-9_.]/;

function findTokenStart(lineText: string, col: number): number {
  let start = col;
  while (start > 0 && TOKEN_CHAR.test(lineText[start - 1])) {
    start--;
  }
  return start;
}

const TOP_LEVEL_BLOCKS: (PairKind | undefined)[] = [undefined, 'plan', 'feature'];

/** The `detail` line a declared attribute or annotation carries, wherever it is
 * offered: byte for byte the same in a statement body and inside a `${...}`. */
const fieldDetail = (kind: DeclarationKind, declaration: Declaration): string =>
  `Declared ${kind}: ${declaration.type}${declaration.defaultText ? ` (default ${declaration.defaultText})` : ''}`;

/** Tokens that may sit between a metric list's opener and the cursor: the
 * names themselves, their separators, and an `aggregate` member's weight. */
const METRIC_LIST_TOKENS = new Set(['.', ',', '(', ')', '=']);

/** Index of the last token before `offset` that the cursor is not itself
 * typing, skipping comments. The literal or name being typed sits under the
 * cursor, so `typed` names the kinds to step over when it does. */
function tokenBefore(tokens: readonly Token[], offset: number, typed: readonly Token['kind'][]): number {
  const skipComments = (i: number) => { while (i >= 0 && tokens[i].kind === 'comment') i--; return i; };
  let i = skipComments(tokenIndexAt(tokens, offset) - 1);
  if (i >= 0 && typed.includes(tokens[i].kind) && tokens[i].end >= offset) i = skipComments(i - 1);
  return i;
}

/**
 * True where a metric name belongs: the metric list of a `measure` statement,
 * or the member list of an `aggregate {...}` type.
 *
 * Read backwards off the token stream rather than the current line, so a list
 * broken over several lines still completes. The list continues only directly
 * after its opener or a comma; past the last name the `measure` name is being
 * typed, and no metric belongs there.
 */
function metricReferencePosition(model: PlanDocument, offset: number): boolean {
  const tokens = model.tokens;
  let i = tokenBefore(tokens, offset, ['identifier']);
  if (!['measure', '{', ','].includes(tokens[i]?.text)) return false;
  for (; i >= 0; i--) {
    while (i >= 0 && tokens[i].kind === 'comment') i--;
    const token = tokens[i];
    if (!token) break;
    if (token.text === 'measure') return true;
    if (token.text === '{') return tokens[i - 1]?.text === 'aggregate';
    if (token.kind !== 'identifier' && token.kind !== 'number' && !METRIC_LIST_TOKENS.has(token.text)) return false;
  }
  return false;
}

/**
 * The name whose assigned value the cursor sits in, or undefined when the
 * cursor is not in a value position.
 *
 * Read off the token stream rather than the current line, so a newline or a
 * comment between `=` and the cursor makes no difference — WS0 accepts both
 * layouts. The literal being typed sits under the cursor, so step over it
 * before looking for the `=`.
 */
function assignmentTargetAt(model: PlanDocument, offset: number): string | undefined {
  const tokens = model.tokens;
  let i = tokenBefore(tokens, offset, ['identifier', 'number']);
  const skipComments = () => { while (i >= 0 && tokens[i].kind === 'comment') i--; };
  if (tokens[i]?.text !== '=') return undefined;
  i--; skipComments();
  // Alternate identifier and '.' walking back, so two adjacent identifiers end
  // the name instead of being glued into one: `attribute integer phase = ` must
  // yield `phase`, not `attributeintegerphase`, and a statement missing its
  // semicolon must not absorb the previous one's value.
  const segments: string[] = [];
  for (let wantIdentifier = true; i >= 0; wantIdentifier = !wantIdentifier) {
    const token = tokens[i];
    if (wantIdentifier ? token.kind !== 'identifier' : token.text !== '.') break;
    segments.unshift(token.text);
    i--; skipComments();
  }
  const name = segments.join('');
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : undefined;
}

export function provideCompletionItems(model: PlanDocument, position: Position): CompletionItem[] {
  const lineText = model.source.lineText(position.line);
  const offset = model.source.offsetAt(position);

  // Inside a `source = "..."` string the literal is not a hole: its keyword
  // prefix and its `${...}` names complete. Every other string, and every
  // comment, still suppresses completion — dispatched on the mask's kind rather
  // than on running a source branch in front of a boolean guard.
  const mask = model.maskAt(offset);
  if (mask === 'source-string') {
    const inSource = sourceCompletions(model, offset);
    if (inSource) return inSource;
  }
  if (mask) return [];

  const tokenStart = findTokenStart(lineText, position.character);
  const range = Range.create(position.line, tokenStart, position.line, position.character);
  const textBeforeCursor = lineText.slice(0, position.character);
  const stack = model.blocksAt(offset);
  const currentBlock = stack[stack.length - 1];

  const items: CompletionItem[] = [];
  const seen = new Map<string, number>();

  /** One item per label: a later, boosted entry replaces an unboosted one, so a
   * declared name wins over the keyword that happens to share its spelling
   * instead of the list showing both. */
  const push = (
    name: string,
    kind: CompletionItemKind,
    detail: string,
    boosted: boolean,
    insertText?: string,
    insertTextFormat?: InsertTextFormat
  ) => {
    const text = insertText ?? name;
    const item: CompletionItem = {
      label: name,
      kind,
      detail,
      textEdit: TextEdit.replace(range, text),
      insertText: text,
      insertTextFormat,
      sortText: (boosted ? '0_' : '9_') + name,
    };
    const existing = seen.get(name);
    if (existing === undefined) {
      seen.set(name, items.length);
      items.push(item);
    } else if (boosted && !items[existing].sortText!.startsWith('0_')) {
      items[existing] = item;
    }
  };

  const atTopLevel = TOP_LEVEL_BLOCKS.includes(currentBlock);
  const scope = scopeAt(model, offset);

  for (const kind of Object.keys(BLOCK_OPEN_KEYWORD) as PairKind[]) {
    const openKeyword = BLOCK_OPEN_KEYWORD[kind];
    const closeKeyword = BLOCK_CLOSE_KEYWORD[kind];
    const openBoosted = kind === 'measure' ? currentBlock === 'feature'
      : kind === 'metric' ? currentBlock === 'plan' : atTopLevel;
    push(
      openKeyword,
      CompletionItemKind.Keyword,
      `HVP block: opens a ${kind}, closed by ${closeKeyword}`,
      openBoosted,
      BLOCK_SNIPPET_BODY[kind],
      InsertTextFormat.Snippet
    );
    if (currentBlock === kind) {
      push(closeKeyword, CompletionItemKind.Keyword, `HVP block: closes a ${kind}`, true);
    }
  }

  const pushKeywordInfo = (info: KeywordInfo, kind: CompletionItemKind, boosted: boolean) => {
    push(info.name, kind, info.detail, boosted);
  };

  for (const info of NON_PAIRED_KEYWORDS) {
    let boosted = false;
    switch (info.name) {
      case 'goal':
      case 'aggregator':
      case 'apply':
        boosted = currentBlock === 'metric';
        break;
      case 'keep':
      case 'remove':
      case 'where':
        boosted = currentBlock === 'filter';
        break;
      case 'elseuntil':
      case 'else':
        boosted = currentBlock === 'until';
        break;
      case 'subplan':
        boosted = atTopLevel;
        break;
      case 'attribute':
      case 'annotation':
        boosted = currentBlock === 'plan';
        break;
      default:
        boosted = false;
    }
    pushKeywordInfo(info, CompletionItemKind.Keyword, boosted);
  }

  const inTypePosition = /\b(attribute|annotation|metric)\s+\S*$/.test(textBeforeCursor);
  for (const info of TYPE_KEYWORDS) {
    pushKeywordInfo(info, CompletionItemKind.TypeParameter, inTypePosition);
  }

  const inAggregatorValuePosition = /\baggregator\s*=\s*\S*$/.test(textBeforeCursor);
  for (const info of AGGREGATOR_NAMES) {
    pushKeywordInfo(info, CompletionItemKind.EnumMember, inAggregatorValuePosition);
  }

  // A plan that redeclares a built-in owns the name (see declarations.ts), so
  // the declared entry below is the only one offered for it.
  for (const info of BUILTIN_FIELDS) {
    if (scope.declarations.get(info.name)?.builtin === false) continue;
    pushKeywordInfo(info, CompletionItemKind.Property, info.name === 'source' ? currentBlock === 'measure' : currentBlock === 'feature');
  }

  // The line regex catches the name directly after `measure`/`metric`, including
  // a half-typed dotted one (`measure test.`), which the token scan rejects on
  // its trailing '.'; the token scan catches the rest of a metric list, which
  // the line regex cannot see past a comma or a line break.
  const inMetricPosition = /\b(measure|metric)\s+\S*$/.test(textBeforeCursor) || metricReferencePosition(model, offset);
  // The scope already holds built-in and declared metrics in one table, with a
  // plan's own declaration shadowing the built-in of the same name.
  for (const declaration of fieldsOf(scope, 'metric')) {
    push(declaration.name, CompletionItemKind.Value,
      declaration.builtin ? 'Built-in metric' : `Declared metric: ${declaration.type}`, inMetricPosition);
  }

  // After `Name.`, the members of the metric that name resolves to. The
  // replacement range covers the dotted prefix (see findTokenStart), so each
  // item carries the qualified name the user is completing, not the bare member.
  const typed = lineText.slice(tokenStart, position.character);
  const owner = typed.includes('.') ? scope.declarations.get(typed.slice(0, typed.lastIndexOf('.'))) : undefined;
  if (owner?.kind === 'metric') {
    for (const member of owner.members) {
      push(`${owner.name}.${member}`, CompletionItemKind.EnumMember, `Member of metric '${owner.name}'`, true);
    }
  }

  // Declared names come from the plan the cursor is in; built-ins the plan does
  // not redeclare are already covered by BUILTIN_FIELDS above.
  const assignmentTarget = assignmentTargetAt(model, offset);
  const assigned = assignmentTarget !== undefined && scope.declarations.get(assignmentTarget);
  if (assigned) {
    for (const member of assigned.members) {
      push(member, CompletionItemKind.EnumMember, `Member of enum '${assigned.name}'`, true);
    }
  }
  for (const kind of ['attribute', 'annotation'] as const) {
    for (const declaration of fieldsOf(scope, kind)) {
      if (declaration.builtin) continue;
      push(declaration.name, CompletionItemKind.Property, fieldDetail(kind, declaration),
        assignmentTarget === undefined && (currentBlock === 'feature' || currentBlock === 'plan'));
    }
  }

  return items;
}

/**
 * Completion inside a `source = "..."` string, or undefined when the cursor is
 * not in one.
 *
 * Two positions carry suggestions: the keyword prefix at the very start of the
 * string, and a name inside `${`. Anywhere else in the pattern the answer is an
 * empty list — a hierarchy path is data this server has no index of, which is
 * WS5's and WS7's territory.
 */
function sourceCompletions(model: PlanDocument, offset: number): CompletionItem[] | undefined {
  const found = sourceStringAt(model, offset);
  if (!found) return undefined;
  const { statement, token, expression } = found;
  // Strictly inside the quotes: the caret just past the closing quote has left
  // the string, and the caret on the opening quote has not entered it.
  if (offset <= token.start || (isTerminated(token) && offset >= token.end)) return undefined;
  const items: CompletionItem[] = [];
  const edit = (from: number, text: string) =>
    TextEdit.replace(model.source.span(from, offset).range, text);

  const interpolation = expression.interpolations.find(i => covers(i.nameSpan, offset));
  if (interpolation) {
    // The statement is already in hand, so its scope is an ancestor walk rather
    // than the full node scan `scopeAt` would repeat to find it.
    const scope = scopeOf(model, statement);
    const push = (name: string, kind: CompletionItemKind, detail: string) => items.push({
      label: name, kind, detail, sortText: `0_${name}`,
      textEdit: edit(interpolation.nameSpan.start, name), insertText: name,
    });
    push(OBJPATH, CompletionItemKind.Variable,
      'Reserved: the full path of the measure hierarchy (plan.feature.measure)');
    // One rule for what a `${name}` may name, shared with the diagnostic and
    // hover (see resolver.ts): attributes and annotations, never metrics.
    for (const declaration of interpolationTargets(scope)) {
      push(declaration.name, CompletionItemKind.Property, fieldDetail(declaration.kind, declaration));
    }
    return items;
  }

  // The keyword prefix only exists at the head of the string, so it is offered
  // only while everything typed so far is still the start of one. `"a b"` and
  // any hierarchy path therefore suppress completion, as a string always did.
  const typed = model.source.text.slice(token.start + 1, offset).replace(/^\s+/, '').replace(/\s+/g, ' ');
  const started = (keyword: SourceKeywordInfo) =>
    keyword.name.startsWith(typed) || (keyword.mask && `${keyword.name} 'h`.startsWith(typed));
  for (const keyword of SOURCE_KEYWORDS.filter(started)) {
    // A mask keyword is completed up to its `'h`, since the digits are the
    // user's to supply.
    const text = keyword.mask ? `${keyword.name} 'h` : `${keyword.name}:`;
    items.push({
      label: keyword.mask ? `${keyword.name} 'h###:` : `${keyword.name}:`,
      kind: CompletionItemKind.Keyword,
      detail: `${keyword.detail}. Available for ${keyword.metrics.join(', ')}.`,
      sortText: `0_${keyword.name}`,
      textEdit: edit(token.start + 1, text),
      insertText: text,
    });
  }
  return items;
}

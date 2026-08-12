import { CompletionItem, CompletionItemKind, InsertTextFormat, Position, Range, TextEdit } from 'vscode-languageserver-types';
import { maskLine } from './blockAnalysis';
import type { LineSnapshot } from './blockAnalysis';
import {
  AGGREGATOR_NAMES,
  BLOCK_CLOSE_KEYWORD,
  BLOCK_OPEN_KEYWORD,
  BLOCK_SNIPPET_BODY,
  BUILTIN_FIELDS,
  BUILTIN_METRICS,
  KeywordInfo,
  NON_PAIRED_KEYWORDS,
  PairKind,
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

/** True when the cursor sits inside a string or comment, per the same
 * masking rules diagnostics/symbols already use — checked by walking back
 * over the contiguous non-whitespace run before the cursor and seeing
 * whether any of it was blanked out by maskLine. */
function isInsideMaskedRegion(lineText: string, col: number, inBlockComment: boolean): boolean {
  const masked = maskLine(lineText, { inBlockComment });
  for (let c = col - 1; c >= 0 && /\S/.test(lineText[c]); c--) {
    if (masked[c] === ' ') {
      return true;
    }
  }
  return false;
}

const TOP_LEVEL_BLOCKS: (PairKind | undefined)[] = [undefined, 'plan', 'feature'];

export function provideCompletionItems(
  lines: string[],
  position: Position,
  lineSnapshots: LineSnapshot[]
): CompletionItem[] {
  const lineText = lines[position.line];
  const snapshot = lineSnapshots[position.line];
  const inBlockComment = snapshot?.inBlockComment ?? false;

  if (isInsideMaskedRegion(lineText, position.character, inBlockComment)) {
    return [];
  }

  const tokenStart = findTokenStart(lineText, position.character);
  const range = Range.create(position.line, tokenStart, position.line, position.character);
  const textBeforeCursor = lineText.slice(0, position.character);
  const currentBlock = snapshot?.stack[snapshot.stack.length - 1];

  const items: CompletionItem[] = [];

  const push = (
    name: string,
    kind: CompletionItemKind,
    detail: string,
    boosted: boolean,
    insertText?: string,
    insertTextFormat?: InsertTextFormat
  ) => {
    const text = insertText ?? name;
    items.push({
      label: name,
      kind,
      detail,
      textEdit: TextEdit.replace(range, text),
      insertText: text,
      insertTextFormat,
      sortText: (boosted ? '0_' : '9_') + name,
    });
  };

  const atTopLevel = TOP_LEVEL_BLOCKS.includes(currentBlock);

  for (const kind of Object.keys(BLOCK_OPEN_KEYWORD) as PairKind[]) {
    const openKeyword = BLOCK_OPEN_KEYWORD[kind];
    const closeKeyword = BLOCK_CLOSE_KEYWORD[kind];
    const opensInsideFeature = kind === 'measure' || kind === 'metric';
    const openBoosted = opensInsideFeature ? currentBlock === 'feature' : atTopLevel;
    push(
      openKeyword,
      CompletionItemKind.Keyword,
      `HVP block: opens a ${kind}, closed by ${closeKeyword}`,
      openBoosted,
      BLOCK_SNIPPET_BODY[kind],
      InsertTextFormat.Snippet
    );
    push(closeKeyword, CompletionItemKind.Keyword, `HVP block: closes a ${kind}`, currentBlock === kind);
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
      case 'attribute':
      case 'annotation':
        boosted = atTopLevel;
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

  for (const info of BUILTIN_FIELDS) {
    pushKeywordInfo(info, CompletionItemKind.Property, info.name === 'source' ? currentBlock === 'measure' : currentBlock === 'feature');
  }

  const inMetricTypePosition = /\b(measure|metric)\s+\S*$/.test(textBeforeCursor);
  for (const info of BUILTIN_METRICS) {
    pushKeywordInfo(info, CompletionItemKind.Value, inMetricTypePosition);
  }

  return items;
}

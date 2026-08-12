import { DocumentSymbol, Range, SymbolKind } from 'vscode-languageserver-types';
import { FEATURE_CLOSE, FEATURE_OPEN, maskLine } from './blockAnalysis';
import type { MaskState } from './blockAnalysis';

export function provideDocumentSymbols(lines: string[]): DocumentSymbol[] {
  const roots: DocumentSymbol[] = [];
  const stack: { symbol: DocumentSymbol; startLine: number }[] = [];
  const maskState: MaskState = { inBlockComment: false };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const masked = maskLine(raw, maskState);

    const openMatch = FEATURE_OPEN.exec(masked);
    if (openMatch) {
      const name = openMatch[1];
      const declRange = Range.create(i, 0, i, raw.length);
      const symbol: DocumentSymbol = {
        name,
        detail: '',
        kind: SymbolKind.Class,
        range: declRange,
        selectionRange: declRange,
        children: [],
      };

      if (stack.length > 0) {
        stack[stack.length - 1].symbol.children!.push(symbol);
      } else {
        roots.push(symbol);
      }
      stack.push({ symbol, startLine: i });
      continue;
    }

    if (FEATURE_CLOSE.test(masked)) {
      const top = stack.pop();
      if (top) {
        top.symbol.range = Range.create(top.startLine, 0, i, raw.length);
      }
    }
  }

  return roots;
}

import { DocumentSymbol, Range, SymbolKind } from 'vscode-languageserver-types';
import { PlanDocument, PlanNode } from './planModel';

/** Preserve the feature-only outline until WS6 adds other symbol kinds. */
export function provideDocumentSymbols(model: PlanDocument): DocumentSymbol[] {
  const visit = (nodes: PlanNode[]): DocumentSymbol[] => nodes.flatMap(node => {
    const children = visit(node.children);
    if (node.kind !== 'feature' || !node.name) return children;
    const startLine = node.range.start.line;
    const endLine = node.close?.range.end.line ?? startLine;
    // Keep established outline ranges, but select the precise name on navigation.
    const lineStart = model.source.lineStarts[startLine];
    const before = model.source.text.slice(lineStart, node.start).trim();
    const after = node.close ? model.source.text.slice(node.close.end, model.source.lineEnd(endLine)).trim() : '';
    const range = before || (after && !after.startsWith('//') && !after.startsWith('/*'))
      ? node.range : Range.create(startLine, 0, endLine, model.source.lineRange(endLine).end.character);
    return [{ name: node.name.text, detail: '', kind: SymbolKind.Class,
      range, selectionRange: node.name.range, children }];
  });
  return visit(model.roots);
}

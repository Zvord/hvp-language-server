/**
 * The outline (WS6), and the workspace-wide symbol list beside it.
 *
 * `provideDocumentSymbols` used to report features and nothing else. It now
 * reports every named thing the model holds — plans, declarations, features,
 * subplans, measures, and the three modifier blocks — as one tree mirroring the
 * node tree.
 *
 * **The trap:** LSP's `DocumentSymbol` requires an explicit `selectionRange`,
 * which vscode's own `DocumentSymbol` constructor derived for you. It must be
 * contained in `range`, or the client drops the symbol; `range` is the whole
 * block and `selectionRange` is the name inside it.
 */
import { DocumentSymbol, Location, Range, SymbolInformation, SymbolKind } from 'vscode-languageserver-types';
import { PlanDocument, PlanNode, isBlock, nameToken, runText } from './planModel';
import { WorkspaceIndex } from './workspace';

/** One kind per node kind the outline shows; anything absent is not a symbol.
 * `until` blocks and their branches are `Event`s because what selects a branch
 * is a date, not a name. */
const SYMBOL_KIND: Partial<Record<PlanNode['kind'], SymbolKind>> = {
  plan: SymbolKind.Module,
  feature: SymbolKind.Class,
  subplan: SymbolKind.Package,
  measure: SymbolKind.Method,
  metric: SymbolKind.Interface,
  attribute: SymbolKind.Property,
  annotation: SymbolKind.Field,
  override: SymbolKind.Namespace,
  filter: SymbolKind.Namespace,
  until: SymbolKind.Event,
  branch: SymbolKind.Event,
};

interface Outlined { name: string; detail: string; selection: Range }

/** What each node kind contributes to the outline, or undefined when it
 * contributes nothing but may still hold children. */
function outlined(model: PlanDocument, node: PlanNode): Outlined | undefined {
  const name = nameToken(node);
  const detail = (text: string): Outlined | undefined =>
    name ? { name: name.text, detail: text, selection: name.range } : undefined;
  switch (node.kind) {
    case 'plan': case 'feature': case 'override': case 'filter':
      return detail(node.kind);
    case 'attribute': case 'annotation':
      return detail(node.type.name?.text ?? '');
    case 'metric':
      return detail(node.type.name?.text ?? 'metric');
    case 'measure':
      return detail(node.metrics.map(reference => runText(reference)).join(', '));
    case 'subplan': {
      const parameters = node.parameters
        .map(parameter => `${runText(parameter.name)}=${runText(parameter.value)}`).join(', ');
      return detail(parameters ? `subplan #(${parameters})` : 'subplan');
    }
    case 'until':
      // The `until` block has no name of its own; its opening keyword is the
      // one thing inside `range` that can serve as the selection.
      return { name: 'until', detail: '', selection: keywordRange(model, node, 'until') };
    case 'branch': {
      const date = node.date && runText(node.date);
      return { name: date ? `${node.branchKind} ${date}` : node.branchKind, detail: '',
        selection: keywordRange(model, node, node.branchKind) };
    }
    default:
      return undefined;
  }
}

/** The opening keyword's own range, for the two nameless blocks. A header can
 * span lines (`until` carries a date), so the keyword is taken rather than the
 * whole header, keeping the selection on one line and inside `range`. Every
 * node starts at its first token, which for these two is the keyword. */
const keywordRange = (model: PlanDocument, node: PlanNode, keyword: string): Range =>
  model.source.span(node.start, node.start + keyword.length).range;

/**
 * The range the outline highlights for a block.
 *
 * A block that owns its opening and closing lines outright is shown as whole
 * lines, which is what the pre-WS6 feature outline did and what makes the
 * breadcrumb bar select sensibly; a block sharing a line with other statements
 * (`feature f; measure Line m; … endfeature`) keeps its own span, so the
 * highlight does not swallow its neighbours.
 */
function blockRange(model: PlanDocument, node: PlanNode): Range {
  if (!isBlock(node)) return node.range;
  const startLine = node.range.start.line;
  // An unclosed block still spans everything the parser recovered into it, and
  // collapsing it to its opening line would put its own children outside it —
  // which a client reads as a broken tree and may drop.
  const endLine = node.close?.range.end.line ?? node.range.end.line;
  const lineStart = model.source.lineStarts[startLine];
  const before = model.source.text.slice(lineStart, node.start).trim();
  const after = node.close ? model.source.text.slice(node.close.end, model.source.lineEnd(endLine)).trim() : '';
  return before || (after && !after.startsWith('//') && !after.startsWith('/*'))
    ? node.range
    : Range.create(startLine, 0, endLine, model.source.lineRange(endLine).end.character);
}

export function provideDocumentSymbols(model: PlanDocument): DocumentSymbol[] {
  const visit = (nodes: readonly PlanNode[]): DocumentSymbol[] => nodes.flatMap(node => {
    const children = visit(node.children);
    const kind = SYMBOL_KIND[node.kind];
    const symbol = kind === undefined ? undefined : outlined(model, node);
    // A nameless block still holds its children; hoisting them keeps the
    // outline usable while the name is being typed.
    if (!symbol || kind === undefined) return children;
    const range = blockRange(model, node);
    return [{ name: symbol.name, detail: symbol.detail, kind,
      range, selectionRange: contain(range, symbol.selection), children }];
  });
  return visit(model.roots);
}

/** A client drops a symbol whose `selectionRange` escapes its `range`, which a
 * recovered statement can manage: the name of an unclosed block is inside it,
 * but a name run the parser stretched past a boundary need not be. */
function contain(range: Range, selection: Range): Range {
  const before = selection.start.line < range.start.line ||
    (selection.start.line === range.start.line && selection.start.character < range.start.character);
  const after = selection.end.line > range.end.line ||
    (selection.end.line === range.end.line && selection.end.character > range.end.character);
  return before || after ? range : selection;
}

/** Which node kinds a workspace symbol search offers. The declarations and the
 * blocks a reader would jump to by name; assignments and statements are uses,
 * not definitions, and `references` is the request for those. */
const WORKSPACE_KINDS: readonly PlanNode['kind'][] =
  ['plan', 'feature', 'metric', 'measure', 'attribute', 'annotation'];

/** Enough to keep a huge workspace from serialising a symbol per measure —
 * `mipi_dphy.hvp` alone holds 610 of them. */
const MAX_WORKSPACE_SYMBOLS = 1000;

/**
 * Every named declaration in the workspace whose name matches `query`.
 *
 * Matching is a case-insensitive subsequence, which is what editors' own
 * quick-open boxes do, so `mpl` finds `my_plan`; an empty query returns
 * everything up to the cap. `containerName` is the plan the name belongs to,
 * since the same attribute name in two plans is two different declarations and
 * the list has to be readable enough to tell them apart.
 */
export function provideWorkspaceSymbols(index: WorkspaceIndex, query: string): SymbolInformation[] {
  const matches = matcher(query);
  const symbols: SymbolInformation[] = [];
  for (const { uri, model } of index.documents()) {
    for (const node of model.nodes) {
      if (!WORKSPACE_KINDS.includes(node.kind)) continue;
      const name = nameToken(node);
      if (!name || !matches(name.text)) continue;
      const plan = nameToken(model.enclosingOf(node, 'plan'));
      symbols.push({
        name: name.text,
        kind: SYMBOL_KIND[node.kind]!,
        location: Location.create(uri, name.range),
        containerName: plan && plan !== name ? plan.text : undefined,
      });
      if (symbols.length >= MAX_WORKSPACE_SYMBOLS) return symbols;
    }
  }
  return symbols;
}

function matcher(query: string): (name: string) => boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return () => true;
  return (name: string) => {
    const haystack = name.toLowerCase();
    let at = 0;
    for (const character of needle) {
      at = haystack.indexOf(character, at);
      if (at === -1) return false;
      at++;
    }
    return true;
  };
}

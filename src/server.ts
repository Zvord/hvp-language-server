import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeParams,
  InitializeResult,
  CompletionItem,
  CompletionParams,
  DocumentSymbolParams,
  DocumentSymbol,
  FoldingRangeParams,
  FoldingRange,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { getLines } from './core/textLines';
import { analyzeBlocks } from './core/blockAnalysis';
import type { LineSnapshot } from './core/blockAnalysis';
import { provideDocumentSymbols } from './core/symbols';
import { provideCompletionItems } from './core/completion';
import { provideFoldingRanges } from './core/folding';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(
  (_params: InitializeParams): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['.'] },
      documentSymbolProvider: true,
      foldingRangeProvider: true,
    },
  })
);

const LINT_DEBOUNCE_MS = 300;

// Populated as a byproduct of each lint pass so onCompletion can look up
// "what block is the cursor inside" in O(1) instead of rescanning the
// document from the top on every keystroke. Ported verbatim from
// vscode-hvp/src/extension.ts's blockIndexCache.
const blockIndexCache = new Map<string, LineSnapshot[]>();
const pendingLints = new Map<string, ReturnType<typeof setTimeout>>();

function lintNow(document: TextDocument): void {
  const lines = getLines(document);
  const { diagnostics, lineSnapshots } = analyzeBlocks(lines);
  blockIndexCache.set(document.uri, lineSnapshots);
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

function lintDebounced(document: TextDocument): void {
  const key = document.uri;
  const pending = pendingLints.get(key);
  if (pending) {
    clearTimeout(pending);
  }
  pendingLints.set(
    key,
    setTimeout(() => {
      pendingLints.delete(key);
      lintNow(document);
    }, LINT_DEBOUNCE_MS)
  );
}

// onDidOpen lints immediately (matches the old extension's behaviour of
// linting every already-open document on activation). TextDocuments also
// fires onDidChangeContent for the same open event, which schedules a
// redundant-but-harmless debounced re-lint of unchanged content; every real
// edit after that goes through the 300ms debounce as before.
documents.onDidOpen((event) => lintNow(event.document));
documents.onDidChangeContent((event) => lintDebounced(event.document));

documents.onDidClose((event) => {
  const key = event.document.uri;
  const pending = pendingLints.get(key);
  if (pending) {
    clearTimeout(pending);
    pendingLints.delete(key);
  }
  blockIndexCache.delete(key);
  connection.sendDiagnostics({ uri: key, diagnostics: [] });
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const lines = getLines(document);
  const snapshots = blockIndexCache.get(document.uri) ?? analyzeBlocks(lines).lineSnapshots;
  return provideCompletionItems(lines, params.position, snapshots);
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return provideDocumentSymbols(getLines(document));
});

connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return provideFoldingRanges(getLines(document));
});

documents.listen(connection);
connection.listen();

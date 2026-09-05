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

import { parseDocument } from './core/parser';
import { PlanDocument } from './core/planModel';
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

// Every request observes the current document version, including requests
// arriving before the debounced diagnostics pass.
const modelCache = new Map<string, { version: number; model: PlanDocument }>();
function modelFor(document: TextDocument): PlanDocument {
  const cached = modelCache.get(document.uri);
  if (cached?.version === document.version) return cached.model;
  const model = parseDocument(document.getText());
  modelCache.set(document.uri, { version: document.version, model });
  return model;
}
const pendingLints = new Map<string, ReturnType<typeof setTimeout>>();

function lintNow(document: TextDocument): void {
  const { diagnostics } = modelFor(document);
  connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
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
  modelCache.delete(key);
  connection.sendDiagnostics({ uri: key, diagnostics: [] });
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return provideCompletionItems(modelFor(document), params.position);
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return provideDocumentSymbols(modelFor(document));
});

connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return provideFoldingRanges(modelFor(document));
});

documents.listen(connection);
connection.listen();

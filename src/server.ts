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
  Hover,
  HoverParams,
  DidChangeWatchedFilesNotification,
  DidChangeWatchedFilesParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { parseDocument } from './core/parser';
import { PlanDocument } from './core/planModel';
import { provideDocumentSymbols } from './core/symbols';
import { provideCompletionItems } from './core/completion';
import { provideFoldingRanges } from './core/folding';
import { provideHover } from './core/hover';
import { IndexedDocument } from './core/workspace';
import { workspaceDiagnostics } from './core/workspaceDiagnostics';
import { WorkspaceFiles, initialRoots } from './workspaceFiles';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Every request observes the current document version, including requests
// arriving before the debounced diagnostics pass.
const modelCache = new Map<string, { version: number; model: PlanDocument }>();
function modelFor(document: TextDocument): PlanDocument {
  const cached = modelCache.get(document.uri);
  if (cached?.version === document.version) return cached.model;
  const model = parseDocument(document.getText());
  modelCache.set(document.uri, { version: document.version, model });
  // An edit can change what this file declares to every other file in the plan
  // set, so the workspace index is rebuilt from the open documents next time it
  // is asked for. Rebuilding is a name-table pass over models that are already
  // parsed; nothing is re-read or re-parsed here.
  workspace.invalidate();
  return model;
}

// WS5's index. Open documents are the overlay: whatever the editor holds wins
// over what is on disk, and an unsaved edit is visible to every other file.
const workspace = new WorkspaceFiles((): IndexedDocument[] =>
  documents.all().map(document => ({ uri: document.uri, model: modelFor(document) })));
let watchedFilesSupported = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  watchedFilesSupported = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
  // Not awaited: `initialize` must answer immediately, and every consumer of
  // the index copes with it being empty (see `WorkspaceFiles.ready`).
  void workspace.scanRoots(initialRoots(params)).then(relintAll);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['.'] },
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      hoverProvider: true,
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
  };
});

connection.onInitialized(() => {
  if (!watchedFilesSupported) return;
  // Without this the index only tracks files the editor has open; with it, a
  // plan file edited by a rebase or another tool re-enters the index.
  void connection.client.register(DidChangeWatchedFilesNotification.type,
    { watchers: [{ globPattern: '**/*.hvp' }] });
});

connection.onDidChangeWatchedFiles(async (params: DidChangeWatchedFilesParams) => {
  // Created, changed and deleted alike: `refresh` re-reads what it can and
  // drops what it cannot, so the three cases need no separate handling.
  const changed = await workspace.refresh(params.changes.map(change => change.uri));
  if (changed) relintAll();
});

const LINT_DEBOUNCE_MS = 300;
const pendingLints = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The diagnostics for one document: the parse's own until the workspace scan
 * has settled, and the cross-file set once it has.
 *
 * The gate matters more than it looks. A half-built index declares every plan
 * name unknown, and publishing that — even for the moment before the scan
 * finishes — puts an error on a file that is correct.
 */
function lintNow(document: TextDocument): void {
  const model = modelFor(document);
  const diagnostics = workspace.ready()
    ? workspaceDiagnostics(model, document.uri, workspace.current()) : model.diagnostics;
  connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
}

/** A change anywhere in the plan set can resolve or unresolve a name in every
 * open file, so they are all re-linted — through the same debounce, since a
 * watched-file burst (a checkout, a save-all) arrives as many notifications. */
function relintAll(): void {
  for (const document of documents.all()) lintDebounced(document);
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
documents.onDidOpen((event) => {
  // A client with no workspace folder (a single file opened on its own) still
  // has a plan set around it: the directory the file sits in.
  void workspace.scanDirectoryOf(event.document.uri).then(scanned => { if (scanned) relintAll(); });
  lintNow(event.document);
});
documents.onDidChangeContent((event) => lintDebounced(event.document));

documents.onDidClose((event) => {
  const key = event.document.uri;
  const pending = pendingLints.get(key);
  if (pending) {
    clearTimeout(pending);
    pendingLints.delete(key);
  }
  modelCache.delete(key);
  // The document leaves the overlay, so the copy on disk indexes it again.
  workspace.invalidate();
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

connection.onHover((params: HoverParams): Hover | undefined => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return undefined;
  }
  // The URI turns each origin in the hover table into a clickable location; the
  // index is what lets a `subplan` hover reach into the file it names, and what
  // tells a feature hover which instance's parameters it is showing. Withheld
  // until the scan has settled, for the same reason the diagnostics are: a
  // half-built index would report a plan that exists as not declared anywhere.
  return provideHover(modelFor(document), params.position, {
    uri: document.uri,
    index: workspace.ready() ? workspace.current() : undefined,
  });
});

documents.listen(connection);
connection.listen();

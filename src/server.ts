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
  DefinitionParams,
  ReferenceParams,
  RenameParams,
  PrepareRenameParams,
  WorkspaceSymbolParams,
  Location,
  SymbolInformation,
  WorkspaceEdit,
  Range,
  ResponseError,
  ErrorCodes,
  DidChangeConfigurationNotification,
  SemanticTokens,
  SemanticTokensParams,
  SemanticTokensRangeParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import path from 'node:path';

import { parseDocument } from './core/parser';
import { PlanDocument } from './core/planModel';
import { provideDocumentSymbols, provideWorkspaceSymbols } from './core/symbols';
import {
  isRefusal,
  prepareRename,
  provideDefinition,
  provideReferences,
  provideRenameEdits,
} from './core/navigation';
import { provideCompletionItems } from './core/completion';
import { provideFoldingRanges } from './core/folding';
import { provideHover } from './core/hover';
import { SEMANTIC_TOKENS_LEGEND, provideSemanticTokens } from './core/semanticTokens';
import { IndexedDocument, WorkspaceIndex } from './core/workspace';
import { ModifierEvaluation, evaluateModifiers, isDateProblem, parseDate } from './core/modifiers';
import { workspaceDiagnostics } from './core/workspaceDiagnostics';
import { WorkspaceFiles, initialRoots, uriOfPath } from './workspaceFiles';

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
let configurationSupported = false;

/**
 * WS7's preview, off unless the user turns it on.
 *
 * `hvp.modifiers.files` is the `-mod` argument list the chapter describes,
 * which the editor has no other way of knowing: a modifier file is an ordinary
 * `.hvp` file, and nothing inside one says which plan set it belongs to or
 * whether the user wants it applied. `hvp.modifiers.date` stands in for the day
 * the tool would be run on, so an `until` block can be previewed at a date
 * other than today. An empty file list means the preview is off, which is the
 * default: applying a modifier nobody asked for would silently change every
 * value the editor reports.
 */
interface ModifierConfiguration {
  files: string[];
  date: string;
}
let modifierConfiguration: ModifierConfiguration = { files: [], date: '' };

/** Rebuilt only when the configuration or the index changes — never on a hover
 * or a completion, which is what keeps the path resolution (a walk of every
 * scope in the workspace) off the request path. */
let evaluation: { index: WorkspaceIndex; settings: ModifierConfiguration;
                  value: ModifierEvaluation | undefined } | undefined;

function modifiers(): ModifierEvaluation | undefined {
  if (!workspace.ready() || !modifierConfiguration.files.length) return undefined;
  const index = workspace.current();
  if (evaluation?.index === index && evaluation.settings === modifierConfiguration) return evaluation.value;
  const value = evaluateModifiers(index, {
    files: modifierConfiguration.files.map(file => modifierFileUri(file, index)).filter((uri): uri is string => !!uri),
    date: modifierConfiguration.date,
    now: today(),
  });
  evaluation = { index, settings: modifierConfiguration, value };
  return value;
}

/** A configured file as a URI the index knows: a `file:` URI as written, an
 * absolute path, or a path relative to one of the workspace folders. */
function modifierFileUri(file: string, index: WorkspaceIndex): string | undefined {
  const candidates = file.startsWith('file:') ? [file]
    : [uriOfPath(path.resolve(file)), ...workspace.rootPaths().map(root => uriOfPath(path.resolve(root, file)))];
  return candidates.find(uri => index.document(uri));
}

/** The day the diagnostics and the preview are both read against: the
 * configured evaluation date when there is one, otherwise today. The wall clock
 * is read here and nowhere else — `src/core` takes the day as an argument, so a
 * check whose answer changes at midnight is never baked into a cached parse. */
function today(): Date {
  return evaluationDate() ?? new Date();
}

/** The configured evaluation date, when one is set and well-formed. */
function evaluationDate(): Date | undefined {
  const parsed = modifierConfiguration.date ? parseDate(modifierConfiguration.date) : undefined;
  if (!parsed || isDateProblem(parsed)) return undefined;
  return new Date(parsed.year, parsed.month - 1, parsed.day);
}

async function refreshConfiguration(): Promise<boolean> {
  if (!configurationSupported) return false;
  let settings: unknown;
  try {
    [settings] = await connection.workspace.getConfiguration([{ section: 'hvp.modifiers' }]);
  } catch {
    return false; // A client that advertises the capability but answers nothing.
  }
  const given = (settings ?? {}) as { files?: unknown; date?: unknown };
  const files = Array.isArray(given.files) ? given.files.filter((f): f is string => typeof f === 'string') : [];
  const date = typeof given.date === 'string' ? given.date : '';
  if (files.join('\u0000') === modifierConfiguration.files.join('\u0000') && date === modifierConfiguration.date) {
    return false;
  }
  modifierConfiguration = { files, date };
  evaluation = undefined;
  return true;
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  watchedFilesSupported = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
  configurationSupported = !!params.capabilities.workspace?.configuration;
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
      definitionProvider: true,
      referencesProvider: true,
      // `prepareProvider` is what lets the editor reject an invalid position
      // before the user types a new name; core answers it from the same target
      // lookup the rename itself uses.
      renameProvider: { prepareProvider: true },
      workspaceSymbolProvider: true,
      // WS8c. The legend is `semanticTokens.ts`'s own export rather than a list
      // written out again here: the client maps every token by its index into
      // these two arrays, so a second copy that drifted would shift every colour
      // in the file with nothing to report it. `range` is advertised because
      // editors ask for the visible window first on a large file, and answering
      // it is the same walk with an offset window.
      semanticTokensProvider: { legend: SEMANTIC_TOKENS_LEGEND, full: true, range: true },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
  };
});

connection.onInitialized(() => {
  if (configurationSupported) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
    void refreshConfiguration().then(changed => { if (changed) relintAll(); });
  }
  if (!watchedFilesSupported) return;
  // Without this the index only tracks files the editor has open; with it, a
  // plan file edited by a rebase or another tool re-enters the index.
  void connection.client.register(DidChangeWatchedFilesNotification.type,
    { watchers: [{ globPattern: '**/*.hvp' }] });
});

connection.onDidChangeConfiguration(async () => {
  // The preview decides what every hover reports and which `until` branches
  // count as expired, so a configuration change re-lints the whole plan set.
  if (await refreshConfiguration()) relintAll();
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
    ? workspaceDiagnostics(model, document.uri, workspace.current(), { now: today() })
    : model.diagnostics;
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
  // The index is what completes a path segment against the instantiated
  // hierarchy; withheld until the scan settles, like every other consumer.
  return provideCompletionItems(modelFor(document), params.position, {
    index: workspace.ready() ? workspace.current() : undefined,
  });
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
    // Already built; `modifiers()` is a cache read unless the configuration or
    // the index moved since the last request.
    modifiers: modifiers(),
  });
});

/**
 * The navigation options a request is served with.
 *
 * The index is withheld until the workspace scan settles, exactly as the
 * diagnostics and the hover withhold it: a half-built index has not seen the
 * file that declares the plan a `subplan` names, so definition would answer
 * "nowhere" and references would answer with half the workspace — and a rename
 * refuses outright rather than rewriting a fraction of the occurrences.
 */
const navigationOptions = (uri: string) => ({
  uri,
  index: workspace.ready() ? workspace.current() : undefined,
});

connection.onDefinition((params: DefinitionParams): Location[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return provideDefinition(modelFor(document), params.position, navigationOptions(document.uri));
});

connection.onReferences((params: ReferenceParams): Location[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return provideReferences(modelFor(document), params.position, {
    ...navigationOptions(document.uri),
    includeDeclaration: params.context?.includeDeclaration !== false,
  });
});

connection.onPrepareRename((params: PrepareRenameParams): { range: Range; placeholder: string } | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const prepared = prepareRename(modelFor(document), params.position, navigationOptions(document.uri));
  // Null is "there is no name here" and the editor phrases that itself; a
  // refusal is a name this rename would not be safe on, and its sentence is the
  // whole point, so it goes back as an error the editor shows verbatim.
  if (!prepared) return null;
  if (isRefusal(prepared)) throw new ResponseError(ErrorCodes.InvalidRequest, prepared.error);
  return prepared;
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const result = provideRenameEdits(modelFor(document), params.position, params.newName,
    navigationOptions(document.uri));
  if (isRefusal(result)) throw new ResponseError(ErrorCodes.InvalidRequest, result.error);
  return result.edit;
});

/**
 * WS8c's two requests, which an editor makes on essentially every edit.
 *
 * `semanticTokensOptions` withholds the index until the scan settles, like
 * every other consumer — a half-built index would leave a `subplan`'s
 * parameters uncoloured for a moment and then colour them, which reads as
 * flicker. It never *builds* one either: `workspace.current()` returns the
 * index the last edit or lint left, and the rebuild an edit invalidates would
 * happen at lint time regardless, so the count of rebuilds per keystroke stays
 * one.
 */
const semanticTokensOptions = () => ({ index: workspace.ready() ? workspace.current() : undefined });

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { data: [] };
  }
  return provideSemanticTokens(modelFor(document), semanticTokensOptions());
});

connection.languages.semanticTokens.onRange((params: SemanticTokensRangeParams): SemanticTokens => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { data: [] };
  }
  return provideSemanticTokens(modelFor(document), { ...semanticTokensOptions(), range: params.range });
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): SymbolInformation[] => {
  // Same gate again: an unsettled index lists the files it happens to have read
  // so far, which reads as symbols disappearing.
  if (!workspace.ready()) {
    return [];
  }
  return provideWorkspaceSymbols(workspace.current(), params.query);
});

documents.listen(connection);
connection.listen();

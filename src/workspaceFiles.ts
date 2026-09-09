import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseDocument } from './core/parser';
import { PlanDocument } from './core/planModel';
import { IndexedDocument, WorkspaceIndex, buildIndex } from './core/workspace';

/**
 * The `.hvp` files on disk, parsed, with the editor's open documents laid over
 * them.
 *
 * This is the half of WS5 that touches the file system, which is why it lives
 * beside `server.ts` and not in `src/core`: core takes a `WorkspaceIndex`
 * interface and never learns that a document has a file behind it.
 *
 * Nothing here runs on a hot path. The scan is one asynchronous pass at
 * `initialize`, and after that the index is only rebuilt when a file the client
 * watches changes or an open document is edited — never inside `parseDocument`,
 * a hover or a completion, all of which read the index the last change left.
 */
const HVP_EXTENSION = '.hvp';
/** Directories a plan set is never kept in, and which are big enough that
 * walking them would make the scan visible. */
const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules', 'out', 'dist', 'build', '.venv']);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 12;

export const uriOfPath = (file: string): string => pathToFileURL(file).href;

/** The path behind a `file:` URI, or undefined for anything else (an untitled
 * buffer, a virtual document): those live only in the open-document overlay. */
export function pathOfUri(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

export class WorkspaceFiles {
  private readonly disk = new Map<string, PlanDocument>();
  private readonly scannedDirectories = new Set<string>();
  private roots: string[] = [];
  private pending = 0;
  private scanned = false;
  private index?: WorkspaceIndex;

  /** `openDocuments` is read on every rebuild, so an open file is always
   * indexed at the version the editor holds rather than the one on disk. */
  constructor(private readonly openDocuments: () => readonly IndexedDocument[]) {}

  /** The workspace folders `initialize` named, for resolving a configured
   * relative path (WS7's modifier file list) against the same roots the scan
   * walked. Empty for a client that opened a single file. */
  rootPaths(): readonly string[] {
    return this.roots;
  }

  /** True once every scan that was asked for has finished. Diagnostics that
   * depend on the whole plan set wait for it: a half-built index would call
   * every plan name unknown and then take it back a moment later. */
  ready(): boolean {
    return this.scanned && this.pending === 0;
  }

  /** Drops the built index; the next `current()` rebuilds it. Cheap — the
   * models are already parsed and only the name tables are rebuilt. */
  invalidate(): void {
    this.index = undefined;
  }

  current(): WorkspaceIndex {
    if (this.index) return this.index;
    const open = this.openDocuments();
    const overlaid = new Set(open.map(document => document.uri));
    const documents: IndexedDocument[] = [...open];
    for (const [uri, model] of this.disk) {
      if (!overlaid.has(uri)) documents.push({ uri, model });
    }
    return this.index = buildIndex(documents);
  }

  async scanRoots(roots: readonly string[]): Promise<void> {
    this.roots = [...roots];
    this.pending++;
    try {
      for (const root of this.roots) await this.walk(root, 0);
    } finally {
      this.pending--;
      this.scanned = true;
      this.invalidate();
    }
  }

  /**
   * The fallback for a client with no workspace folder: the directory holding
   * the document that was just opened, and only that directory.
   *
   * The chapter's plan set is a list of files handed to the tool, so the files
   * sitting beside the one being edited are the best guess available. It stays
   * shallow deliberately — a single file opened from a home directory must not
   * turn into a recursive scan of it.
   */
  async scanDirectoryOf(uri: string): Promise<boolean> {
    const file = pathOfUri(uri);
    const directory = file && path.dirname(file);
    if (!directory || this.roots.length || this.scannedDirectories.has(directory)) return false;
    this.scannedDirectories.add(directory);
    this.pending++;
    try {
      await this.walk(directory, MAX_DEPTH); // At the depth limit: this directory only.
    } finally {
      this.pending--;
      this.scanned = true;
      this.invalidate();
    }
    return true;
  }

  /** Re-reads files the client reports as created, changed or deleted. Returns
   * whether the index actually changed, so the caller can skip a re-lint. */
  async refresh(uris: readonly string[]): Promise<boolean> {
    let changed = false;
    for (const uri of uris) {
      const file = pathOfUri(uri);
      if (!file || path.extname(file).toLowerCase() !== HVP_EXTENSION) continue;
      const key = uriOfPath(file);
      // A file that cannot be read is one that was deleted or renamed away.
      if (await this.read(file, key)) changed = true;
      else if (this.disk.delete(key)) changed = true;
    }
    if (changed) this.invalidate();
    return changed;
  }

  private async walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || this.disk.size >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: the index simply does not cover it.
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) await this.walk(child, depth + 1);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === HVP_EXTENSION) {
        await this.read(child, uriOfPath(child));
      }
      if (this.disk.size >= MAX_FILES) return;
    }
  }

  /** Reads and parses one file into the index. Returns false when the file is
   * gone or unreadable, which is what tells `refresh` to drop it. */
  private async read(file: string, uri: string): Promise<boolean> {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return false;
      this.disk.set(uri, parseDocument(await readFile(file, 'utf8')));
      return true;
    } catch {
      return false;
    }
  }
}

/** The folders `initialize` named, as file-system paths. `workspaceFolders`
 * first (a multi-root client sends nothing else), then the deprecated
 * `rootUri`/`rootPath` an older client still sends on its own. */
export function initialRoots(params: {
  workspaceFolders?: { uri: string }[] | null;
  rootUri?: string | null;
  rootPath?: string | null;
}): string[] {
  const folders = params.workspaceFolders?.map(folder => pathOfUri(folder.uri));
  const roots = folders?.length ? folders : [params.rootUri ? pathOfUri(params.rootUri) : params.rootPath];
  return roots.filter((root): root is string => !!root);
}

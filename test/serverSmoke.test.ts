// End-to-end smoke test for src/server.ts (see ../MIGRATION.md, Phase 2's
// "Verify" note: prove the LSP wiring works, not just that the core/*
// functions work in isolation). Spawns the compiled server as a real child
// process over --stdio and drives it with a minimal hand-rolled LSP client
// (no LSP client library dependency — just enough JSON-RPC/Content-Length
// framing to send initialize/didOpen/completion/documentSymbol/foldingRange
// and read back what the server sends).
import assert from 'node:assert/strict';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = process.cwd();
const SERVER_PATH = path.join(PACKAGE_ROOT, 'out', 'src', 'server.js');
const FIXTURE_PATH = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'orphan-close.hvp');

type JsonRpcMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };

class LspClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pendingResponses = new Map<number, (msg: JsonRpcMessage) => void>();
  private readonly notificationWaiters: { method: string; resolve: (msg: JsonRpcMessage) => void }[] = [];
  readonly stderr: string[] = [];

  constructor() {
    this.proc = spawn(process.execPath, [SERVER_PATH, '--stdio']);
    this.proc.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new Error(`Malformed LSP header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return; // wait for more data
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(JSON.parse(body));
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && this.pendingResponses.has(msg.id)) {
      this.pendingResponses.get(msg.id)!(msg);
      this.pendingResponses.delete(msg.id);
      return;
    }
    if (msg.method) {
      const waiterIndex = this.notificationWaiters.findIndex((w) => w.method === msg.method);
      if (waiterIndex !== -1) {
        const [waiter] = this.notificationWaiters.splice(waiterIndex, 1);
        waiter.resolve(msg);
      }
    }
  }

  private write(msg: object): void {
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
    this.proc.stdin.write(header + json);
  }

  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const result = new Promise<JsonRpcMessage>((resolve) => this.pendingResponses.set(id, resolve));
    this.write({ jsonrpc: '2.0', id, method, params });
    return withTimeout(result, `request '${method}'`);
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  waitForNotification(method: string): Promise<JsonRpcMessage> {
    const result = new Promise<JsonRpcMessage>((resolve) => this.notificationWaiters.push({ method, resolve }));
    return withTimeout(result, `notification '${method}'`);
  }

  dispose(): void {
    this.proc.kill();
  }
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)),
  ]);
}

test('server smoke test: initialize, didOpen, completion, documentSymbol, foldingRange, hover over --stdio', async () => {
  const client = new LspClient();
  try {
    const initResult = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });
    assert.ok(initResult.result, `initialize failed: ${JSON.stringify(initResult.error ?? client.stderr.join(''))}`);
    const capabilities = (initResult.result as { capabilities: Record<string, unknown> }).capabilities;
    assert.equal(capabilities.documentSymbolProvider, true);
    assert.equal(capabilities.foldingRangeProvider, true);
    assert.equal(capabilities.hoverProvider, true);
    assert.deepEqual(capabilities.completionProvider, { triggerCharacters: ['.'] });

    client.notify('initialized', {});

    const uri = `file://${FIXTURE_PATH}`;
    const text = readFileSync(FIXTURE_PATH, 'utf8');

    const diagnosticsPromise = client.waitForNotification('textDocument/publishDiagnostics');
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'hvp', version: 1, text },
    });

    // didOpen lints immediately (no debounce) per server.ts's lintNow wiring.
    const diagnosticsMsg = await diagnosticsPromise;
    const diagnosticsParams = diagnosticsMsg.params as { uri: string; diagnostics: unknown[] };
    assert.equal(diagnosticsParams.uri, uri);
    assert.ok(diagnosticsParams.diagnostics.length > 0, 'orphan-close.hvp is expected to produce at least one diagnostic');

    const completionResult = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });
    assert.ok(Array.isArray(completionResult.result), 'completion should return an item array');
    assert.ok((completionResult.result as unknown[]).length > 0, 'completion should offer at least one item');

    const symbolResult = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    assert.ok(Array.isArray(symbolResult.result), 'documentSymbol should return an array');

    const foldingResult = await client.request('textDocument/foldingRange', { textDocument: { uri } });
    assert.ok(Array.isArray(foldingResult.result), 'foldingRange should return an array');

    // A request immediately after didChange must use the new model, even
    // before the 300ms diagnostics debounce has elapsed.
    const updated = 'plan p; feature f; measure Line m; source = "x"; endmeasure endfeature endplan';
    const updateDiagnostics = client.waitForNotification('textDocument/publishDiagnostics');
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 }, contentChanges: [{ text: updated }],
    });
    const freshCompletion = await client.request('textDocument/completion', {
      textDocument: { uri }, position: { line: 0, character: updated.indexOf('source') },
    });
    const sourceItem = (freshCompletion.result as { label: string; sortText: string }[]).find(i => i.label === 'source');
    assert.equal(sourceItem?.sortText, '0_source', 'completion must observe the measure on the new compact line');
    const freshSymbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
    assert.deepEqual((freshSymbols.result as { name: string }[]).map(s => s.name), ['f']);
    const updatedParams = (await updateDiagnostics).params as { version: number; diagnostics: unknown[] };
    assert.equal(updatedParams.version, 2);
    assert.deepEqual(updatedParams.diagnostics, []);

    const structuralPromise = client.waitForNotification('textDocument/publishDiagnostics');
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: 'plan p; attribute integer x = 1; attribute integer x = 2; endplan' }],
    });
    const structural = (await structuralPromise).params as { version: number; diagnostics: { code: string }[] };
    assert.equal(structural.version, 3);
    assert.deepEqual(structural.diagnostics.map(d => d.code), ['duplicate-declaration']);

    const fixedPromise = client.waitForNotification('textDocument/publishDiagnostics');
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 4 }, contentChanges: [{ text: updated }],
    });
    const fixed = (await fixedPromise).params as { version: number; diagnostics: unknown[] };
    assert.equal(fixed.version, 4);
    assert.deepEqual(fixed.diagnostics, []);

    const hoverText = 'plan p;\nattribute integer phase = 1;\nfeature f;\nphase = 3;\nfeature g;\nmeasure Line m; source = "x"; endmeasure\nendfeature\nendfeature\nendplan';
    const hoverDiagnostics = client.waitForNotification('textDocument/publishDiagnostics');
    client.notify('textDocument/didChange', {
      textDocument: { uri, version: 5 }, contentChanges: [{ text: hoverText }],
    });
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri }, position: { line: 4, character: 8 },
    });
    const hoverValue = (hover.result as { contents: { value: string } }).contents.value;
    assert.match(hoverValue, /\*\*Feature\*\* `f\.g`/);
    // The origin links back into the document the request named.
    assert.ok(hoverValue.includes(`| \`phase\` | \`3\` | [inherited from f](${uri}#L4,1) |`), hoverValue);
    await hoverDiagnostics;

    // Closing the document must clear diagnostics with an empty array.
    const clearPromise = client.waitForNotification('textDocument/publishDiagnostics');
    client.notify('textDocument/didClose', { textDocument: { uri } });
    const clearMsg = await clearPromise;
    const clearParams = clearMsg.params as { uri: string; diagnostics: unknown[] };
    assert.equal(clearParams.uri, uri);
    assert.deepEqual(clearParams.diagnostics, []);
  } finally {
    client.dispose();
  }
});

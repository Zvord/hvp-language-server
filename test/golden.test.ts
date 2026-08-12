// Regression harness for Phase 1 of the vscode-hvp → hvp-language-server port
// (see ../../MIGRATION.md). Compares the ported core/* modules against
// test/golden/*.json, captured from the pre-split vscode-hvp extension by
// ../../scratch/capture-baseline.mjs. A passing run here is what "the port is
// behaviour-identical" means for this phase.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  InsertTextFormat,
  SymbolKind,
} from 'vscode-languageserver-types';

import { getLines } from '../src/core/textLines';
import { analyzeBlocks } from '../src/core/blockAnalysis';
import { provideDocumentSymbols } from '../src/core/symbols';
import { provideCompletionItems } from '../src/core/completion';

// `tsc` doesn't copy non-.ts assets into out/, so __dirname (which points at
// out/test/ once compiled) can't locate fixtures/golden data. `npm test`
// always runs from the package root, so resolve from there instead.
const PACKAGE_ROOT = process.cwd();
const FIXTURES_DIR = path.join(PACKAGE_ROOT, 'test', 'fixtures');
const GOLDEN_DIR = path.join(PACKAGE_ROOT, 'test', 'golden');

function reverseLookup(enumObj: Record<string, number>): (value: number) => string {
  const byValue = new Map(Object.entries(enumObj).map(([name, value]) => [value, name]));
  return (value) => byValue.get(value) ?? String(value);
}
const severityName = reverseLookup(DiagnosticSeverity as unknown as Record<string, number>);
const symbolKindName = reverseLookup(SymbolKind as unknown as Record<string, number>);
const completionKindName = reverseLookup(CompletionItemKind as unknown as Record<string, number>);
const insertTextFormatName = reverseLookup(InsertTextFormat as unknown as Record<string, number>);

function linesFor(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8');
  const document = TextDocument.create(`file://${filePath}`, 'hvp', 1, text);
  return getLines(document);
}

function normalizeDiagnostic(d: Diagnostic) {
  return { range: d.range, message: d.message, severity: severityName(d.severity!), source: d.source };
}

function normalizeSymbol(s: DocumentSymbol): unknown {
  return { name: s.name, kind: symbolKindName(s.kind), range: s.range, children: (s.children ?? []).map(normalizeSymbol) };
}

function normalizeCompletionItem(item: CompletionItem) {
  return {
    label: item.label,
    kind: completionKindName(item.kind!),
    detail: item.detail,
    insertText: item.insertText,
    // Phase 2: block-opener items now carry a Snippet body instead of plain
    // text (see MIGRATION.md decisions log, "snippets move server-side").
    // undefined (the vast majority of items) normalizes to the PlainText
    // default name so the golden file states it explicitly either way.
    insertTextFormat: insertTextFormatName(item.insertTextFormat ?? InsertTextFormat.PlainText),
    sortText: item.sortText,
  };
}

const diagnosticsGolden = JSON.parse(readFileSync(path.join(GOLDEN_DIR, 'diagnostics.json'), 'utf8'));
const symbolsGolden = JSON.parse(readFileSync(path.join(GOLDEN_DIR, 'symbols.json'), 'utf8'));
const completionGolden = JSON.parse(readFileSync(path.join(GOLDEN_DIR, 'completion.json'), 'utf8'));

const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.hvp'))
  .map((f) => f.replace(/\.hvp$/, ''))
  .sort();

for (const name of fixtureNames) {
  const lines = linesFor(path.join(FIXTURES_DIR, `${name}.hvp`));

  test(`diagnostics golden: ${name}`, () => {
    const { diagnostics } = analyzeBlocks(lines);
    assert.deepStrictEqual(diagnostics.map(normalizeDiagnostic), diagnosticsGolden[name]);
  });

  test(`symbols golden: ${name}`, () => {
    const symbols = provideDocumentSymbols(lines);
    assert.deepStrictEqual(symbols.map(normalizeSymbol), symbolsGolden[name]);
  });
}

// `realistic-sample.hvp` is a synthetic fixture, deeply nested and larger than the
// hand-authored fixtures, standing in for a real-world-sized document. Its diagnostics
// and symbols goldens are covered by the `fixtureNames` loop above (it lives in
// FIXTURES_DIR like every other fixture); only the completion scenarios below need it
// named explicitly.

// Scenario → source document, mirroring scratch/capture-baseline.mjs's
// `completionScenarios` table (the last two are "realistic", i.e. against
// realistic-sample.hvp; everything else is against valid-blocks.hvp). Positions
// come straight from the golden file rather than being re-derived by needle
// search, since the capture script already resolved and recorded them.
const REALISTIC_SCENARIOS = new Set(['realistic-inside-feature', 'realistic-inside-string-suppressed']);

test('completion golden', () => {
  const validBlocksLines = linesFor(path.join(FIXTURES_DIR, 'valid-blocks.hvp'));
  const realisticLines = linesFor(path.join(FIXTURES_DIR, 'realistic-sample.hvp'));
  const validBlocksSnapshots = analyzeBlocks(validBlocksLines).lineSnapshots;
  const realisticSnapshots = analyzeBlocks(realisticLines).lineSnapshots;

  for (const [name, scenario] of Object.entries<{ position: { line: number; character: number }; items: unknown[] }>(completionGolden)) {
    const onRealistic = REALISTIC_SCENARIOS.has(name);
    const lines = onRealistic ? realisticLines : validBlocksLines;
    const snapshots = onRealistic ? realisticSnapshots : validBlocksSnapshots;
    const items = provideCompletionItems(lines, scenario.position, snapshots);
    assert.deepStrictEqual(items.map(normalizeCompletionItem), scenario.items, `scenario: ${name}`);
  }
});

// WS8c: semantic tokens — what is coloured, what deliberately is not, and the
// LSP delta encoding, which is tested against a decoder rather than by eye: a
// wrong delta or a wrong sort mis-colours a file without failing anything else.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDocument } from '../src/core/parser';
import { PlanDocument } from '../src/core/planModel';
import {
  SEMANTIC_TOKENS_LEGEND,
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
  SemanticToken,
  encodeSemanticTokens,
  provideSemanticTokens,
  semanticTokens,
} from '../src/core/semanticTokens';
import { WorkspaceIndex, buildIndex } from '../src/core/workspace';

interface Decoded { line: number; character: number; length: number; type: string; modifiers: string[] }

/** The client's half of the protocol: absolute positions rebuilt from the
 * relative 5-tuples, so a wrong delta shows up as a wrong position rather than
 * as a number nobody can read. */
function decode(data: readonly number[]): Decoded[] {
  assert.equal(data.length % 5, 0, 'semantic token data must be 5 integers per token');
  const decoded: Decoded[] = [];
  let line = 0, character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    assert.ok(character >= 0, 'a decoded token starts before the line does');
    decoded.push({
      line,
      character,
      length: data[i + 2],
      type: SEMANTIC_TOKENS_LEGEND.tokenTypes[data[i + 3]],
      modifiers: SEMANTIC_TOKENS_LEGEND.tokenModifiers.filter((_, bit) => data[i + 4] & (1 << bit)),
    });
  }
  return decoded;
}

/** `text/type` — or `text/type+modifier` — for every token, read back out of
 * the document so a range that drifted by one character fails the assertion. */
function show(model: PlanDocument, tokens: readonly { line: number; character: number; length: number;
                                                     type: string; modifiers: readonly string[] }[]): string[] {
  return tokens.map(token => {
    const text = model.source.lineText(token.line).slice(token.character, token.character + token.length);
    return [text, token.type, ...token.modifiers].join('/');
  });
}

/** Both halves of the provider on one document: the structured tokens, and the
 * same tokens after a round trip through the delta encoding. They must agree —
 * that is what pins the encoder to the walk. */
function tokensOf(text: string, options: { index?: WorkspaceIndex } = {}) {
  const model = parseDocument(text);
  const tokens = semanticTokens(model, options);
  const roundTripped = decode(provideSemanticTokens(model, options).data);
  assert.deepEqual(show(model, roundTripped), show(model, tokens), 'the encoded data must decode back to the tokens');
  return { model, tokens, listed: show(model, tokens) };
}

const PLAN = `plan cpu_plan;
attribute integer Priority = 1;
annotation string Source = "";
attribute enum {open, closed} status = open;
metric enum {created, reviewed} spec_status;
aggregator = sum;
goal = spec_status.reviewed >= 10;
endmetric
metric aggregate {Line(weight=1.0), Cond(weight=2.0)} MyAgg;
goal = MyAgg > 0.1;
endmetric
feature cpu;
description = "core";
Priority = 2;
status = closed;
spec_status = spec_status >= 20;
measure Line, MyAgg cov;
source = "instance: \${root_mod}top.\${objpath}";
endmeasure
endfeature
endplan`;

test('declared attributes, annotations and metrics are coloured by kind', () => {
  const { listed } = tokensOf(PLAN);
  // Position order, not walk order: a declaration writes its `enum {...}`
  // members and its `aggregate {...}` metrics *before* its own name, so the
  // sort in `semanticTokens` is load-bearing on every declaration with a type
  // body — not only where two passes meet.
  assert.deepEqual(listed, [
    'cpu_plan/namespace/declaration',
    'Priority/property/declaration',
    'Source/variable/declaration',
    'open/enumMember/declaration',
    'closed/enumMember/declaration',
    'status/property/declaration',
    'open/enumMember',
    'created/enumMember/declaration',
    'reviewed/enumMember/declaration',
    'spec_status/type/declaration',
    'spec_status/type',
    'reviewed/enumMember',
    'Line/type/defaultLibrary',
    'Cond/type/defaultLibrary',
    'MyAgg/type/declaration',
    'MyAgg/type',
    'description/variable/defaultLibrary',
    'Priority/property',
    'status/property',
    'closed/enumMember',
    'spec_status/type',
    'spec_status/type',
    'Line/type/defaultLibrary',
    'MyAgg/type',
    'objpath/variable/defaultLibrary',
  ]);
});

test('a built-in carries defaultLibrary and a declared name does not', () => {
  const { listed } = tokensOf(`plan p;
metric ratio Line;
goal = Line > 0.9;
endmetric
feature f;
owner = "me";
weight = 2;
test.expected = 5;
measure Line, Cond m;
source = "instance: top";
endmeasure
endfeature
endplan`);
  assert.deepEqual(listed, [
    'p/namespace/declaration',
    // The plan redeclares `Line`, so every mention of it loses defaultLibrary:
    // WS1 warns about the redeclaration, and the file means the declared one.
    'Line/type/declaration',
    'Line/type',
    'owner/property/defaultLibrary',
    'weight/variable/defaultLibrary',
    'test.expected/property/defaultLibrary',
    'Line/type',
    'Cond/type/defaultLibrary',
  ]);
});

test('nothing the model did not resolve is coloured', () => {
  // Every name here is one the grammar would guess at and the model cannot
  // confirm: an undeclared assignment target, a metric no scope declares, a
  // `${name}` naming nothing, and a plan the workspace has never seen.
  const { listed } = tokensOf(`plan p;
feature f;
nowhere = 1;
subplan absent_plan #(nothing=2);
measure NoSuchMetric m;
source = "\${missing}x";
endmeasure
endfeature
endplan`);
  assert.deepEqual(listed, ['p/namespace/declaration']);
});

test('a metric is never interpolated, so ${Line} keeps the grammar colour', () => {
  const { listed } = tokensOf(`plan p;
attribute string root_mod = "";
annotation string note = "";
feature f;
measure Line m;
source = "instance: \${root_mod}\${note}\${Line}\${objpath}";
endmeasure
endfeature
endplan`);
  assert.deepEqual(listed, [
    'p/namespace/declaration',
    'root_mod/property/declaration',
    'note/variable/declaration',
    'Line/type/defaultLibrary',
    'root_mod/property',
    'note/variable',
    // `Line` between them gets nothing: resolver.ts's rule is that an
    // interpolation substitutes a value and a metric carries a goal instead.
    'objpath/variable/defaultLibrary',
  ]);
});

test('an unterminated source string is left alone', () => {
  const { listed } = tokensOf(`plan p;
attribute string root_mod = "";
feature f;
measure Line m;
source = "\${root_mod}x;
endmeasure
endfeature
endplan`);
  assert.ok(!listed.includes('root_mod/property'), listed.join(' '));
});

test('a name broken across lines gets no token rather than a mis-encoded one', () => {
  const { tokens } = tokensOf('plan p;\nfeature f;\ntest\n.expected = 1;\nendfeature\nendplan');
  for (const token of tokens) assert.ok(token.length > 0);
  // The only token left is the plan name; the two-line target names a real
  // built-in but has no single-line range to carry.
  assert.deepEqual(tokens.map(t => t.type), ['namespace']);
});

test('the delta encoding is relative to the previous token, per line', () => {
  const at = (line: number, character: number, length: number,
              type: SemanticToken['type'] = 'property',
              modifiers: SemanticToken['modifiers'] = []): SemanticToken =>
    ({ line, character, length, type, modifiers });
  // Two tokens on line 0, one further along the same line, one after two blank
  // lines — the three cases the encoding treats differently.
  const data = encodeSemanticTokens([
    at(0, 4, 3),
    at(0, 10, 5, 'type'),
    at(3, 2, 4, 'enumMember', ['declaration']),
    at(3, 9, 2, 'namespace', ['declaration', 'defaultLibrary']),
  ]);
  assert.deepEqual(data, [
    0, 4, 3, SEMANTIC_TOKEN_TYPES.indexOf('property'), 0,
    // Same line: the character is relative to the previous token's start.
    0, 6, 5, SEMANTIC_TOKEN_TYPES.indexOf('type'), 0,
    // A new line resets the character to an absolute one.
    3, 2, 4, SEMANTIC_TOKEN_TYPES.indexOf('enumMember'), 1,
    0, 7, 2, SEMANTIC_TOKEN_TYPES.indexOf('namespace'), 3,
  ]);
  assert.deepEqual(decode(data), [
    { line: 0, character: 4, length: 3, type: 'property', modifiers: [] },
    { line: 0, character: 10, length: 5, type: 'type', modifiers: [] },
    { line: 3, character: 2, length: 4, type: 'enumMember', modifiers: ['declaration'] },
    { line: 3, character: 9, length: 2, type: 'namespace', modifiers: ['declaration', 'defaultLibrary'] },
  ]);
});

test('the first token on line 0 encodes absolutely, and an overlap is dropped', () => {
  assert.deepEqual(encodeSemanticTokens([{ line: 0, character: 0, length: 2, type: 'namespace', modifiers: [] }]),
    [0, 0, 2, SEMANTIC_TOKEN_TYPES.indexOf('namespace'), 0]);
  // LSP gives no meaning to two tokens covering the same character; the earlier
  // one wins rather than the client being handed a choice.
  const overlapping = encodeSemanticTokens([
    { line: 2, character: 4, length: 6, type: 'property', modifiers: [] },
    { line: 2, character: 7, length: 3, type: 'type', modifiers: [] },
    { line: 2, character: 12, length: 3, type: 'type', modifiers: [] },
  ]);
  assert.deepEqual(decode(overlapping).map(t => t.character), [4, 12]);
});

test('tokens come back sorted by position, across every shape the walk finds', () => {
  const { tokens } = tokensOf(PLAN);
  for (let i = 1; i < tokens.length; i++) {
    const previous = tokens[i - 1], current = tokens[i];
    assert.ok(previous.line < current.line ||
      (previous.line === current.line && previous.character <= current.character),
      `token ${i} at ${current.line}:${current.character} precedes ${previous.line}:${previous.character}`);
  }
  // Several statements on one line still encode in order.
  const compact = tokensOf('plan p; attribute integer Priority = 1; feature f; Priority = 2; ' +
    'measure Line m; source = "x"; endmeasure endfeature endplan');
  assert.deepEqual(compact.listed, [
    'p/namespace/declaration',
    'Priority/property/declaration',
    'Priority/property',
    'Line/type/defaultLibrary',
  ]);
  const data = provideSemanticTokens(compact.model).data;
  // One line, so every delta line is 0 and every character delta is positive.
  assert.deepEqual(data.filter((_, i) => i % 5 === 0), [0, 0, 0, 0]);
  assert.ok(data.filter((_, i) => i % 5 === 1).every(delta => delta > 0), String(data));
});

test('the legend is one table, and every emitted index is inside it', () => {
  assert.deepEqual(SEMANTIC_TOKENS_LEGEND.tokenTypes, [...SEMANTIC_TOKEN_TYPES]);
  assert.deepEqual(SEMANTIC_TOKENS_LEGEND.tokenModifiers, [...SEMANTIC_TOKEN_MODIFIERS]);
  const data = provideSemanticTokens(parseDocument(PLAN)).data;
  for (let i = 0; i < data.length; i += 5) {
    assert.ok(data[i + 3] >= 0 && data[i + 3] < SEMANTIC_TOKEN_TYPES.length, `type index ${data[i + 3]}`);
    assert.ok(data[i + 4] >= 0 && data[i + 4] < 1 << SEMANTIC_TOKEN_MODIFIERS.length, `modifier bits ${data[i + 4]}`);
  }
});

test('the range variant answers with the window only', () => {
  const model = parseDocument(PLAN);
  const line = PLAN.split('\n').findIndex(text => text.startsWith('Priority = 2;'));
  const range = { start: { line, character: 0 }, end: { line: line + 1, character: 0 } };
  const windowed = semanticTokens(model, { range });
  assert.deepEqual(show(model, windowed), ['Priority/property', 'status/property']);
  // A range request is encoded the same way — absolute from the first token, so
  // the client can decode it without knowing what came before the window.
  assert.deepEqual(decode(provideSemanticTokens(model, { range }).data).map(t => t.line), [line, line + 1]);
});

test('the cross-file half: subplan parameters and override paths need the index', () => {
  const files = {
    'child.hvp': `plan child_plan;
attribute string root_mod = "";
attribute enum {open, closed} status = open;
feature c;
measure Line m;
source = "instance: \${root_mod}top";
endmeasure
endfeature
endplan`,
    'top.hvp': `plan top;
feature memory;
subplan child_plan #(root_mod="u0.", status=closed, nothing=1);
endfeature
endplan`,
    'mod.hvp': `override o;
top.memory.child_plan.status = closed;
absent.thing.status = open;
endoverride`,
  };
  const models = new Map(Object.entries(files).map(([name, text]) => [name, parseDocument(text)]));
  const index = buildIndex([...models].map(([name, model]) => ({ uri: `file:///plans/${name}`, model })));
  const listed = (name: string) => show(models.get(name)!, semanticTokens(models.get(name)!, { index }));

  assert.deepEqual(listed('top.hvp'), [
    'top/namespace/declaration',
    'child_plan/namespace',
    'root_mod/parameter',
    'status/parameter',
    'closed/enumMember',
    // `nothing` is not declared by child_plan, so it stays uncoloured.
  ]);
  assert.deepEqual(listed('mod.hvp'), [
    'top/namespace',
    'status/property',
    'closed/enumMember',
    // The second path names no plan the workspace instantiates: no token at all,
    // rather than one asserting which declaration it reaches.
  ]);
  // Without the index the same file resolves nothing across files.
  const alone = models.get('top.hvp')!;
  assert.deepEqual(show(alone, semanticTokens(alone)), ['top/namespace/declaration']);
});

test('a subplan naming a plan in the same file resolves without an index', () => {
  const { listed } = tokensOf(`plan child;
attribute string root_mod = "";
feature c;
measure Line m;
source = "x";
endmeasure
endfeature
endplan
plan top;
feature f;
subplan child #(root_mod="u0.");
endfeature
endplan`);
  assert.deepEqual(listed, [
    'child/namespace/declaration',
    'root_mod/property/declaration',
    'Line/type/defaultLibrary',
    'top/namespace/declaration',
    'child/namespace',
    'root_mod/parameter',
  ]);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocument } from '../src/core/parser';
import { PlanDocument, PlanNode } from '../src/core/planModel';
import { SourceText, tokenize } from '../src/core/tokenizer';
import { provideCompletionItems } from '../src/core/completion';
import { provideDocumentSymbols } from '../src/core/symbols';

type NodeOf<K extends PlanNode['kind']> = PlanNode & { kind: K };
function ofKind<K extends PlanNode['kind']>(model: PlanDocument, kind: K): NodeOf<K>[] {
  return model.nodes.filter(n => n.kind === kind) as NodeOf<K>[];
}
const errors = (model: PlanDocument) => model.diagnostics.filter(d => d.severity === 1);

test('compact measure and subplan-only features have no false diagnostics', () => {
  const model = parseDocument('plan p; feature f; measure Line m; source = "x"; endmeasure endfeature feature g; subplan child; endfeature endplan');
  assert.deepEqual(model.diagnostics, []);
  assert.equal(ofKind(model, 'measure')[0].metrics[0].text, 'Line');
  assert.equal(ofKind(model, 'source')[0].values[0].text, '"x"');
  assert.deepEqual(provideDocumentSymbols(model).map(s => s.name), ['f', 'g']);
  assert.deepEqual(model.foldingRanges, []);
});

test('model covers declarations, hierarchy, parameters, source lists and modifier branches', () => {
  const model = parseDocument(readFileSync('test/parser-fixtures/plan-model.hvp', 'utf8'));
  assert.deepEqual(model.diagnostics.map(d => d.code), ['builtin-redeclaration']);
  assert.equal(model.plans.length, 2);
  const priority = ofKind(model, 'attribute').find(n => n.name?.text === 'priority')!;
  assert.deepEqual(priority.type.members.map(m => m.name.text), ['low', 'normal', 'high', '-1']);
  assert.equal(priority.value.text, 'normal');
  assert.equal(ofKind(model, 'annotation')[0].value.text, '1');
  assert.equal(ofKind(model, 'attribute').find(n => n.name?.text === 'options')?.type.name?.text, 'set');
  const metric = ofKind(model, 'metric')[0];
  assert.equal(metric.name?.text, 'MyAgg_Line_Cond');
  assert.deepEqual(metric.type.members.map(m => [m.name.text, m.weight?.text]), [['Line', '1.0'], ['Cond', '2.0']]);
  assert.match(ofKind(model, 'goal')[0].value.text, /&&\n/);
  assert.equal(ofKind(model, 'aggregator')[0].value.text, 'average');
  assert.equal(ofKind(model, 'apply')[0].value.text, 'explicit');
  assert.deepEqual(ofKind(model, 'subplan')[0].parameters.map(p => [p.name.text, p.value.text]), [['root_mod', '"top.mem0."'], ['priority', 'high']]);
  const measure = ofKind(model, 'measure')[1];
  assert.deepEqual(measure.metrics.map(m => m.text), ['test', 'test.percent.pass', 'test.completion']);
  assert.deepEqual(measure.metrics[1].segments.map(s => s.text), ['test', 'percent', 'pass']);
  assert.deepEqual(ofKind(model, 'source')[1].values.map(v => v.text), ['"test1"', '"test3"', '"test7"']);
  const until = ofKind(model, 'until')[0];
  assert.deepEqual(until.children.map(n => n.kind === 'branch' && n.branchKind), ['until', 'elseuntil', 'else']);
  assert.equal(ofKind(model, 'branch')[0].date?.text, '12-31-2026');
  assert.equal(until.children[1].children[0].kind, 'override');
  const path = ofKind(model, 'assignment').find(n => n.target.text === 'cpu_plan.cpu?.*.Line')!;
  assert.deepEqual(path.target.segments.map(s => s.text), ['cpu_plan', 'cpu?', '*', 'Line']);
  assert.equal(ofKind(model, 'remove')[0].condition.text, 'priority == low');
  assert.equal(model.enclosingFeature(measure.name!.start)?.id, measure.parentId);
  assert.equal(model.enclosingPlan(measure.name!.start)?.id, model.plans[1].id);
  for (const node of model.nodes) {
    assert.ok(node.start <= node.end);
    assert.equal(model.source.offsetAt(node.range.start), node.start);
    assert.equal(model.source.offsetAt(node.range.end), node.end);
    if (node.parentId !== undefined) {
      const parent = model.parent(node)!;
      assert.ok(parent.start <= node.start && parent.end >= node.end);
    }
  }
});

test('tokenizer shields escaped quotes, comments, delimiters and multiline strings', () => {
  const text = 'plan p; /* endplan;\n feature fake; */ feature f; measure Line m; source = "a\\"; // endmeasure\n ${name} /*x*/"; endmeasure endfeature endplan';
  const model = parseDocument(text);
  assert.deepEqual(model.diagnostics, []);
  assert.equal(ofKind(model, 'feature').length, 1);
  assert.equal(ofKind(model, 'source')[0].values.length, 1);
  assert.ok(model.maskedAt(text.indexOf('fake')));
  assert.ok(model.maskedAt(text.indexOf('${name}')));
  assert.equal(model.maskedAt(text.indexOf('endfeature')), false);
});

test('ranges use UTF-16 offsets and preserve CRLF and non-ASCII source text', () => {
  const text = 'plan p;\r\nfeature f; measure Line m; source = "😀é"; endmeasure endfeature\r\nendplan';
  const model = parseDocument(text);
  assert.deepEqual(model.diagnostics, []);
  const value = ofKind(model, 'source')[0].values[0];
  assert.equal(text.slice(value.start, value.end), '"😀é"');
  assert.equal(value.range.end.character - value.range.start.character, 5);
  assert.equal(model.source.positionAt(text.indexOf('endplan')).line, 2);
  assert.equal(model.source.offsetAt(value.range.end), value.end);
});

test('recovery keeps following statements after missing semicolons and delimiters', () => {
  const model = parseDocument('plan p; attribute enum {a, b\nfeature f;\nowner = "x"\nweight = 2;\nsubplan child; endfeature endplan');
  assert.ok(errors(model).some(d => d.message.includes("Unclosed '{'")));
  assert.equal(errors(model).filter(d => d.message.includes('semicolon')).length, 2);
  assert.equal(ofKind(model, 'feature').length, 1);
  assert.deepEqual(ofKind(model, 'assignment').map(n => n.target.text), ['owner', 'weight']);
  assert.equal(ofKind(model, 'subplan').length, 1);
  assert.equal(ofKind(model, 'plan')[0].close?.text, 'endplan');
});

test('unclosed, mismatched and orphan blocks have bounded diagnostics and folds', () => {
  const mismatch = parseDocument('plan p; feature f; endmetric endplan endfeature');
  assert.equal(errors(mismatch).length, 2);
  assert.match(errors(mismatch)[0].message, /Mismatched close: expected 'endfeature'/);
  assert.match(errors(mismatch)[1].message, /no matching 'feature'/);
  assert.deepEqual(mismatch.foldingRanges, []);
  const unclosed = parseDocument('plan p;\nfeature f;\nsubplan child;');
  assert.equal(errors(unclosed).length, 2);
  assert.equal(unclosed.nodeAt(unclosed.source.text.length)?.kind, 'feature');
  assert.deepEqual(unclosed.blocksAt(unclosed.source.text.length), ['plan', 'feature']);
  const matched = parseDocument('plan p;\nfeature f;\nsubplan child;\nendfeature\nendplan');
  assert.deepEqual(matched.foldingRanges, [{ startLine: 1, endLine: 3 }, { startLine: 0, endLine: 4 }]);
});

test('completion uses cursor scope on a compact line and suppresses strings with spaces', () => {
  const text = 'plan p; feature f; measure Line m; source = "a b"; endmeasure endfeature endplan';
  const model = parseDocument(text);
  const itemsAt = (offset: number) => provideCompletionItems(model, model.source.positionAt(offset));
  assert.equal(itemsAt(text.indexOf('source')).find(i => i.label === 'source')?.sortText, '0_source');
  assert.deepEqual(itemsAt(text.indexOf('b"')), []);
  assert.deepEqual(model.blocksAt(text.indexOf('endfeature')), ['plan', 'feature']);
  assert.deepEqual(model.blocksAt(text.length), []);
});

test('unterminated lexical tokens and incomplete input always yield a partial model', () => {
  for (const text of ['plan p; /* unfinished', 'plan p; owner = "unfinished']) {
    const model = parseDocument(text);
    assert.ok(errors(model).some(d => d.message.startsWith('Unterminated')));
    assert.ok(model.maskedAt(text.length));
    assert.equal(model.plans.length, 1);
  }
  const sample = 'plan p; feature f; subplan child #(x="v", y=2); endfeature endplan';
  for (let end = 0; end <= sample.length; end++) {
    const model = parseDocument(sample.slice(0, end));
    assert.ok(model.nodes.every(n => n.end <= end));
  }
  assert.equal(tokenize(new SourceText('// only a comment')).tokens.length, 1);
});

test('opaque expressions and semantic errors are preserved for later workstreams', () => {
  const model = parseDocument(`plan p;
undeclared = 7;
attribute integer team = "wrong";
feature f;
attribute string misplaced = "accepted syntactically";
subplan unresolved;
endfeature
metric integer Score;
goal = match(owner, "b*") || Score inside {1:10};
endmetric
endplan`);
  assert.deepEqual(model.diagnostics.map(d => d.code), ['invalid-placement', 'unknown-assignment-target', 'invalid-value']);
  assert.equal(ofKind(model, 'assignment')[0].value.text, '7');
  assert.equal(ofKind(model, 'attribute')[0].value.text, '"wrong"');
  assert.equal(ofKind(model, 'goal')[0].value.text, 'match(owner, "b*") || Score inside {1:10}');
});

test('completion on the final empty line keeps the open feature context', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = `plan p;${newline}feature f;${newline}`;
    const model = parseDocument(text);
    const items = provideCompletionItems(model, { line: 2, character: 0 });
    assert.equal(items.find(i => i.label === 'measure')?.sortText, '0_measure');
  }
});

test('a statement keyword on a new line ends the unterminated statement above it', () => {
  const typo = parseDocument('plan p;\nfeature f;\nmeas\nmeasure Line m;\nsource = "x";\nendmeasure\nendfeature\nendplan');
  assert.equal(errors(typo).length, 1);
  assert.match(errors(typo)[0].message, /missing a terminating semicolon/);
  assert.equal(errors(typo)[0].range.start.line, 2);
  assert.equal(ofKind(typo, 'measure')[0].name?.text, 'm');

  const dangling = parseDocument('plan p;\nfeature f;\nowner =\nmeasure Line m;\nsource = "x";\nendmeasure\nendfeature\nendplan');
  assert.equal(errors(dangling).length, 1);
  assert.equal(errors(dangling)[0].range.start.line, 2);
  assert.deepEqual(ofKind(dangling, 'assignment').map(n => n.target.text), ['owner']);
  assert.equal(ofKind(dangling, 'measure')[0].name?.text, 'm');
});

test('source, goal, aggregator and apply start a statement only at the head of a line', () => {
  const measure = parseDocument('plan p;\nfeature f;\nmeasure Line m\nsource = "x";\nendmeasure\nendfeature\nendplan');
  assert.equal(errors(measure).length, 1);
  assert.match(errors(measure)[0].message, /missing a terminating semicolon/);
  assert.equal(errors(measure)[0].range.start.line, 2);
  assert.equal(ofKind(measure, 'measure')[0].name?.text, 'm');
  assert.deepEqual(ofKind(measure, 'source')[0].values.map(v => v.text), ['"x"']);
  assert.deepEqual(measure.diagnostics.filter(d => d.severity === 2), []);

  const metric = parseDocument('plan p;\nmetric integer Score\ngoal = 1;\naggregator = sum;\napply = explicit;\nendmetric\nendplan');
  assert.equal(errors(metric).length, 1);
  assert.equal(ofKind(metric, 'metric')[0].name?.text, 'Score');
  assert.equal(ofKind(metric, 'goal')[0].value.text, '1');
  assert.equal(ofKind(metric, 'aggregator')[0].value.text, 'sum');
  assert.equal(ofKind(metric, 'apply')[0].value.text, 'explicit');

  // Preserve reserved declaration names so structural validation can report them.
  const named = parseDocument('plan p;\nattribute string source = "x";\nendplan');
  assert.deepEqual(named.diagnostics.map(d => d.code), ['invalid-identifier']);
  assert.equal(ofKind(named, 'attribute')[0].name?.text, 'source');
  assert.equal(ofKind(named, 'attribute')[0].value.text, '"x"');
});

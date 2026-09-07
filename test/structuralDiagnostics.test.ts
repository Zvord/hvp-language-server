import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../src/core/parser';
import { provideCompletionItems } from '../src/core/completion';
import { BUILTIN_METRICS } from '../src/core/keywords';

const checked = (text: string) => parseDocument(text).diagnostics.filter(d => d.code);

test('identifier validation covers complete names and reserved words with exact ranges', () => {
  for (const name of ['9bad', 'bad-name', 'bad.name', 'bad name', 'é', '"quoted"', 'feature', 'endplan']) {
    for (const header of [`feature ${name}`, `attribute integer ${name} = 1`, `metric enum {a,b} ${name}`, `measure Line ${name}`]) {
      const text = `plan p; ${header};`;
      const diagnostics = checked(text).filter(d => d.code === 'invalid-identifier');
      assert.equal(diagnostics.length, 1, header);
      assert.equal(text.slice(diagnostics[0].range.start.character, diagnostics[0].range.end.character), name, header);
    }
  }
  assert.deepEqual(checked('plan _p1; attribute integer Phase_2 = 1; feature F; measure Line, test.percent.pass _m2; source = "x"; endmeasure endfeature endplan'), []);
  assert.equal(checked('plan ;')[0].code, 'invalid-identifier');
});

test('duplicates use plan declaration and sibling feature/measure scopes', () => {
  const text = `plan child;
attribute integer x = 1; annotation string x = ""; metric integer x; endmetric
annotation string note = ""; annotation string note = "";
metric integer Score; endmetric metric integer Score; endmetric
feature f; measure Line m; source = "x"; endmeasure measure Cond m; source = "y"; endmeasure endfeature
feature f; measure Line m; source = "x"; endmeasure
feature f; subplan external; endfeature endfeature
endplan
plan main; attribute integer x = 2; feature f; subplan child; endfeature endplan`;
  assert.deepEqual(checked(text).map(d => d.code), Array(6).fill('duplicate-declaration'));
});

test('all built-in redeclarations warn, while custom phase is valid', () => {
  for (const name of ['owner', 'at_least', 'weight', 'description', ...BUILTIN_METRICS.map(m => m.name)]) {
    const ds = checked(`plan p; metric integer ${name}; endmetric endplan`);
    const warning = ds.find(d => d.code === 'builtin-redeclaration');
    assert.equal(warning?.severity, 2, name);
  }
  assert.deepEqual(checked('plan p; attribute integer phase = 2; endplan'), []);
});

test('placement requires the immediate allowed parent, including modifier branches', () => {
  const statements = ['attribute integer x = 0;', 'annotation string x = "";', 'metric integer M; endmetric',
    'measure Line m; source = "x"; endmeasure', 'goal = 1;', 'aggregator = sum;', 'apply = explicit;',
    'keep feature where x == 1;', 'remove feature where x == 1;'];
  for (const statement of statements) {
    assert.equal(checked(statement).filter(d => d.code === 'invalid-placement').length, 1, statement);
    assert.equal(checked(`plan p; until 12-31-2026; ${statement} enduntil endplan`).filter(d => d.code === 'invalid-placement').length, 1, statement);
  }
  assert.deepEqual(checked(`plan p; attribute integer x = 1; annotation string n = "";
metric integer M; goal = 1; aggregator = sum; apply = explicit; endmetric
feature f; measure M m; source = "x"; endmeasure endfeature
filter F; keep feature where x == 1; remove feature where x == 2; endfilter endplan`), []);
});

test('only the last local plan can remain unreferenced, with forward references allowed', () => {
  assert.deepEqual(checked('plan A; endplan plan B; endplan plan C; endplan').map(d => d.code), ['unreferenced-plan', 'unreferenced-plan']);
  assert.deepEqual(checked('plan A; feature f; subplan B; endfeature endplan plan B; endplan plan C; feature f; subplan A; endfeature endplan'), []);
  assert.equal(checked('plan A; endplan // subplan A;\nplan B; description = "subplan A;"; endplan')[0].code, 'unreferenced-plan');
});

test('completion boosts declarations only in plans and offers only the innermost closer', () => {
  for (const [text, closer, boosted] of [
    ['', undefined, false], ['plan p; ', 'endplan', true],
    ['plan p; feature f; ', 'endfeature', false],
    ['plan p; feature f; measure Line m; ', 'endmeasure', false],
    ['plan p; until 12-31-2026; else; ', 'enduntil', false],
    ['plan p; feature f; endfeature ', 'endplan', true],
    ['plan p; endplan ', undefined, false],
  ] as const) {
    const model = parseDocument(text);
    const items = provideCompletionItems(model, model.source.positionAt(text.length));
    assert.deepEqual(items.filter(i => i.label.startsWith('end')).map(i => i.label), closer ? [closer] : []);
    for (const name of ['attribute', 'annotation', 'metric']) {
      assert.equal(items.find(i => i.label === name)?.sortText, `${boosted ? '0_' : '9_'}${name}`);
    }
    assert.ok(!items.some(i => i.label === 'phase'));
  }
});

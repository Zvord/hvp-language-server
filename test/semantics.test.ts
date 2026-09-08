// WS2: attribute/annotation declarations, value typing, inheritance and hover.
import assert from 'node:assert/strict';
import test from 'node:test';
import { provideCompletionItems } from '../src/core/completion';
import { scopeAt } from '../src/core/declarations';
import { provideHover } from '../src/core/hover';
import { parseDocument } from '../src/core/parser';
import { PlanDocument, PlanNode } from '../src/core/planModel';
import { resolveValues } from '../src/core/resolver';

const codes = (text: string) => parseDocument(text).diagnostics.filter(d => d.code).map(d => d.code);
const featureNamed = (model: PlanDocument, name: string): PlanNode =>
  model.nodes.find(n => n.kind === 'feature' && 'name' in n && n.name?.text === name)!;
const hoverAt = (model: PlanDocument, text: string, needle: string, uri?: string) =>
  provideHover(model, model.source.positionAt(text.indexOf(needle)), { uri });
const hoverText = (model: PlanDocument, text: string, needle: string, uri?: string) =>
  (hoverAt(model, text, needle, uri)!.contents as { value: string }).value;

const HIERARCHY = `plan cpu_plan;
attribute integer phase = 1;
attribute enum {low, normal, high} priority = normal;
attribute string root_mod = "";
annotation string note = "";
feature cpu;
owner = "Verification";
phase = 2;
feature memory;
priority = high;
note = "local";
feature read;
measure Line m; source = "x"; endmeasure
endfeature
endfeature
endfeature
endplan`;

test('the declaration table merges built-ins with per-plan declarations', () => {
  const model = parseDocument(HIERARCHY);
  const scope = scopeAt(model, model.source.text.indexOf('feature cpu'));
  const priority = scope.declarations.get('priority')!;
  assert.deepEqual([priority.kind, priority.type, priority.defaultText, priority.builtin],
    ['attribute', 'enum', 'normal', false]);
  assert.deepEqual(priority.members, ['low', 'normal', 'high']);
  assert.deepEqual(scope.declarations.get('weight'), { name: 'weight', kind: 'annotation', type: 'real', members: [], defaultText: '1', builtin: true });
  assert.equal(scope.declarations.get('Line')?.kind, 'metric');
  // A redeclaration replaces the built-in it shadows; WS1 warns about it separately.
  const shadowed = parseDocument('plan p; annotation integer weight = 1; endplan');
  assert.equal(scopeAt(shadowed, 10).declarations.get('weight')?.type, 'integer');
});

test('declaration defaults and assignments are typed against the declaration', () => {
  assert.deepEqual(codes('plan p; attribute integer team = "wrong"; endplan'), ['invalid-value']);
  assert.deepEqual(codes('plan p; attribute real fraction = 1; attribute integer n = -3; attribute string s = ""; endplan'), []);
  assert.deepEqual(codes('plan p; attribute enum {a, b, -1} e = -1; endplan'), []);
  assert.deepEqual(codes('plan p; attribute enum {a, b} e = c; endplan'), ['invalid-value']);
  assert.deepEqual(codes('plan p; attribute integer n; endplan'), ['invalid-value']);
  assert.deepEqual(codes('plan p; attribute enum {a, b} e = a; feature f; e = b; endfeature endplan'), []);
  assert.deepEqual(codes('plan p; attribute enum {a, b} e = a; feature f; e = z; endfeature endplan'), ['invalid-value']);
  assert.deepEqual(codes('plan p; feature f; weight = "heavy"; description = 2; endfeature endplan'), ['invalid-value', 'invalid-value']);
  // `set` has no documented literal shape, and interpolated or expression-shaped
  // values are never literals, so neither is type-checked.
  assert.deepEqual(codes('plan p; attribute set options = anything; attribute string s = ""; feature f; s = "${options}x"; endfeature endplan'), []);
});

test('assignments to undeclared names are reported, goal overrides are not', () => {
  assert.deepEqual(codes('plan p; undeclared = 7; endplan'), ['unknown-assignment-target']);
  assert.deepEqual(codes('plan p; feature f; Group = Group >= 0.8; test = test.fail <= 1; endfeature endplan'), []);
  assert.deepEqual(codes('plan p; metric integer Score; endmetric feature f; Score = Score > 3; endfeature endplan'), []);
  assert.deepEqual(codes('plan p; feature f; test.expected = 100; endfeature endplan'), []);
  // Modifier blocks address the instantiated hierarchy by path; that is WS7's.
  assert.deepEqual(codes('override o; p.f.Priority = 5; endoverride'), []);
  assert.deepEqual(codes('plan p; attribute integer x = 0; override o; p.f.x = 5; endoverride endplan'), []);
  // Declared in a sibling plan is still undeclared here.
  assert.deepEqual(codes('plan b; x = 1; endplan plan a; attribute integer x = 0; feature f; subplan b; endfeature endplan'), ['unknown-assignment-target']);
  // A statement the parser recovered from is not also reported semantically.
  assert.deepEqual(codes('plan p; feature f;\nowner =\nmeasure Line m; source = "x"; endmeasure endfeature endplan'), []);
});

test('attributes inherit down the hierarchy while annotations stay local', () => {
  const model = parseDocument(HIERARCHY);
  const shown = (feature: string) => Object.fromEntries(resolveValues(model, featureNamed(model, feature))
    .map(v => [v.declaration.name, [v.text, v.origin.kind === 'assignment' ? `${v.origin.local ? 'in' : 'from'} ${v.origin.scope}` : v.origin.kind]]));
  assert.deepEqual(shown('read').phase, ['2', 'from cpu']);
  assert.deepEqual(shown('read').priority, ['high', 'from cpu.memory']);
  assert.deepEqual(shown('read').owner, ['"Verification"', 'from cpu']);
  assert.deepEqual(shown('read').root_mod, ['""', 'default']);
  // The annotation assigned in cpu.memory is not visible in its child.
  assert.deepEqual(shown('memory').note, ['"local"', 'in cpu.memory']);
  assert.deepEqual(shown('read').note, ['""', 'default']);
  assert.deepEqual(shown('cpu').phase, ['2', 'in cpu']);
});

test('the resolver takes instance parameters and overrides for WS5 and WS7', () => {
  const model = parseDocument(HIERARCHY);
  const values = resolveValues(model, featureNamed(model, 'read'), {
    instancePath: ['top', 'mem0'],
    parameters: new Map([['root_mod', '"top.mem0."'], ['phase', '9']]),
    overrides: [{ name: 'priority', text: 'low', label: 'override patch' }],
  });
  const of = (name: string) => values.find(v => v.declaration.name === name)!;
  assert.deepEqual([of('root_mod').text, of('root_mod').origin], ['"top.mem0."', { kind: 'parameter', label: 'subplan parameter' }]);
  // An assignment written inside the plan still wins over the parameter.
  assert.equal(of('phase').text, '2');
  assert.deepEqual([of('priority').text, of('priority').origin.kind], ['low', 'override']);
  // Annotations never take subplan parameters.
  assert.equal(resolveValues(model, featureNamed(model, 'read'), { parameters: new Map([['note', '"p"']]) })
    .find(v => v.declaration.name === 'note')!.origin.kind, 'default');
});

test('hover reports effective values with their origin, and links when a URI is given', () => {
  const model = parseDocument(HIERARCHY);
  const feature = hoverAt(model, HIERARCHY, 'read', 'file:///t.hvp')!;
  assert.deepEqual(feature.range, model.source.span(HIERARCHY.indexOf('read'), HIERARCHY.indexOf('read') + 4).range);
  const lines = (feature.contents as { value: string }).value.split('\n');
  assert.equal(lines[0], '**Feature** `cpu.memory.read`');
  assert.ok(lines.includes('| `priority` | `high` | [inherited from cpu.memory](file:///t.hvp#L10,1) |'), lines.join('\n'));
  assert.ok(lines.includes('| `owner` | `"Verification"` | [inherited from cpu](file:///t.hvp#L7,1) |'), lines.join('\n'));
  // A declared default links to its declaration; a built-in has none to link to.
  assert.ok(lines.includes('| `note` | `""` | [declaration default](file:///t.hvp#L5,19) |'), lines.join('\n'));
  assert.ok(lines.includes('| `at_least` | `0` | declaration default |'), lines.join('\n'));
  assert.ok(lines.indexOf('| Annotation | Effective value | Origin |') > lines.indexOf('| Attribute | Effective value | Origin |'));
  // Without a URI the same origins stay plain text.
  assert.match(hoverText(model, HIERARCHY, 'read'), /\| `priority` \| `high` \| inherited from cpu\.memory \|/);
});

test('hover on an assignment and on a declaration shows the declaration', () => {
  const model = parseDocument(HIERARCHY);
  const assignment = hoverText(model, HIERARCHY, 'phase = 2');
  assert.match(assignment, /\*\*attribute\*\* `integer phase`/);
  assert.match(assignment, /declared in plan cpu_plan · default `1`/);
  assert.match(assignment, /Effective value here: `2` \(assigned in cpu\)/);
  const declaration = hoverText(model, HIERARCHY, 'priority = normal');
  assert.match(declaration, /\*\*attribute\*\* `enum \{low, normal, high\} priority`/);
  assert.match(hoverText(model, HIERARCHY, 'owner = '), /built-in · default `""`/);
  const goal = 'plan p; feature f; Group = Group >= 0.8; endfeature endplan';
  assert.match(hoverText(parseDocument(goal), goal, 'Group = '), /Feature-level goal override/);
  const unknown = 'plan p; feature f; nope = 1; endfeature endplan';
  assert.match(hoverText(parseDocument(unknown), unknown, 'nope'), /`nope` is not declared/);
  // Nothing to say inside a string, a comment, or on a block keyword.
  assert.equal(hoverAt(model, HIERARCHY, 'Verification'), undefined);
  assert.equal(hoverAt(model, HIERARCHY, 'endplan'), undefined);
});

test('completion offers declared names in features and enum members after =', () => {
  const model = parseDocument(HIERARCHY);
  const itemsAt = (needle: string) => provideCompletionItems(model, model.source.positionAt(HIERARCHY.indexOf(needle)));
  const inFeature = itemsAt('feature read');
  for (const name of ['phase', 'priority', 'root_mod', 'note']) {
    assert.equal(inFeature.find(i => i.label === name)?.sortText, `0_${name}`, name);
  }
  // Built-ins keep coming from BUILTIN_FIELDS, so they are offered exactly once.
  assert.deepEqual(inFeature.filter(i => i.label === 'owner').length, 1);

  const declaration = 'plan p; attribute enum {low, normal, high} priority = normal; feature f; ';
  const offered = (tail: string) => {
    const text = declaration + tail;
    const model = parseDocument(text);
    return provideCompletionItems(model, model.source.positionAt(text.length));
  };
  const members = offered('priority = ');
  assert.deepEqual(members.filter(i => i.sortText?.startsWith('0_') && i.kind === 20).map(i => i.label), ['low', 'normal', 'high']);
  // Declaration names are not boosted in a value position.
  assert.equal(members.find(i => i.label === 'priority')?.sortText, '9_priority');

  // The value position is found on the token stream, so the statement layout —
  // a newline or a comment between `=` and the cursor — makes no difference.
  const enumMembers = (tail: string) =>
    offered(tail).filter(i => i.detail?.startsWith('Member of enum')).map(i => i.label);
  for (const tail of ['priority = ', 'priority =\n  ', 'priority = /* pick one */ ', 'priority = // pick one\n', 'priority = n']) {
    assert.deepEqual(enumMembers(tail), ['low', 'normal', 'high'], JSON.stringify(tail));
  }
  // Past the value, and outside a value position, no members are offered.
  assert.deepEqual(enumMembers('priority = low; '), []);
  assert.deepEqual(enumMembers(''), []);
});

// Regressions from the WS2 code review.

test('assignments no plan declares are left to WS5 instead of reported', () => {
  // A modifier file names attributes the plan it modifies declares.
  assert.deepEqual(codes('until 12-31-2026;\nPriority = 1;\nelse;\nPriority = 2;\nenduntil'), []);
  assert.deepEqual(codes('Priority = 1;'), []);
  assert.deepEqual(codes('override A;\nPriority = 1;\nendoverride'), []);
  // Inside a plan the name is checkable, including through an until branch.
  assert.deepEqual(codes('plan p; feature f; until 12-31-2026; Nope = 1; enduntil endfeature endplan'),
    ['unknown-assignment-target']);
});

test('hover states an effective value only where the resolver accounts for one', () => {
  const measure = `plan p;
attribute integer w = 0;
feature f;
w = 1;
measure Line m;
source = "x";
w = 5;
endmeasure
endfeature
endplan`;
  // The measure-local assignment is not one the resolver sees, so claiming the
  // feature's value here would contradict the statement under the cursor.
  const local = hoverText(parseDocument(measure), measure, 'w = 5');
  assert.match(local, /\*\*attribute\*\* `integer w`/);
  assert.doesNotMatch(local, /Effective value here/);
  // Same for a modifier block, whose paths only WS7 resolves.
  const override = 'plan p; attribute integer w = 0; feature f; override A; w = 5; endoverride endfeature endplan';
  assert.doesNotMatch(hoverText(parseDocument(override), override, 'w = 5'), /Effective value here/);
  // And nothing is asserted about a name the modified plan declares.
  const modifier = 'override A;\nPriority = 5;\nendoverride';
  assert.equal(hoverAt(parseDocument(modifier), modifier, 'Priority'), undefined);
  // A plain feature-level assignment still reports its value.
  assert.match(hoverText(parseDocument(measure), measure, 'w = 1'), /Effective value here: `1` \(assigned in f\)/);
});

test('hover markup survives parentheses in the URI and backticks in the value', () => {
  const source = 'plan p;\nattribute string pat = "`r`abc";\nfeature f;\nendfeature\nendplan';
  const model = parseDocument(source);
  const table = hoverText(model, source, 'f;', 'file:///My (old)/t.hvp');
  // Parentheses would otherwise end the link destination at the first ')'.
  assert.match(table, /\[declared in plan p\]\(file:\/\/\/My %28old%29\/t\.hvp#L2,\d+\)|declaration default\]\(file:\/\/\/My %28old%29/);
  // The value's own backticks must not close its code span.
  assert.match(table, /\| ``"`r`abc"`` \|/);
});

test('a value position ends at the previous statement instead of gluing identifiers', () => {
  const text = `plan p;
attribute enum {slow, fast} speed = slow;
attribute enum {low, high} pri = low;
feature f;
pri = low
speed = `;
  const model = parseDocument(text);
  const items = provideCompletionItems(model, model.source.positionAt(text.length));
  // The missing semicolon must not make the target `lowspeed`.
  assert.deepEqual(items.filter(i => i.detail?.startsWith('Member of enum')).map(i => i.label), ['slow', 'fast']);
});

test('a label is offered once, and a declared name wins over the keyword it shadows', () => {
  const text = 'plan p; attribute enum {sum, max} agg = sum; feature f; agg = ';
  const model = parseDocument(text);
  const items = provideCompletionItems(model, model.source.positionAt(text.length));
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  assert.deepEqual([...counts].filter(([, n]) => n > 1), []);
  // `sum` is also an aggregator keyword; the boosted enum member is what shows.
  assert.equal(items.find(i => i.label === 'sum')?.detail, "Member of enum 'agg'");
});

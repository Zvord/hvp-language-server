// WS7: the override, filter and until modifiers.
//
// Every workspace here is built from strings through `buildIndex`, like
// `workspace.test.ts` and `navigation.test.ts`, so nothing in this file touches
// disk — and every date is injected, so nothing reads a clock either.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scopeOf } from '../src/core/declarations';
import { CompletionItemKind } from 'vscode-languageserver-types';
import { provideCompletionItems } from '../src/core/completion';
import { provideHover } from '../src/core/hover';
import {
  ModifierEvaluation,
  evaluateModifiers,
  isDateProblem,
  liveBranch,
  modifierStatements,
  parseDate,
  pathMatcher,
  resolveOverride,
  scopeUniverse,
  untilBlocks,
} from '../src/core/modifiers';
import { parseDocument } from '../src/core/parser';
import { PlanDocument, PlanNode } from '../src/core/planModel';
import { resolveValue, resolveValues } from '../src/core/resolver';
import { WorkspaceIndex, buildIndex, contextOf } from '../src/core/workspace';
import { workspaceDiagnostics } from '../src/core/workspaceDiagnostics';

const FIXED = new Date(2026, 8, 9); // 09-09-2026, so nothing here moves with the calendar.

function workspace(files: Record<string, string>) {
  const models = new Map(Object.entries(files).map(([name, text]) => [name, parseDocument(text)]));
  const uri = (name: string) => `file:///plans/${name}`;
  const index = buildIndex([...models].map(([name, model]) => ({ uri: uri(name), model })));
  return {
    index,
    uri,
    model: (name: string) => models.get(name)!,
    /** Everything the document says on its own, plus the workspace pass. */
    codes: (name: string, now: Date = FIXED) =>
      workspaceDiagnostics(models.get(name)!, uri(name), index, { now }).filter(d => d.code).map(d => d.code),
    messages: (name: string, now: Date = FIXED) =>
      workspaceDiagnostics(models.get(name)!, uri(name), index, { now }).filter(d => d.code).map(d => d.message),
    evaluate: (modifierFiles: string[], date?: string): ModifierEvaluation | undefined =>
      evaluateModifiers(index, { files: modifierFiles.map(uri), date, now: FIXED }),
    hover: (name: string, needle: string, modifiers?: ModifierEvaluation) => {
      const model = models.get(name)!;
      const offset = files[name].indexOf(needle);
      const hover = provideHover(model, model.source.positionAt(offset), { uri: uri(name), index, modifiers });
      return (hover?.contents as { value: string } | undefined)?.value ?? '';
    },
  };
}

const featureNamed = (model: PlanDocument, name: string): PlanNode =>
  model.nodes.find(n => n.kind === 'feature' && 'name' in n && n.name?.text === name)!;

/** The value `name` takes at a feature, with the preview's overrides applied —
 * the same seam `hover.ts` fills, so the test reads what the editor shows. */
function valueAt(index: WorkspaceIndex, model: PlanDocument, feature: string, path: string,
                 name: string, evaluation: ModifierEvaluation) {
  const node = featureNamed(model, feature);
  const instance = index.instances().find(i => [...i.path, i.plan.name].join('.') === path.split('.').slice(0, -1).join('.')
    || [...i.path, i.plan.name].join('.') === path)!;
  const value = resolveValue(model, node, name, {
    ...contextOf(instance),
    overrides: evaluation.overridesAt(path, scopeOf(model, node)),
  });
  return value && [value.text, value.origin.kind];
}

// ---------------------------------------------------------------------------
// Table 5 wildcards
// ---------------------------------------------------------------------------

test('Table 5 wildcards match within and across hierarchy segments', () => {
  const cases: [string[], string, boolean][] = [
    [['top', 'u?'], 'top.u1', true],
    [['top', 'u?'], 'top.u12', false],
    [['top', 'u?'], 'top.u1.deep', false],
    [['top', '*'], 'top.anything', true],
    [['top', '*'], 'top.a.b', false],           // `*` stays inside one segment.
    [['top', '**'], 'top.a.b.c', true],         // `**` crosses them.
    [['top', '**'], 'top', false],              // and the dots around it remain.
    [['top', 'cpu*'], 'top.cpu_core', true],
    [['top', 'cpu*'], 'top.mem', false],
    [['**'], 'anything.at.all', true],
    [['top.plus'], 'top.plus', true],           // A literal dot is not a wildcard.
  ];
  for (const [segments, path, expected] of cases) {
    assert.equal(pathMatcher(segments).matches(path), expected, `${segments.join('.')} vs ${path}`);
  }
  // `covers` is the propagating form: the pattern names the path or an ancestor.
  const matcher = pathMatcher(['top', 'sub']);
  assert.equal(matcher.covers('top.sub'), true);
  assert.equal(matcher.covers('top.sub.leaf.deeper'), true);
  assert.equal(matcher.covers('top.subterranean'), false);
});

test('an override path resolves against the instantiated hierarchy, wildcards included', () => {
  const files = workspace({
    'top.hvp': 'plan top;\nfeature u1;\nsubplan leaf;\nendfeature\nfeature u2;\nsubplan leaf;\nendfeature\nendplan\n',
    'leaf.hvp': 'plan leaf;\nattribute integer weight = 1;\nfeature a;\nmeasure Line m; source = "x"; endmeasure\nendfeature\nendplan\n',
  });
  // One instance at a time: the plan instance, then the features inside it.
  assert.deepEqual(scopeUniverse(files.index).map(s => s.path),
    ['top', 'top.u1', 'top.u2', 'top.u1.leaf', 'top.u1.leaf.a', 'top.u2.leaf', 'top.u2.leaf.a']);

  const resolve = (text: string) => {
    const model = parseDocument(`override o;\n${text}\nendoverride\n`);
    const statement = modifierStatements(model).overrides[0];
    return resolveOverride(files.index, statement);
  };
  assert.deepEqual(resolve('top.*.leaf.weight = 2;').scopes.map(s => s.path), ['top.u1.leaf', 'top.u2.leaf']);
  assert.deepEqual(resolve('top.u?.leaf.weight = 2;').scopes.map(s => s.path), ['top.u1.leaf', 'top.u2.leaf']);
  assert.deepEqual(resolve('top.**.weight = 2;').scopes.map(s => s.path),
    ['top.u1', 'top.u2', 'top.u1.leaf', 'top.u1.leaf.a', 'top.u2.leaf', 'top.u2.leaf.a']);
  assert.equal(resolve('top.u1.leaf.weight = 2;').declaration?.name, 'weight');
  // A path into a plan the workspace does not have, and a name the plan it
  // reaches does not declare, are two different answers.
  assert.deepEqual(resolve('nowhere.weight = 2;').problem, { kind: 'unknown-plan', plan: 'nowhere' });
  assert.deepEqual(resolve('top.u9.leaf.weight = 2;').problem, { kind: 'unresolved' });
  assert.deepEqual(resolve('top.u1.leaf.nosuch = 2;').problem, { kind: 'unknown-target', plans: ['leaf'] });
});

test('unresolved override paths are reported, as warnings, and only with a hierarchy to check against', () => {
  const files = workspace({
    'top.hvp': 'plan top;\nattribute integer weight = 1;\nfeature a;\nmeasure Line m; source = "x"; endmeasure\nendfeature\nendplan\n',
    'mods.hvp': 'override o;\ntop.a.weight = 2;\ntop.zz.weight = 2;\nnope.weight = 2;\ntop.a.nosuch = 2;\nendoverride\n',
  });
  assert.deepEqual(files.codes('mods.hvp'),
    ['unresolved-override-path', 'unresolved-override-path', 'unresolved-override-path']);
  const diagnostics = workspaceDiagnostics(files.model('mods.hvp'), files.uri('mods.hvp'), files.index, { now: FIXED })
    .filter(d => d.code === 'unresolved-override-path');
  assert.ok(diagnostics.every(d => d.severity === 2), 'a modifier file may target a plan set the workspace lacks');
  assert.match(diagnostics[1].message, /Unknown plan 'nope'/);
  assert.match(diagnostics[2].message, /'nosuch' is not an attribute, annotation or metric of plan 'top'/);

  // With nothing instantiated there is no hierarchy to check against, so the
  // same file says nothing at all.
  const alone = workspace({ 'mods.hvp': 'override o;\ntop.a.weight = 2;\nendoverride\n' });
  assert.deepEqual(alone.codes('mods.hvp'), []);
});

// ---------------------------------------------------------------------------
// Ordered application
// ---------------------------------------------------------------------------

// The chapter's own worked example, verbatim apart from the plan names it never
// spells: an attribute override of a child followed by one of its parent.
const TOP = 'plan topplan;\nfeature f;\nsubplan subplan1;\nendfeature\nendplan\n';
const SUB = `plan subplan1;
attribute string owner = "";
annotation string note = "none";
feature mem;
measure Line m; source = "a"; endmeasure
endfeature
feature io;
measure Line m; source = "b"; endmeasure
endfeature
endplan
`;

test('an attribute override propagates down, so a later ancestor supersedes an earlier descendant', () => {
  const files = workspace({
    'top.hvp': TOP,
    'sub.hvp': SUB,
    'mods.hvp': 'override ov_owner;\n'
      + 'topplan.f.subplan1.mem.owner = "First Owner";\n'
      + 'topplan.f.subplan1.owner = "Second Owner";\n'
      + 'endoverride\n',
  });
  const evaluation = files.evaluate(['mods.hvp'])!;
  const sub = files.model('sub.hvp');
  // "the resulting owner is Second Owner for all instances in the
  // topplan.subplan1 hierarchy level and below, including the
  // topplan.subplan1.mem instance."
  assert.deepEqual(valueAt(files.index, sub, 'mem', 'topplan.f.subplan1.mem', 'owner', evaluation),
    ['"Second Owner"', 'override']);
  assert.deepEqual(valueAt(files.index, sub, 'io', 'topplan.f.subplan1.io', 'owner', evaluation),
    ['"Second Owner"', 'override']);
  // Both statements reach `.mem`, in the order they were written; the resolver
  // applies them in that order, which is why the second one wins.
  assert.deepEqual(evaluation.overridesAt('topplan.f.subplan1.mem', scopeOf(sub, sub.plans[0])).map(o => o.text),
    ['"First Owner"', '"Second Owner"']);
  // Written the other way round, the descendant is the later statement and wins.
  const reversed = workspace({
    'top.hvp': TOP,
    'sub.hvp': SUB,
    'mods.hvp': 'override ov_owner;\n'
      + 'topplan.f.subplan1.owner = "Second Owner";\n'
      + 'topplan.f.subplan1.mem.owner = "First Owner";\n'
      + 'endoverride\n',
  });
  assert.deepEqual(valueAt(reversed.index, reversed.model('sub.hvp'), 'mem', 'topplan.f.subplan1.mem', 'owner',
    reversed.evaluate(['mods.hvp'])!), ['"First Owner"', 'override']);
});

test('an annotation override stays local while an attribute and a metric goal go down', () => {
  const files = workspace({
    'top.hvp': TOP,
    'sub.hvp': SUB,
    'mods.hvp': 'override ov;\n'
      + 'topplan.f.subplan1.note = "plan level";\n'
      + 'topplan.f.subplan1.Line = Line > 85%;\n'
      + 'endoverride\n',
  });
  const evaluation = files.evaluate(['mods.hvp'])!;
  const sub = files.model('sub.hvp');
  const scope = scopeOf(sub, sub.plans[0]);
  assert.deepEqual(evaluation.overridesAt('topplan.f.subplan1', scope).map(o => `${o.name}=${o.text}`),
    ['note="plan level"', 'Line=Line > 85%']);
  // One level down only the propagating pair is left: the chapter states that
  // annotation values are not passed down.
  assert.deepEqual(evaluation.overridesAt('topplan.f.subplan1.mem', scope).map(o => `${o.name}=${o.text}`),
    ['Line=Line > 85%']);
  assert.deepEqual(valueAt(files.index, sub, 'mem', 'topplan.f.subplan1.mem', 'note', evaluation),
    ['"none"', 'default']);
});

test('an override wins over an assignment written in the plan, and a metric override replaces the goal', () => {
  const files = workspace({
    'top.hvp': TOP,
    'sub.hvp': 'plan subplan1;\nattribute string owner = "";\nmetric percent Cov;\ngoal = Cov >= 90%;\nendmetric\n'
      + 'feature mem;\nowner = "written in the plan";\nmeasure Cov m; source = "a"; endmeasure\nendfeature\nendplan\n',
    'mods.hvp': 'override ov;\ntopplan.f.subplan1.owner = "from the modifier";\n'
      + 'topplan.f.subplan1.Cov = Cov >= 40%;\nendoverride\n',
  });
  const evaluation = files.evaluate(['mods.hvp'])!;
  const sub = files.model('sub.hvp');
  assert.deepEqual(valueAt(files.index, sub, 'mem', 'topplan.f.subplan1.mem', 'owner', evaluation),
    ['"from the modifier"', 'override']);
  const hover = files.hover('sub.hvp', 'Cov m;', evaluation);
  assert.match(hover, /Goal: `Cov >= 40%` \(override ov\)/);
});

test('a wildcard on the name an override sets is an error, since Table 5 is about scopes', () => {
  const model = parseDocument('override o;\ntop.*.we*ght = 2;\nendoverride\n');
  assert.deepEqual(model.diagnostics.filter(d => d.code).map(d => d.code), ['wildcard-in-name']);
  assert.match(model.diagnostics.find(d => d.code === 'wildcard-in-name')!.message,
    /may only stand for a plan or feature name/);
});

test('an override block written inside a plan names that plan and applies to every instance of it', () => {
  const files = workspace({
    'top.hvp': 'plan top;\nfeature a;\nsubplan leaf;\nendfeature\nfeature b;\nsubplan leaf;\nendfeature\nendplan\n',
    'leaf.hvp': 'plan leaf;\nattribute integer phase = 1;\nfeature f;\nmeasure Line m; source = "x"; endmeasure\n'
      + 'endfeature\noverride local;\nphase = 7;\nendoverride\nendplan\n',
  });
  const evaluation = files.evaluate(['leaf.hvp'])!;
  const leaf = files.model('leaf.hvp');
  const scope = scopeOf(leaf, leaf.plans[0]);
  for (const path of ['top.a.leaf', 'top.a.leaf.f', 'top.b.leaf.f']) {
    assert.deepEqual(evaluation.overridesAt(path, scope).map(o => o.text), ['7'], path);
  }
  assert.deepEqual(evaluation.overridesAt('top.a', scope), []);
  // A single-segment statement is checkable again: WS7 narrowed the exemption
  // to the paths only it can resolve, so WS2 types this one as usual.
  const wrong = parseDocument('plan leaf;\nattribute integer phase = 1;\noverride local;\nphase = "no";\nendoverride\nendplan\n');
  assert.deepEqual(wrong.diagnostics.filter(d => d.code).map(d => d.code), ['invalid-value']);
});

test('an override value is typed against the declaration its path found', () => {
  const files = workspace({
    'top.hvp': 'plan top;\nattribute integer phase = 1;\nmetric percent Cov;\ngoal = Cov >= 90%;\nendmetric\n'
      + 'feature a;\nmeasure Cov m; source = "x"; endmeasure\nendfeature\nendplan\n',
    'mods.hvp': 'override o;\ntop.a.phase = "two";\ntop.a.Cov = Nope >= 10%;\nendoverride\n',
  });
  assert.deepEqual(files.codes('mods.hvp'), ['invalid-value', 'unknown-goal-identifier']);
  assert.match(files.messages('mods.hvp')[0], /'phase' is declared integer, but the value is a string/);
});

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

test('a filter expression is typed against the declarations of the plan holding it', () => {
  const model = parseDocument(`plan p;
attribute integer phase = 1;
attribute string router_fabric = "";
metric percent Cov;
goal = Cov >= 90%;
endmetric
feature f;
measure Cov m; source = "x"; endmeasure
endfeature
filter my_view;
remove feature where phase > 2;
keep feature where router_fabric == "N1" || router_fabric == "N2";
keep feature where phase > "two";
remove feature where nosuch == 1;
remove feature where Cov > 2;
endfilter
endplan
`);
  assert.deepEqual(model.diagnostics.filter(d => d.code).map(d => d.code),
    ['invalid-filter-operand', 'unknown-filter-identifier', 'unknown-filter-identifier']);
  const messages = model.diagnostics.filter(d => d.code).map(d => d.message);
  assert.match(messages[0], /'>' compares a number with a string/);
  assert.match(messages[1], /'nosuch' is not an attribute or annotation declared in this plan/);
  assert.match(messages[2], /'Cov' is a metric/);
});

test('the two forms the chapter calls unsupported are reported as such', () => {
  const model = parseDocument('plan p;\nattribute integer phase = 1;\nattribute string owner = "";\n'
    + 'filter f;\nremove feature where phase inside {1:10};\nremove feature where match (owner, "bo*");\nendfilter\nendplan\n');
  const reported = model.diagnostics.filter(d => d.code === 'unsupported-expression').map(d => d.message);
  assert.equal(reported.length, 2);
  assert.match(reported[0], /'inside \{\.\.\.\}' is not supported in a filter expression/);
  assert.match(reported[1], /'match\(\.\.\.\)' is not supported in a filter expression/);
});

test('a filter block in a modifier file names attributes of a plan it does not state, so nothing is reported', () => {
  const model = parseDocument('filter my_view;\nremove feature where phase > 2;\nendfilter\n');
  assert.deepEqual(model.diagnostics.filter(d => d.code).map(d => d.code), []);
});

test('remove removes and keep keeps, whatever the prose under the example says', () => {
  const files = workspace({
    'top.hvp': 'plan top;\nattribute integer phase = 1;\nattribute string router_fabric = "";\n'
      + 'feature early;\nphase = 1;\nmeasure Line m; source = "a"; endmeasure\nendfeature\n'
      + 'feature late;\nphase = 5;\nrouter_fabric = "N1";\nmeasure Line m; source = "b"; endmeasure\nendfeature\n'
      + 'endplan\n',
    'mods.hvp': 'filter my_view;\nremove feature where phase > 2;\nendfilter\n',
  });
  const evaluation = files.evaluate(['mods.hvp'])!;
  const top = files.model('top.hvp');
  const valuesOf = (feature: string) => {
    const table = new Map(resolveValues(top, featureNamed(top, feature)).map(v => [v.declaration.name, v.text]));
    return (name: string) => table.get(name);
  };
  assert.equal(evaluation.removalOf(valuesOf('early')), undefined);
  assert.equal(evaluation.removalOf(valuesOf('late'))?.label, 'my_view');

  // `keep` narrows instead: the feature that does not match is the one dropped.
  const kept = workspace({
    'top.hvp': files.model('top.hvp').source.text,
    'mods.hvp': 'filter my_view;\nkeep feature where phase == 5;\nendfilter\n',
  });
  const keeping = kept.evaluate(['mods.hvp'])!;
  assert.equal(keeping.removalOf(valuesOf('early'))?.statement.keep, true);
  assert.equal(keeping.removalOf(valuesOf('late')), undefined);

  // A string comparison, and an expression naming something the model cannot
  // supply — the second changes nothing rather than guessing.
  const strings = workspace({
    'top.hvp': files.model('top.hvp').source.text,
    'mods.hvp': 'filter my_view;\nkeep feature where router_fabric == "N1" || router_fabric == "N2";\n'
      + 'remove feature where unknown_thing == 1;\nendfilter\n',
  });
  const evaluated = strings.evaluate(['mods.hvp'])!;
  assert.equal(evaluated.removalOf(valuesOf('late')), undefined);
  assert.ok(evaluated.removalOf(valuesOf('early')), 'early has no router_fabric and the keep drops it');
});

// ---------------------------------------------------------------------------
// until
// ---------------------------------------------------------------------------

test('a date is MM-DD-YYYY, and an out-of-range one is reported rather than re-read as DD-MM', () => {
  assert.deepEqual(parseDate('1-31-2014'), { month: 1, day: 31, year: 2014, value: 20140131 });
  assert.deepEqual(parseDate('04-30-2014'), { month: 4, day: 30, year: 2014, value: 20140430 });
  assert.equal(parseDate('31-01-2014'), 'range');   // Not silently read as 31 January.
  assert.equal(parseDate('02-30-2015'), 'range');
  assert.deepEqual(parseDate('02-29-2016'), { month: 2, day: 29, year: 2016, value: 20160229 });
  assert.equal(parseDate('02-29-2015'), 'range');
  assert.equal(parseDate('2014-01-31'), 'format'); // Four digits where a month goes is not the shape at all.
  assert.equal(parseDate('january'), 'format');
  assert.equal(parseDate(''), 'format');
  assert.ok(isDateProblem(parseDate('nope')));
});

test('until branches are checked for spelling, ordering and reachability', () => {
  const model = parseDocument('until 01-31-2014;\nelseuntil 13-01-2014;\nelseuntil 01-01-2014;\nelse;\n'
    + 'elseuntil 12-31-2030;\nenduntil\n');
  const reported = model.diagnostics.filter(d => d.code).map(d => `${d.code}:${d.message}`);
  assert.deepEqual(reported.map(r => r.split(':')[0]),
    ['invalid-date', 'unreachable-branch', 'invalid-branch-order']);
  assert.match(reported[0], /is not a calendar date/);
  assert.match(reported[1], /already covers every date up to 01-31-2014/);
  assert.match(reported[2], /'elseuntil' cannot follow 'else'/);
  // A second `else` is the other ordering mistake.
  const twice = parseDocument('until 01-31-2030;\nelse;\nelse;\nenduntil\n');
  assert.deepEqual(twice.diagnostics.filter(d => d.code).map(d => d.code), ['invalid-branch-order']);
});

test('a branch whose date has passed is a warning, and it moves with the calendar rather than the parse', () => {
  const files = workspace({ 'mods.hvp': 'until 01-31-2014;\nelseuntil 12-31-2099;\nelse;\nenduntil\n' });
  // The parse itself says nothing: its answer is cached by document version and
  // must not change at midnight.
  assert.deepEqual(files.model('mods.hvp').diagnostics.filter(d => d.code).map(d => d.code), []);
  assert.deepEqual(files.codes('mods.hvp', new Date(2026, 8, 9)), ['expired-until-branch']);
  assert.deepEqual(files.codes('mods.hvp', new Date(2013, 0, 1)), []);
  assert.match(files.messages('mods.hvp')[0], /The 01-31-2014 branch no longer applies/);
});

test('the live branch is the first whose date has not passed, and the named day still belongs to it', () => {
  const model = parseDocument('until 1-31-2014;\nelseuntil 04-30-2014;\nelse;\nenduntil\n');
  const block = untilBlocks(model)[0];
  const kindAt = (value: number) => liveBranch(block, value)?.kind;
  assert.equal(kindAt(20140101), 'until');
  assert.equal(kindAt(20140131), 'until');       // "applied before 1/31/2014", inclusive of the day named.
  assert.equal(kindAt(20140201), 'elseuntil');   // "applied between 2/1/2014 - 4/30/2014".
  assert.equal(kindAt(20140430), 'elseuntil');
  assert.equal(kindAt(20140501), 'else');
  // With no `else` at all, a date past every branch selects nothing.
  const dated = parseDocument('until 1-31-2014;\nenduntil\n');
  assert.equal(liveBranch(untilBlocks(dated)[0], 20200101), undefined);
});

test('a bare assignment in an until branch means what it would mean outside the until, when the branch is live', () => {
  const plan = `plan p;
attribute integer phase = 0;
feature f;
until 01-31-2014;
phase = 1;
elseuntil 12-31-2099;
phase = 2;
else;
phase = 3;
enduntil
measure Line m; source = "x"; endmeasure
endfeature
endplan
`;
  const files = workspace({ 'plan.hvp': plan });
  const model = files.model('plan.hvp');
  const feature = featureNamed(model, 'f');
  // Without an evaluation date every branch stays transparent and the last
  // assignment written wins — exactly what the resolver did before WS7.
  assert.equal(resolveValue(model, feature, 'phase')!.text, '3');
  const evaluation = files.evaluate(['plan.hvp'], '06-01-2030')!;
  assert.equal(resolveValue(model, feature, 'phase', { branchIsLive: evaluation.branchIsLive })!.text, '2');
  const early = files.evaluate(['plan.hvp'], '01-01-2014')!;
  assert.equal(resolveValue(model, feature, 'phase', { branchIsLive: early.branchIsLive })!.text, '1');
  const late = files.evaluate(['plan.hvp'], '01-01-2100')!;
  assert.equal(resolveValue(model, feature, 'phase', { branchIsLive: late.branchIsLive })!.text, '3');
});

test('an override block inside an until branch applies only while that branch is live', () => {
  const files = workspace({
    'top.hvp': 'plan top;\nattribute integer phase = 0;\nfeature f;\nmeasure Line m; source = "x"; endmeasure\n'
      + 'endfeature\nendplan\n',
    'mods.hvp': 'until 01-31-2014;\noverride early;\ntop.f.phase = 1;\nendoverride\n'
      + 'else;\noverride late;\ntop.f.phase = 9;\nendoverride\nenduntil\n',
  });
  const top = files.model('top.hvp');
  const scope = scopeOf(top, top.plans[0]);
  assert.deepEqual(files.evaluate(['mods.hvp'], '01-01-2014')!.overridesAt('top.f', scope).map(o => o.text), ['1']);
  assert.deepEqual(files.evaluate(['mods.hvp'], '01-01-2030')!.overridesAt('top.f', scope).map(o => o.text), ['9']);
});

// ---------------------------------------------------------------------------
// The preview, the hover and completion
// ---------------------------------------------------------------------------

test('the preview is off until a modifier file is configured', () => {
  const files = workspace({ 'top.hvp': TOP, 'sub.hvp': SUB, 'mods.hvp': 'override o;\ntopplan.f.subplan1.owner = "x";\nendoverride\n' });
  assert.equal(evaluateModifiers(files.index, { now: FIXED }), undefined);
  assert.equal(evaluateModifiers(files.index, { files: [], now: FIXED }), undefined);
  // A configured file the index has never seen is not one either.
  assert.equal(evaluateModifiers(files.index, { files: ['file:///plans/absent.hvp'], now: FIXED }), undefined);
  assert.ok(files.evaluate(['mods.hvp']));
});

test('a feature hover shows the winning override and says a filtered feature is removed', () => {
  const files = workspace({
    'top.hvp': TOP,
    'sub.hvp': SUB,
    'mods.hvp': 'override ov_owner;\ntopplan.f.subplan1.mem.owner = "First Owner";\n'
      + 'topplan.f.subplan1.owner = "Second Owner";\nendoverride\n'
      + 'filter my_view;\nremove feature where owner == "Second Owner";\nendfilter\n',
  });
  const plain = files.hover('sub.hvp', 'mem;');
  assert.match(plain, /\| `owner` \| `""` \| \[declaration default\]/);
  assert.ok(!plain.includes('Removed'), plain);

  const previewed = files.hover('sub.hvp', 'mem;', files.evaluate(['mods.hvp']));
  assert.match(previewed, /\| `owner` \| `"Second Owner"` \| override ov_owner \|/);
  assert.match(previewed, /\*\*Removed\*\* by `remove feature where owner == "Second Owner"` in filter `my_view`/);
});

test('hover on an override path says what it resolved to and whether it propagates', () => {
  const files = workspace({
    'top.hvp': TOP,
    'sub.hvp': SUB,
    'mods.hvp': 'override ov;\ntopplan.**.owner = "x";\ntopplan.f.subplan1.note = "y";\nnowhere.at.all = 1;\nendoverride\n',
  });
  const attribute = files.hover('mods.hvp', 'topplan.**.owner');
  assert.match(attribute, /\*\*Override path\*\* `topplan\.\*\*\.owner`/);
  assert.match(attribute,
    /Matches 4 scopes: `topplan\.f`, `topplan\.f\.subplan1`, `topplan\.f\.subplan1\.mem`, `topplan\.f\.subplan1\.io`\./);
  // `owner` is a built-in every plan inherits and one this path also reaches as
  // a declaration; the declaration is what the hover names.
  assert.match(attribute, /Sets \*\*attribute\*\* `string owner` of plan subplan1, which is passed down/);

  const annotation = files.hover('mods.hvp', 'topplan.f.subplan1.note');
  assert.match(annotation, /Sets \*\*annotation\*\* `string note`.*which is \*\*not\*\* passed down/);
  assert.match(files.hover('mods.hvp', 'nowhere.at.all'), /Matches no plan or feature/);
});

test('a path segment completes from the instantiated hierarchy', () => {
  const files = workspace({
    'top.hvp': 'plan top;\nfeature u1;\nsubplan leaf;\nendfeature\nfeature u2;\nsubplan leaf;\nendfeature\nendplan\n',
    'leaf.hvp': 'plan leaf;\nattribute integer weight = 1;\nfeature a;\nmeasure Line m; source = "x"; endmeasure\nendfeature\nendplan\n',
  });
  const complete = (text: string, needle: string) => {
    const model = parseDocument(text);
    const offset = text.indexOf(needle) + needle.length;
    const items = provideCompletionItems(model, model.source.positionAt(offset), { index: files.index });
    return {
      labels: items.map(item => item.label),
      // A path segment and a name the path could end on are two different
      // things, and the item kind is what says which.
      segments: items.filter(item => item.kind === CompletionItemKind.Module).map(item => item.label),
    };
  };
  assert.deepEqual(complete('override o;\ntop. = 1;\nendoverride\n', 'top.').segments, ['u1', 'u2']);
  assert.deepEqual(complete('override o;\ntop.u1. = 1;\nendoverride\n', 'top.u1.').segments, ['leaf']);
  const leaf = complete('override o;\ntop.u1.leaf. = 1;\nendoverride\n', 'top.u1.leaf.');
  assert.deepEqual(leaf.segments, ['a']);
  assert.ok(leaf.labels.includes('weight'), leaf.labels.join(','));
  assert.ok(leaf.labels.includes('owner'), 'the built-ins the plan inherits are targets too');
  // A path that has reached a plan can also end there: `top.weight = 2;`.
  assert.ok(complete('override o;\ntop. = 1;\nendoverride\n', 'top.').labels.includes('weight'));
  // A wildcard already typed is matched the same way the resolution matches it.
  assert.deepEqual(complete('override o;\ntop.*. = 1;\nendoverride\n', 'top.*.').segments, ['leaf']);
  // Nothing takes the list over before a dot: an override block inside a plan
  // starts with that plan's own attribute names, keywords and all.
  const first = complete('plan leaf;\nattribute integer weight = 1;\noverride o;\nw = 1;\nendoverride\nendplan\n',
    '\nw').labels;
  assert.ok(first.includes('weight') && first.includes('override'), first.join(','));
});

test('the exemption WS7 narrowed still exempts what it should', () => {
  const model = parseDocument('plan p;\nattribute integer phase = 1;\noverride o;\n'
    + 'subplan nothing_here;\nother.plan.phase = 2;\nphase = 2;\nendoverride\nendplan\n');
  const node = (kind: string) => model.nodes.find(n => n.kind === kind)!;
  // A `subplan` inside a modifier block instantiates nothing, and a path names
  // nothing this file declares — both stay exempt.
  assert.equal(model.checkable(node('subplan')), false);
  const assignments = model.nodes.filter(n => n.kind === 'assignment');
  assert.equal(model.checkable(assignments[0]), false);
  assert.equal(model.checkable(assignments[1]), true);
  assert.equal(model.overridePath(assignments[0])?.text, 'other.plan.phase');
  assert.equal(model.overridePath(assignments[1]), undefined);
  // `test.expected` is the one declared name with a dot in it, and stays an
  // assignment to a built-in rather than a two-segment path.
  const builtin = parseDocument('plan p;\noverride o;\ntest.expected = 5;\nendoverride\nendplan\n');
  assert.equal(builtin.overridePath(builtin.nodes.find(n => n.kind === 'assignment')!), undefined);
  assert.deepEqual(builtin.diagnostics.filter(d => d.code).map(d => d.code), []);
});

// WS5: the workspace index, subplan resolution, parameters and instances.
import assert from 'node:assert/strict';
import test from 'node:test';
import { provideHover } from '../src/core/hover';
import { parseDocument } from '../src/core/parser';
import { PlanDocument, PlanNode } from '../src/core/planModel';
import { objectPath, resolveValues } from '../src/core/resolver';
import {
  PlanInstance,
  WorkspaceIndex,
  buildIndex,
  contextOf,
  cyclicSubplans,
  instantiate,
  topLevelPlans,
} from '../src/core/workspace';
import { workspaceDiagnostics } from '../src/core/workspaceDiagnostics';

/** A workspace built from strings: exactly what the server hands the index
 * after reading files, minus the disk. */
function workspace(files: Record<string, string>) {
  const models = new Map(Object.entries(files).map(([name, text]) => [name, parseDocument(text)]));
  const uri = (name: string) => `file:///plans/${name}`;
  const index = buildIndex([...models].map(([name, model]) => ({ uri: uri(name), model })));
  return {
    index,
    uri,
    model: (name: string) => models.get(name)!,
    codes: (name: string) => workspaceDiagnostics(models.get(name)!, uri(name), index)
      .filter(d => d.code).map(d => d.code),
    messages: (name: string) => workspaceDiagnostics(models.get(name)!, uri(name), index)
      .filter(d => d.code).map(d => d.message),
    hover: (name: string, needle: string) => {
      const model = models.get(name)!;
      const offset = files[name].indexOf(needle);
      const hover = provideHover(model, model.source.positionAt(offset), { uri: uri(name), index });
      return (hover?.contents as { value: string } | undefined)?.value ?? '';
    },
  };
}

const featureNamed = (model: PlanDocument, name: string): PlanNode =>
  model.nodes.find(n => n.kind === 'feature' && 'name' in n && n.name?.text === name)!;
const valuesAt = (model: PlanDocument, feature: string, instance?: PlanInstance) =>
  Object.fromEntries(resolveValues(model, featureNamed(model, feature), instance ? contextOf(instance) : {})
    .map(v => [v.declaration.name, [v.text, v.origin.kind]]));

// The chapter's feature-groups example: one subplan instantiated four times,
// each instance disabling a different group.
const CACHE = `plan cache_plan;
attribute string root_mod = "";
attribute integer grpA = 1;
attribute integer grpB = 1;
attribute integer grpC = 1;
annotation string note = "";
feature single_reads;
grpB = 0;
grpC = 0;
measure Group,Assert,Line,Cond snps; source = "property: \${root_mod}read"; endmeasure
endfeature
endplan`;

const TOP = `plan grp_enab_top;
feature memory0;
subplan cache_plan #(root_mod="memsys.u0.", grpA=0);
endfeature
feature memory1;
subplan cache_plan #(root_mod="memsys.u1.", grpB=0);
endfeature
feature memory2;
subplan cache_plan #(root_mod="memsys.u2.", grpC=0);
endfeature
feature memory3;
subplan cache_plan #(root_mod="memsys.u3.", grpA=0, grpB=0);
endfeature
endplan`;

test('a subplan resolves to a plan declared in any indexed file', () => {
  const files = workspace({ 'cache.hvp': CACHE, 'top.hvp': TOP });
  assert.deepEqual(files.codes('top.hvp'), []);
  assert.deepEqual(files.codes('cache.hvp'), []);
  // The same file on its own knows nothing about cache_plan.
  const alone = workspace({ 'top.hvp': TOP });
  assert.deepEqual(alone.codes('top.hvp'), ['unknown-plan', 'unknown-plan', 'unknown-plan', 'unknown-plan']);
  assert.match(alone.messages('top.hvp')[0], /Unknown plan 'cache_plan'/);
  // A document the index has not reached yet is left exactly as parsed, rather
  // than having every name in it called unknown.
  const model = parseDocument(TOP);
  assert.deepEqual(workspaceDiagnostics(model, 'file:///elsewhere.hvp', alone.index), model.diagnostics);
  // `checkable` again: a modifier block addresses the instantiated hierarchy
  // rather than adding to it, so a `subplan` inside one names nothing and
  // instantiates nothing.
  const modified = workspace({ 'm.hvp': 'plan p; feature f; measure Line m; source = "s"; endmeasure endfeature override o; subplan ghost; endoverride endplan' });
  assert.deepEqual(modified.codes('m.hvp'), []);
  assert.deepEqual(instantiate(modified.index).map(i => i.plan.name), ['p']);
});

test('subplan parameters must name an attribute of the target plan and type-check', () => {
  const files = workspace({
    'cache.hvp': CACHE,
    'top.hvp': `plan t;
feature f;
subplan cache_plan #(root_mod="x.", grpA=0, missing=1, note="n", grpB="two");
endfeature
endplan`,
  });
  assert.deepEqual(files.codes('top.hvp'), ['unknown-parameter', 'unknown-parameter', 'invalid-parameter-value']);
  const messages = files.messages('top.hvp');
  assert.match(messages[0], /'missing' is not an attribute declared in plan 'cache_plan'/);
  assert.match(messages[1], /'note' is an annotation in plan 'cache_plan'/);
  assert.match(messages[2], /'grpB' is declared integer, but the value is a string/);
  // A parameter with no value at all is the same missing-value message WS2's
  // declaration check gives, since it is the same `checkValue` rule.
  const empty = workspace({ 'cache.hvp': CACHE, 'top.hvp': 'plan t; feature f; subplan cache_plan #(grpA); endfeature endplan' });
  assert.deepEqual(empty.codes('top.hvp'), ['invalid-parameter-value']);
  // Two plans of the same name: reported only when neither accepts the name,
  // and never type-checked, since which one the tool loaded is unknowable.
  const duplicated = workspace({
    'a.hvp': 'plan dup; attribute integer x = 0; feature f; measure Line m; source = "s"; endmeasure endfeature endplan',
    'b.hvp': 'plan dup; attribute string y = ""; feature g; measure Line m; source = "s"; endmeasure endfeature endplan',
    'top.hvp': 'plan t; feature f; subplan dup #(y=1); endfeature endplan',
    'bad.hvp': 'plan u; feature f; subplan dup #(z=1); endfeature endplan',
  });
  assert.deepEqual(duplicated.codes('top.hvp'), []);
  assert.deepEqual(duplicated.codes('bad.hvp'), ['unknown-parameter']);
});

test('the same plan instantiated four times yields four instances with their own values', () => {
  const files = workspace({ 'cache.hvp': CACHE, 'top.hvp': TOP });
  const instances = files.index.instances();
  assert.deepEqual(instances.map(i => [...i.path, i.plan.name].join('.')), [
    'grp_enab_top',
    'grp_enab_top.memory0.cache_plan',
    'grp_enab_top.memory1.cache_plan',
    'grp_enab_top.memory2.cache_plan',
    'grp_enab_top.memory3.cache_plan',
  ]);
  const cache = files.model('cache.hvp');
  const memory0 = valuesAt(cache, 'single_reads', instances[1]);
  const memory3 = valuesAt(cache, 'single_reads', instances[4]);
  // The parameter supplies grpA; the assignment written in the plan supplies
  // grpB and grpC in every instance.
  assert.deepEqual(memory0.grpA, ['0', 'parameter']);
  assert.deepEqual(memory0.grpB, ['0', 'assignment']);
  assert.deepEqual(memory0.root_mod, ['"memsys.u0."', 'parameter']);
  assert.deepEqual(memory3.root_mod, ['"memsys.u3."', 'parameter']);
  // memory1's grpB parameter loses to the assignment inside the plan.
  assert.deepEqual(valuesAt(cache, 'single_reads', instances[2]).grpB, ['0', 'assignment']);
  // Without an instance the same feature reads the declaration defaults.
  assert.deepEqual(valuesAt(cache, 'single_reads').grpA, ['1', 'default']);
  // The measure's object path runs through the instance, not the local file.
  const measure = cache.nodes.find(n => n.kind === 'measure')!;
  assert.equal(objectPath(cache, measure, contextOf(instances[1])),
    'grp_enab_top.memory0.cache_plan.single_reads.snps');
  assert.equal(objectPath(cache, measure), 'cache_plan.single_reads.snps');
});

test('cycles are reported on the statement that closes them and never walked', () => {
  const direct = workspace({ 'a.hvp': 'plan a; feature f; subplan a; endfeature endplan' });
  assert.deepEqual(direct.codes('a.hvp'), ['subplan-cycle']);
  const mutual = workspace({
    'a.hvp': 'plan a; feature f; subplan b; endfeature endplan',
    'b.hvp': 'plan b; feature g; subplan a; endfeature endplan',
  });
  // Both edges close a cycle, and neither plan is a top-level plan, so the
  // hierarchy walk never reaches either — the report cannot come from it.
  assert.deepEqual(mutual.codes('a.hvp'), ['subplan-cycle']);
  assert.deepEqual(mutual.codes('b.hvp'), ['subplan-cycle']);
  assert.deepEqual(topLevelPlans(mutual.index), []);
  assert.deepEqual(instantiate(mutual.index), []);
  // A deeper cycle is reported only on the back edge, not on the way down.
  const deep = workspace({
    'a.hvp': 'plan a; feature f; subplan b; endfeature endplan',
    'b.hvp': 'plan b; feature g; subplan c; endfeature endplan',
    'c.hvp': 'plan c; feature h; subplan b; endfeature endplan',
  });
  assert.deepEqual(deep.codes('a.hvp'), []);
  // Both statements on the b→c→b cycle are reported; the statement that reaches
  // the cycle from outside it is not.
  assert.deepEqual(deep.codes('b.hvp'), ['subplan-cycle']);
  assert.deepEqual(deep.codes('c.hvp'), ['subplan-cycle']);
  assert.equal(cyclicSubplans(deep.index).size, 2);
  // The hierarchy is still built as far as it goes: the walk stops when a plan
  // would contain itself, rather than dropping everything below the cycle.
  assert.deepEqual(instantiate(deep.index).map(i => [...i.path, i.plan.name].join('.')),
    ['a', 'a.f.b', 'a.f.b.g.c']);
});

test('the top-level plan rule reads across the whole plan set', () => {
  const LIB = `plan lib_a;
feature f; measure Line m; source = "s"; endmeasure endfeature
endplan
plan lib_b;
feature g; measure Line m; source = "s"; endmeasure endfeature
endplan`;
  // Alone, lib_a is neither the last plan nor used as a subplan.
  assert.deepEqual(workspace({ 'lib.hvp': LIB }).codes('lib.hvp'), ['unreferenced-plan']);
  // A subplan statement in another file is what makes it legal, exactly as one
  // in the same file would.
  const linked = workspace({ 'lib.hvp': LIB, 'top.hvp': 'plan top; feature f; subplan lib_a; endfeature endplan' });
  assert.deepEqual(linked.codes('lib.hvp'), []);
  assert.deepEqual(linked.codes('top.hvp'), []);
  // Two unrelated plan sets in one workspace are both top-level, and neither is
  // reported: the chapter's "more than one top-level plan" error is about one
  // set of files handed to the tool, not about everything in an editor window.
  const unrelated = workspace({ 'lib.hvp': LIB, 'top.hvp': 'plan top; feature f; subplan lib_a; endfeature endplan',
    'other.hvp': 'plan other; feature f; measure Line m; source = "s"; endmeasure endfeature endplan' });
  assert.deepEqual(unrelated.codes('other.hvp'), []);
  assert.deepEqual(topLevelPlans(unrelated.index).map(p => p.name), ['lib_b', 'top', 'other']);
  // WS1 pins forward references as legal within a file; a reference that only
  // arrives from another file is the same thing one step further out.
  assert.deepEqual(workspace({
    'x.hvp': 'plan a; feature f; subplan b; endfeature endplan plan b; feature g; measure Line m; source = "s"; endmeasure endfeature endplan',
    'y.hvp': 'plan c; feature h; subplan a; endfeature endplan',
  }).codes('x.hvp'), []);
});

test('hover on a subplan statement shows the values that instance receives', () => {
  const files = workspace({ 'cache.hvp': CACHE, 'top.hvp': TOP });
  const hover = files.hover('top.hvp', 'cache_plan #(root_mod="memsys.u0.');
  assert.match(hover, /\*\*Subplan\*\* `cache_plan` `#\(root_mod="memsys\.u0\.", grpA=0\)`/);
  // The link points into the file that declares the plan, not this one.
  assert.match(hover, /\[plan cache_plan\]\(file:\/\/\/plans\/cache\.hvp#L1,6\)/);
  assert.match(hover, /Instance `grp_enab_top\.memory0\.cache_plan`/);
  assert.match(hover, /\| `root_mod` \| `"memsys\.u0\."` \| subplan parameter \|/);
  assert.match(hover, /\| `grpB` \| `1` \| \[declaration default\]\(file:\/\/\/plans\/cache\.hvp#L4,19\)/);
  // An unresolved name says so instead of showing a table of nothing.
  assert.match(workspace({ 'top.hvp': TOP }).hover('top.hvp', 'cache_plan #('),
    /No plan of this name is declared in the workspace/);
  // Without an index the statement still reads back, with no claim about it.
  const model = parseDocument(TOP);
  const plain = provideHover(model, model.source.positionAt(TOP.indexOf('cache_plan')), { uri: 'file:///t.hvp' });
  assert.match((plain!.contents as { value: string }).value, /\*\*Subplan\*\* `cache_plan`/);
});

test('a feature hover reads the instance it belongs to, or says there are several', () => {
  const files = workspace({ 'cache.hvp': CACHE, 'top.hvp': TOP });
  // cache_plan is instantiated four times: no one instance is under the cursor.
  const many = files.hover('cache.hvp', 'single_reads;');
  assert.match(many, /Instantiated 4 times \(`grp_enab_top\.memory0\.cache_plan`, /);
  assert.match(many, /\| `root_mod` \| `""` \| \[declaration default\]/);
  // Instantiated once, the parameters are unambiguous and the table shows them.
  const once = workspace({ 'cache.hvp': CACHE,
    'top.hvp': 'plan solo; feature only; subplan cache_plan #(root_mod="u0.", grpA=0); endfeature endplan' });
  const single = once.hover('cache.hvp', 'single_reads;');
  assert.match(single, /Instance `solo\.only\.cache_plan`/);
  assert.match(single, /\| `root_mod` \| `"u0\."` \| subplan parameter \|/);
  assert.match(single, /\| `grpA` \| `0` \| subplan parameter \|/);
  // And the source string expands with that instance's value.
  assert.match(once.hover('cache.hvp', 'property: '), /Expands to `property: u0\.read`/);
  assert.match(files.hover('cache.hvp', 'property: '), /Expands to `property: read`/);
});

test('the index answers the queries WS6 and WS7 are built on', () => {
  const files = workspace({ 'cache.hvp': CACHE, 'top.hvp': TOP });
  const index: WorkspaceIndex = files.index;
  assert.deepEqual(index.plans('cache_plan').map(p => p.uri), ['file:///plans/cache.hvp']);
  assert.deepEqual(index.plans('nothing'), []);
  assert.deepEqual(index.allPlans().map(p => p.name), ['cache_plan', 'grp_enab_top']);
  assert.equal(index.document('file:///plans/top.hvp')?.model, files.model('top.hvp'));
  assert.equal(index.documents().length, 2);
  // Instances are memoized, so a hover does not rebuild the hierarchy.
  assert.equal(index.instances(), index.instances());
  // Every instance below the root names the statement that created it, which is
  // what WS7 applies a modifier through.
  const child = index.instances()[1];
  assert.equal(child.origin?.uri, 'file:///plans/top.hvp');
  assert.equal(child.origin?.node.kind, 'subplan');
  assert.equal(child.parent, index.instances()[0]);
  assert.deepEqual([...child.parameters], [['root_mod', '"memsys.u0."'], ['grpA', '0']]);
});

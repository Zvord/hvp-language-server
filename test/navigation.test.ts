// WS6: the outline, workspace symbols, definition, references and rename.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentSymbol, Location, SymbolKind } from 'vscode-languageserver-types';

import {
  prepareRename,
  provideDefinition,
  provideReferences,
  provideRenameEdits,
} from '../src/core/navigation';
import { parseDocument } from '../src/core/parser';
import { PlanDocument } from '../src/core/planModel';
import { provideDocumentSymbols, provideWorkspaceSymbols } from '../src/core/symbols';
import { buildIndex } from '../src/core/workspace';

/** A workspace built from strings, and the four providers aimed at a needle in
 * one of its files. Same shape as `workspace.test.ts`: nothing touches disk. */
function workspace(files: Record<string, string>) {
  const models = new Map(Object.entries(files).map(([name, text]) => [name, parseDocument(text)]));
  const uri = (name: string) => `file:///plans/${name}`;
  const index = buildIndex([...models].map(([name, model]) => ({ uri: uri(name), model })));
  const at = (name: string, needle: string, offset = 0) => {
    const model = models.get(name)!;
    const found = files[name].indexOf(needle);
    assert.notEqual(found, -1, `needle '${needle}' is not in ${name}`);
    return { model, position: model.source.positionAt(found + offset), options: { uri: uri(name), index } };
  };
  /** `file:line:character`, which is all an assertion about navigation needs. */
  const show = (locations: Location[]): string[] => locations.map(location =>
    `${location.uri.split('/').pop()}:${location.range.start.line}:${location.range.start.character}`);
  return {
    index,
    uri,
    model: (name: string) => models.get(name)!,
    definition: (name: string, needle: string, offset = 0) => {
      const { model, position, options } = at(name, needle, offset);
      return show(provideDefinition(model, position, options));
    },
    references: (name: string, needle: string, offset = 0) => {
      const { model, position, options } = at(name, needle, offset);
      return show(provideReferences(model, position, options));
    },
    /** The refusal sentence, asserting that the rename did refuse. */
    refuse: (name: string, needle: string, newName: string, offset = 0): string => {
      const { model, position, options } = at(name, needle, offset);
      const result = provideRenameEdits(model, position, newName, options);
      assert.ok('error' in result, `expected '${needle}' -> '${newName}' to be refused`);
      return result.error;
    },
    rename: (name: string, needle: string, newName: string, offset = 0) => {
      const { model, position, options } = at(name, needle, offset);
      const result = provideRenameEdits(model, position, newName, options);
      if ('error' in result) return result.error;
      return Object.fromEntries(Object.entries(result.edit.changes ?? {}).map(([key, edits]) =>
        [key.split('/').pop()!, edits.map(edit => `${edit.range.start.line}:${edit.range.start.character}=${edit.newText}`)]));
    },
    prepare: (name: string, needle: string, offset = 0) => {
      const { model, position, options } = at(name, needle, offset);
      return prepareRename(model, position, options);
    },
    /** The same call with no index at all, which is what the server passes
     * while the workspace scan is still running. */
    unindexed: (name: string, needle: string, newName: string, offset = 0) => {
      const { model, position } = at(name, needle, offset);
      const result = provideRenameEdits(model, position, newName, { uri: uri(name) });
      return 'error' in result ? result.error : result.edit;
    },
  };
}

// ---------------------------------------------------------------------------
// Document symbols
// ---------------------------------------------------------------------------

const ALL_KINDS = `plan SamplePlan;
attribute integer Priority = 0;
annotation string Source = "";
metric integer Score;
goal = Score >= 90%;
aggregator = sum;
endmetric
feature Root;
feature Child;
subplan other_plan #(Priority = 1);
measure Score tst;
source = "module: top.dut";
endmeasure
endfeature
endfeature
override RootOverride;
SamplePlan.Root.Priority = 5;
endoverride
filter ScopeFilter;
keep feature where Priority > 0;
endfilter
until 12-31-2026;
Priority = 1;
elseuntil 12-31-2027;
Priority = 2;
else;
Priority = 3;
enduntil
endplan`;

/** `SymbolKind` is a plain numeric table with no reverse mapping, the trap
 * `golden.test.ts` names: an assertion on raw numbers says nothing. */
const KIND_NAME = new Map(Object.entries(SymbolKind as unknown as Record<string, number>)
  .map(([name, value]) => [value, name]));

const flatten = (symbols: DocumentSymbol[], depth = 0): string[] =>
  symbols.flatMap(symbol => [`${'  '.repeat(depth)}${KIND_NAME.get(symbol.kind)} ${symbol.name}`,
    ...flatten(symbol.children ?? [], depth + 1)]);

test('the outline covers plans, declarations, features, subplans, measures and modifiers', () => {
  const symbols = provideDocumentSymbols(parseDocument(ALL_KINDS));
  assert.deepEqual(flatten(symbols), [
    'Module SamplePlan',
    '  Property Priority',
    '  Field Source',
    '  Interface Score',
    '  Class Root',
    '    Class Child',
    '      Package other_plan',
    '      Method tst',
    '  Namespace RootOverride',
    '  Namespace ScopeFilter',
    '  Event until',
    '    Event until 12-31-2026',
    '    Event elseuntil 12-31-2027',
    '    Event else',
  ]);
  // The detail line carries what the name alone cannot: the declared type, the
  // metrics a measure reports and the parameters a subplan passes.
  const details = new Map<string, string>();
  const collect = (list: DocumentSymbol[]) => list.forEach(symbol => {
    details.set(symbol.name, symbol.detail ?? '');
    collect(symbol.children ?? []);
  });
  collect(symbols);
  assert.equal(details.get('Priority'), 'integer');
  assert.equal(details.get('Score'), 'integer');
  assert.equal(details.get('tst'), 'Score');
  assert.equal(details.get('other_plan'), 'subplan #(Priority=1)');
});

test('every symbol carries a selectionRange inside its range', () => {
  // The trap `symbols.ts` documents: vscode derived `selectionRange`, LSP does
  // not, and a client silently drops a symbol whose selection escapes its
  // range. Checked on recovered text too, where the ranges are least tidy.
  const documents = [ALL_KINDS,
    'plan p; feature f; measure Line m; source = "x"; endmeasure endfeature endplan',
    'plan p;\nfeature Root;\nfeature Child;\nendplan',
    'plan p; attribute integer = 1; feature; endfeature endplan'];
  for (const text of documents) {
    const model = parseDocument(text);
    const check = (symbols: DocumentSymbol[], parent?: DocumentSymbol) => {
      for (const symbol of symbols) {
        const inside = (a: { line: number; character: number }, b: { line: number; character: number }) =>
          a.line < b.line || (a.line === b.line && a.character <= b.character);
        assert.ok(inside(symbol.range.start, symbol.selectionRange.start) &&
          inside(symbol.selectionRange.end, symbol.range.end),
          `${symbol.name}: ${JSON.stringify(symbol.selectionRange)} escapes ${JSON.stringify(symbol.range)}`);
        if (parent) {
          assert.ok(inside(parent.range.start, symbol.range.start) && inside(symbol.range.end, parent.range.end),
            `${symbol.name} escapes its parent ${parent.name}`);
        }
        check(symbol.children ?? [], symbol);
      }
    };
    check(provideDocumentSymbols(model));
  }
});

test('workspace symbols match by subsequence and name their plan', () => {
  const files = workspace({
    'a.hvp': 'plan alpha_plan;\nattribute integer phase_gate = 1;\nfeature Root;\nmeasure Line m; source = "x"; endmeasure\nendfeature\nendplan',
    'b.hvp': 'plan beta_plan;\nfeature Root;\nsubplan alpha_plan;\nendfeature\nendplan',
  });
  const names = (query: string) => provideWorkspaceSymbols(files.index, query)
    .map(symbol => `${symbol.containerName ?? '-'}.${symbol.name}`);
  assert.deepEqual(names('phg'), ['alpha_plan.phase_gate']);
  // Two features of the same name in two plans stay two entries, told apart by
  // the container.
  assert.deepEqual(names('Root'), ['alpha_plan.Root', 'beta_plan.Root']);
  assert.deepEqual(names('alpha_plan'), ['-.alpha_plan']);
  // A subplan statement is a use of a plan, not a definition of one.
  assert.equal(names('').filter(name => name.endsWith('.alpha_plan')).length, 1);
  assert.equal(names('zzz').length, 0);
  const symbol = provideWorkspaceSymbols(files.index, 'phase_gate')[0];
  assert.equal(symbol.kind, SymbolKind.Property);
  assert.equal(symbol.location.uri, files.uri('a.hvp'));
});

// ---------------------------------------------------------------------------
// Definition and references
// ---------------------------------------------------------------------------

const CACHE = `plan cache_plan;
attribute string root_mod = "";
attribute enum { low, normal, high } mode = normal;
metric ratio MyLine;
aggregator = average;
goal = MyLine >= 80%;
endmetric
feature cache;
mode = high;
measure MyLine, Line line_cov;
source = "instance: \${root_mod}level2";
endmeasure
endfeature
endplan`;

const TOP = `plan top_plan;
feature memory0;
subplan cache_plan #(root_mod = "u0.", mode = high);
endfeature
endplan`;

const MODS = `override patch;
top_plan.memory0.cache_plan.root_mod = "x.";
endoverride`;

const PLANS = { 'cache.hvp': CACHE, 'top.hvp': TOP, 'mods.hvp': MODS };

test('definition reaches across files from a subplan, an override path and an interpolation', () => {
  const files = workspace(PLANS);
  // A `subplan` statement names a plan another file declares.
  assert.deepEqual(files.definition('top.hvp', 'cache_plan'), ['cache.hvp:0:5']);
  // The first segment of an override path is a plan name too.
  assert.deepEqual(files.definition('mods.hvp', 'top_plan.memory0'), ['top.hvp:0:5']);
  // The last segment is an attribute of the plan the path resolves to — which
  // is `cache_plan`, reached through the instantiated hierarchy, not `top_plan`.
  assert.deepEqual(files.definition('mods.hvp', 'root_mod = "x."'), ['cache.hvp:1:17']);
  // A `#(name=...)` parameter names an attribute of the target plan.
  assert.deepEqual(files.definition('top.hvp', 'root_mod = "u0."'), ['cache.hvp:1:17']);
  // `${name}` inside a source string, through WS4's parsed interpolation.
  assert.deepEqual(files.definition('cache.hvp', '${root_mod}', 2), ['cache.hvp:1:17']);
  // A metric named in a measure, and the same metric named in its own goal.
  assert.deepEqual(files.definition('cache.hvp', 'measure MyLine', 8), ['cache.hvp:3:13']);
  assert.deepEqual(files.definition('cache.hvp', 'goal = MyLine', 7), ['cache.hvp:3:13']);
  // An enum member, from the value that selects it.
  assert.deepEqual(files.definition('cache.hvp', 'mode = high;', 7), ['cache.hvp:2:30']);
  // A built-in has no declaration site to jump to, and says so with nothing.
  assert.deepEqual(files.definition('cache.hvp', 'Line line_cov'), []);
});

test('references collect every shape of use across the workspace', () => {
  const files = workspace(PLANS);
  const expected = [
    'cache.hvp:1:17',  // the declaration
    'cache.hvp:10:22', // ${root_mod} in the source string
    'mods.hvp:1:28',   // the last segment of the override path
    'top.hvp:2:21',    // the #(root_mod=...) parameter
  ];
  assert.deepEqual(files.references('cache.hvp', 'root_mod'), expected);
  // The same set, asked from any of its members.
  assert.deepEqual(files.references('top.hvp', 'root_mod = "u0."'), expected);
  assert.deepEqual(files.references('cache.hvp', '${root_mod}', 2), expected);
  // A metric is named by its declaration, its own goal and every measure.
  assert.deepEqual(files.references('cache.hvp', 'metric ratio MyLine', 13),
    ['cache.hvp:3:13', 'cache.hvp:5:7', 'cache.hvp:9:8']);
  // An enum member is named by its member list, by an assignment and by a
  // subplan parameter value.
  assert.deepEqual(files.references('cache.hvp', 'high }', 0), ['cache.hvp:2:30', 'cache.hvp:8:7', 'top.hvp:2:46']);
});

test('a name declared in another plan is a different name', () => {
  const files = workspace({
    'a.hvp': 'plan a_plan;\nattribute integer phase_gate = 1;\nfeature f;\nphase_gate = 2;\nmeasure Line m; source = "x"; endmeasure\nendfeature\nendplan',
    'b.hvp': 'plan b_plan;\nattribute integer phase_gate = 9;\nfeature g;\nphase_gate = 8;\nmeasure Line m; source = "y"; endmeasure\nendfeature\nendplan',
  });
  assert.deepEqual(files.references('a.hvp', 'phase_gate'), ['a.hvp:1:18', 'a.hvp:3:0']);
  assert.deepEqual(files.references('b.hvp', 'phase_gate'), ['b.hvp:1:18', 'b.hvp:3:0']);
  assert.deepEqual(files.rename('a.hvp', 'phase_gate', 'gate'),
    { 'a.hvp': ['1:18=gate', '3:0=gate'] });
});

test('a comment, a plain string and an unnamed position resolve to nothing', () => {
  const files = workspace({
    'a.hvp': 'plan p;\nattribute string root_mod = "";\n// root_mod lives here\nfeature f;\nroot_mod = "not root_mod";\nmeasure Line m; source = "x"; endmeasure\nendfeature\nendplan',
  });
  assert.deepEqual(files.definition('a.hvp', '// root_mod', 3), []);
  assert.deepEqual(files.definition('a.hvp', '"not root_mod"', 6), []);
  assert.deepEqual(files.definition('a.hvp', 'feature f'), []);
  assert.equal(files.prepare('a.hvp', '// root_mod', 3), undefined);
  // The assignment on the line between them still resolves.
  assert.deepEqual(files.definition('a.hvp', 'root_mod = "not'), ['a.hvp:1:17']);
});

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

test('rename rewrites interpolations, parameters and override paths in every file', () => {
  const files = workspace(PLANS);
  assert.deepEqual(files.rename('cache.hvp', 'root_mod', 'base_mod'), {
    'cache.hvp': ['1:17=base_mod', '10:22=base_mod'],
    'mods.hvp': ['1:28=base_mod'],
    'top.hvp': ['2:21=base_mod'],
  });
  // Started from a use rather than from the declaration: the same edit.
  assert.deepEqual(files.rename('top.hvp', 'root_mod = "u0."', 'base_mod'),
    files.rename('cache.hvp', 'root_mod', 'base_mod'));
  assert.deepEqual(files.prepare('cache.hvp', 'root_mod'),
    { range: { start: { line: 1, character: 17 }, end: { line: 1, character: 25 } }, placeholder: 'root_mod' });
  // A metric, including the mention inside its own goal expression.
  assert.deepEqual(files.rename('cache.hvp', 'metric ratio MyLine', 'MyRatio', 13),
    { 'cache.hvp': ['3:13=MyRatio', '5:7=MyRatio', '9:8=MyRatio'] });
});

test('rename refuses rather than making a partial edit', () => {
  const files = workspace(PLANS);
  // Nothing this workstream renames.
  assert.match(files.refuse('cache.hvp', 'Line line_cov', 'x'), /built-in metric/);
  assert.match(files.refuse('top.hvp', 'cache_plan', 'x'), /is a plan name/);
  assert.match(files.refuse('cache.hvp', 'mode = high;', 'x', 7), /is a member of 'mode'/);
  // An invalid or already-taken new name.
  assert.match(files.refuse('cache.hvp', 'root_mod', '2mod'), /not a valid HVP identifier/);
  assert.match(files.refuse('cache.hvp', 'root_mod', 'owner'), /name of a built-in/);
  // A reserved word is not a legal new name either: renaming onto `plan` would
  // write a file that no longer parses. Same rule structuralDiagnostics reports
  // a bad declaration name with, so the two cannot drift.
  for (const word of ['plan', 'endfeature', 'enum', 'sum', 'source', 'match']) {
    assert.match(files.refuse('cache.hvp', 'root_mod', word), /not a valid HVP identifier/, word);
  }
  assert.match(files.refuse('cache.hvp', 'root_mod', 'mode'), /already declared in plan 'cache_plan'/);
  // The server withholds the index until the workspace scan settles; a rename
  // that cannot see the plan set refuses instead of editing this file alone.
  assert.match(files.unindexed('cache.hvp', 'root_mod', 'base_mod') as string,
    /workspace index is not available yet/);

  // A plan two files declare: which one owns the name is unknowable.
  const duplicated = workspace({
    'a.hvp': 'plan dup;\nattribute integer x = 1;\nfeature f;\nmeasure Line m; source = "a"; endmeasure\nendfeature\nendplan',
    'b.hvp': 'plan dup;\nattribute integer x = 2;\nfeature g;\nmeasure Line m; source = "b"; endmeasure\nendfeature\nendplan',
  });
  assert.match(duplicated.refuse('a.hvp', 'attribute integer x', 'y', 18), /declared in 2 files/);

  // Two declarations of one name in one plan: the model resolved one of them,
  // and the uses may mean either.
  const twice = workspace({
    'a.hvp': 'plan p;\nattribute integer x = 1;\nattribute integer x = 2;\nfeature f;\nmeasure Line m; source = "a"; endmeasure\nendfeature\nendplan',
  });
  assert.match(twice.refuse('a.hvp', 'attribute integer x', 'y', 18), /declared 2 times in plan 'p'/);

  // A filter expression names an attribute with no plan in front of it.
  const filtered = workspace({
    'a.hvp': 'plan p;\nattribute integer phase_gate = 1;\nfeature f;\nmeasure Line m; source = "a"; endmeasure\nendfeature\nendplan',
    'f.hvp': 'filter view;\nremove feature where phase_gate > 2;\nendfilter',
  });
  assert.match(filtered.refuse('a.hvp', 'phase_gate', 'gate'), /a filter expression at line 2 of .*f\.hvp/);

  // A wildcard segment reaches past the plan the path starts at. With one
  // declaration of the name in the workspace it can only have meant that one,
  // and the rename rewrites it; with two it could have meant either.
  const oneDeclaration = workspace({
    'a.hvp': 'plan p;\nattribute integer phase_gate = 1;\nfeature f;\nmeasure Line m; source = "a"; endmeasure\nendfeature\nendplan',
    'o.hvp': 'override ov;\np.**.phase_gate = 3;\nendoverride',
  });
  assert.deepEqual(oneDeclaration.rename('a.hvp', 'phase_gate', 'gate'),
    { 'a.hvp': ['1:18=gate'], 'o.hvp': ['1:5=gate'] });
  const twoDeclarations = workspace({
    'a.hvp': 'plan p;\nattribute integer phase_gate = 1;\nfeature f;\nsubplan q;\nendfeature\nendplan',
    'b.hvp': 'plan q;\nattribute integer phase_gate = 2;\nfeature g;\nmeasure Line m; source = "b"; endmeasure\nendfeature\nendplan',
    'o.hvp': 'override ov;\np.**.phase_gate = 3;\nendoverride',
  });
  assert.match(twoDeclarations.refuse('a.hvp', 'phase_gate', 'gate'), /wildcard can also match another plan/);
  // The other half of the same rule: a path that lands on a plan not declaring
  // the name at all has walked past whatever does declare it.
  const past = workspace({
    'a.hvp': 'plan p;\nfeature f;\nsubplan q;\nendfeature\nendplan',
    'b.hvp': 'plan q;\nattribute integer phase_gate = 2;\nfeature g;\nmeasure Line m; source = "b"; endmeasure\nendfeature\nendplan',
    'o.hvp': 'override ov;\np.**.phase_gate = 3;\nendoverride',
  });
  assert.match(past.refuse('b.hvp', 'phase_gate', 'gate'), /override path at line 2 of .*o\.hvp/);

  // A string the model does not read as a source expression still spells the
  // interpolation, and rewriting only the ones it does read would split them.
  const stringy = workspace({
    'a.hvp': 'plan p;\nattribute string root_mod = "";\nattribute string echo = "${root_mod}";\nfeature f;\nmeasure Line m; source = "a"; endmeasure\nendfeature\nendplan',
  });
  assert.match(stringy.refuse('a.hvp', 'root_mod', 'base'), /string literal at line 3/);

  // A statement the parser recovered from carries a syntax error already.
  const broken = workspace({
    'a.hvp': 'plan p;\nattribute integer phase_gate = 1;\nfeature f;\nphase_gate = 2\nmeasure Line m; source = "a"; endmeasure\nendfeature\nendplan',
  });
  assert.match(broken.refuse('a.hvp', 'phase_gate', 'gate'), /unparsed statement at line 4/);

  // A declaration written outside any plan has no scope to rename it in.
  const rootless = workspace({ 'a.hvp': 'attribute integer loose = 1;\n' });
  assert.match(rootless.refuse('a.hvp', 'loose', 'tight'), /declared outside any plan/);
});

test('prepareRename refuses at the same positions the rename does', () => {
  const files = workspace(PLANS);
  const refusal = (name: string, needle: string, offset = 0) => {
    const prepared = files.prepare(name, needle, offset);
    assert.ok(prepared && 'error' in prepared, `expected a refusal at '${needle}'`);
    return prepared.error;
  };
  assert.match(refusal('cache.hvp', 'Line line_cov'), /built-in metric/);
  assert.match(refusal('top.hvp', 'cache_plan'), /is a plan name/);
  assert.match(refusal('cache.hvp', 'mode = high;', 7), /is a member of 'mode'/);
  // A position that names nothing is not a refusal: the editor phrases that.
  assert.equal(files.prepare('cache.hvp', 'feature cache'), undefined);
});

test('the real fixture navigates end to end', () => {
  // `plan-model.hvp` in one string, so the parameter check WS5 added actually
  // runs over it — the fixture used to pass `priority` to a plan that declares
  // no such attribute, and nothing driving it through `parseDocument` alone
  // could have noticed.
  const model: PlanDocument = parseDocument(FIXTURE);
  const uri = 'file:///plans/plan-model.hvp';
  const index = buildIndex([{ uri, model }]);
  const options = { uri, index };
  const positionOf = (needle: string, offset = 0) => model.source.positionAt(FIXTURE.indexOf(needle) + offset);
  // The `mode = high` parameter now names an attribute `cache_plan` declares.
  assert.deepEqual(provideDefinition(model, positionOf('mode = high'), options)
    .map(location => `${location.range.start.line}:${location.range.start.character}`), ['3:37']);
  // The override path inside the `until` block addresses `cpu_plan`.
  assert.deepEqual(provideDefinition(model, positionOf('cpu_plan.**.priority'), options)
    .map(location => `${location.range.start.line}:${location.range.start.character}`), ['9:5']);
  assert.deepEqual(provideDocumentSymbols(model).map(symbol => symbol.name), ['cache_plan', 'cpu_plan', 'patch', 'scope']);
});

const FIXTURE = `// Syntax examples adapted from Using the HVP Language, including compact forms.
plan cache_plan;
attribute string root_mod = "";
attribute enum { low, normal, high } mode = normal;
feature cache;
measure Line line_cov; source = "instance: \${root_mod}level2"; endmeasure
endfeature
endplan

plan cpu_plan;
attribute enum {
  low, normal, high, -1
} priority = normal;
feature cpu;
subplan cache_plan #(
  root_mod = "top.mem0.",
  mode = high
);
measure test Measure_1;
source = "test1";
endmeasure
endfeature
until 12-31-2026;
  priority = low;
elseuntil 12-31-2027;
  override later; cpu_plan.**.priority = high; endoverride
else;
  filter scope; keep feature where priority > 0; endfilter
enduntil
endplan

override patch;
cpu_plan.cpu?.*.Line = Line > 85%;
endoverride
filter scope;
remove feature where priority == low;
endfilter`;

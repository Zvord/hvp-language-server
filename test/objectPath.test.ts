// The "copy object path" command's provider: the dotted hierarchy path under
// the cursor, resolved through the workspace index exactly as hover resolves
// the value table it links into.
import assert from 'node:assert/strict';
import test from 'node:test';
import { provideObjectPath } from '../src/core/objectPath';
import { parseDocument } from '../src/core/parser';
import { buildIndex } from '../src/core/workspace';

const SINGLE = `plan myplan;
feature cpu;
feature core1;
measure Line m1; source = "top.cpu.core1"; endmeasure
// a comment
attribute string note = "text";
endfeature
endfeature
endplan
`;

test('resolves plan, feature and measure paths with no workspace index', () => {
  const model = parseDocument(SINGLE);
  const at = (needle: string) => provideObjectPath(model, model.source.positionAt(SINGLE.indexOf(needle) + 1));
  assert.deepEqual(at('myplan'), { path: 'myplan', instances: 0 });
  assert.deepEqual(at('core1'), { path: 'myplan.cpu.core1', instances: 0 });
  assert.deepEqual(at('m1'), { path: 'myplan.cpu.core1.m1', instances: 0 });
});

test('undefined outside any node, and inside a comment or a plain string', () => {
  const model = parseDocument(SINGLE);
  // Past the closed plan's own end — no node covers it.
  assert.equal(provideObjectPath(model, model.source.positionAt(SINGLE.length)), undefined);
  assert.equal(provideObjectPath(model, model.source.positionAt(SINGLE.indexOf('a comment') + 2)), undefined);
  assert.equal(provideObjectPath(model, model.source.positionAt(SINGLE.indexOf('text'))), undefined);
});

const CACHE = `plan cache_plan;
attribute string root_mod = "";
feature single_reads;
measure Line snps; source = "\${root_mod}read"; endmeasure
endfeature
endplan`;

// The chapter's feature-groups shape, trimmed to two instances so the "one
// instance" and "several instances" cases can share one plan pair, differing
// only in how many times TOP instantiates cache_plan.
const oneInstance = () => `plan grp_enab_top;
feature memory0;
subplan cache_plan #(root_mod="memsys.u0.");
endfeature
endplan`;
const twoInstances = () => `plan grp_enab_top;
feature memory0;
subplan cache_plan #(root_mod="memsys.u0.");
endfeature
feature memory1;
subplan cache_plan #(root_mod="memsys.u1.");
endfeature
endplan`;

function workspace(top: string) {
  const cache = parseDocument(CACHE);
  const index = buildIndex([
    { uri: 'file:///cache.hvp', model: cache },
    { uri: 'file:///top.hvp', model: parseDocument(top) },
  ]);
  return { cache, index };
}

test('prefixes the instance path when the plan resolves to exactly one instance', () => {
  const { cache, index } = workspace(oneInstance());
  const offset = CACHE.indexOf('snps');
  const result = provideObjectPath(cache, cache.source.positionAt(offset), { uri: 'file:///cache.hvp', index });
  assert.deepEqual(result, { path: 'grp_enab_top.memory0.cache_plan.single_reads.snps', instances: 1 });
});

test('falls back to the local path when the plan has several instances or none', () => {
  const { cache, index } = workspace(twoInstances());
  const offset = CACHE.indexOf('snps');
  const result = provideObjectPath(cache, cache.source.positionAt(offset), { uri: 'file:///cache.hvp', index });
  assert.deepEqual(result, { path: 'cache_plan.single_reads.snps', instances: 2 });
  // No index at all: same local-path fallback, with a zero count.
  const noIndex = provideObjectPath(cache, cache.source.positionAt(offset));
  assert.deepEqual(noIndex, { path: 'cache_plan.single_reads.snps', instances: 0 });
});

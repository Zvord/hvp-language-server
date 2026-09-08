// WS4: source-string parsing, validation, completion and the expansion hover.
import assert from 'node:assert/strict';
import test from 'node:test';
import { provideCompletionItems } from '../src/core/completion';
import { checkExtendedRegex, firstUnescapedDot } from '../src/core/extendedRegex';
import { provideHover } from '../src/core/hover';
import { BUILTIN_METRIC_DECLARATIONS, SOURCE_KEYWORDS, SOURCE_MASK_WORDS } from '../src/core/keywords';
import { parseDocument } from '../src/core/parser';
import { PlanDocument, PlanNode } from '../src/core/planModel';
import { SourceExpression, parseSourceExpression } from '../src/core/sourceExpressions';

/** A one-measure plan whose single `source` statement holds `values`. */
const plan = (values: string, metrics = 'Line', declarations = ''): string =>
  `plan p;\n${declarations}feature f;\nmeasure ${metrics} m;\nsource = ${values};\nendmeasure\nendfeature\nendplan`;

const sourceNodes = (model: PlanDocument): (PlanNode & { kind: 'source' })[] =>
  model.nodes.filter((n): n is PlanNode & { kind: 'source' } => n.kind === 'source');

/** The parsed expression of the `index`-th string in the first `source`. */
const expressionOf = (text: string, index = 0): SourceExpression => {
  const model = parseDocument(text);
  return parseSourceExpression(model.source, sourceNodes(model)[0].values[index].tokens[0]);
};

const parse = (literal: string, metrics = 'Line'): SourceExpression => expressionOf(plan(literal, metrics));

const codes = (text: string) => parseDocument(text).diagnostics.filter(d => d.code).map(d => d.code);
const messages = (text: string) => parseDocument(text).diagnostics.filter(d => d.code).map(d => d.message);
const partKinds = (expression: SourceExpression) => expression.parts.map(p => [p.kind, p.text]);

const completionsAt = (text: string, needle: string, offsetInNeedle = needle.length) => {
  const model = parseDocument(text);
  return provideCompletionItems(model, model.source.positionAt(text.indexOf(needle) + offsetInNeedle));
};
const hoverAt = (text: string, needle: string) => {
  const model = parseDocument(text);
  const hover = provideHover(model, model.source.positionAt(text.indexOf(needle)));
  return hover && (hover.contents as { value: string }).value;
};

// ---------------------------------------------------------------------------
// The keyword prefix (Table 4)
// ---------------------------------------------------------------------------

test('a source string carries one of Table 4\'s keyword prefixes, or none', () => {
  const named = (literal: string, metrics = 'Line') => parse(literal, metrics).keyword?.info.name;
  assert.equal(named('"module: top"'), 'module');
  assert.equal(named('"instance : dut.hierarchy"'), 'instance');
  assert.equal(named('"tree:top.dut.u1"'), 'tree');
  assert.equal(named('"property: **.tinv"', 'Assert'), 'property');
  assert.equal(named('"group: cg"', 'Group'), 'group');
  assert.equal(named('"group bin: cg.cp.b1"', 'Group'), 'group bin');
  assert.equal(named('"group instance: cg.inst"', 'Group'), 'group instance');
  assert.equal(named('"group instance bin: cg.inst.cp.b"', 'Group'), 'group instance bin');
  // Both spellings of the mask prefix: Table 4 puts the colon after `property`,
  // the work plan puts it after the mask, and the chapter contradicts itself.
  assert.equal(named('"property: categoryMask \'h123 top.a"', 'Assert'), 'property categoryMask');
  assert.equal(named('"property severityMask \'hFFF: top.a"', 'Assert'), 'property severityMask');
  assert.equal(parse('"property: categoryMask \'h123 top.a"', 'Assert').keyword?.mask?.value, "'h123");
});

test('anything that is not a documented keyword leaves the string keywordless', () => {
  // A userdata region is flat and may hold colons of its own.
  assert.equal(parse('"/test/block1/read_write*"').keyword, undefined);
  assert.equal(parse('"top::cg.cp1"', 'Group').keyword, undefined);
  assert.equal(parse('"treee: top"').keyword, undefined);
  assert.equal(parse('"module top"').keyword, undefined);
  // A colon ends the keyword, so this names a covergroup called `instance`.
  const covergroup = parse('"group: instance.cp1"', 'Group');
  assert.equal(covergroup.keyword?.info.name, 'group');
  assert.equal(covergroup.pattern, ' instance.cp1');
  // `::` is the scope separator, never the keyword's colon.
  assert.equal(parse('"group: *.*::cg.cp"', 'Group').pattern, ' *.*::cg.cp');
});

// ---------------------------------------------------------------------------
// Wildcards, tags, regular expressions and interpolation
// ---------------------------------------------------------------------------

test('the pattern splits into literals, wildcards, tags and interpolations', () => {
  assert.deepEqual(partKinds(parse('"tree: top.dut.u?"')),
    [['keyword', 'tree:'], ['literal', ' top.dut.u'], ['wildcard', '?']]);
  assert.deepEqual(partKinds(parse('"tree: top.dut.**"')),
    [['keyword', 'tree:'], ['literal', ' top.dut.'], ['wildcard', '**']]);
  // `\*` is escaped, so it is literal text and not a wildcard.
  assert.deepEqual(partKinds(parse('"tree: a\\\\*b*"')),
    [['keyword', 'tree:'], ['literal', ' a\\*b'], ['wildcard', '*']]);
});

test('`r` opens regex mode, `n` closes it and `-` opens the removal expression', () => {
  // The chapter's own example: only "[0-2]" is a regular expression.
  const hybrid = parse('"tree: u1.u2.resetbank`r`[0-2]`n`.u88.planty"');
  assert.deepEqual(partKinds(hybrid), [['keyword', 'tree:'], ['literal', ' u1.u2.resetbank'],
    ['tag', '`r`'], ['regex', '[0-2]'], ['tag', '`n`'], ['literal', '.u88.planty']]);
  assert.deepEqual(hybrid.regexRuns.map(r => r.text), ['[0-2]']);

  // "the effect of the `r` does not span the `-` operator": the removal
  // expression starts again in wildcard mode.
  const removal = parse('"mod*`-`mod1`r`.*"');
  assert.ok(removal.hasRemoval);
  assert.deepEqual(partKinds(removal), [['literal', 'mod'], ['wildcard', '*'], ['tag', '`-`'],
    ['literal', 'mod1'], ['tag', '`r`'], ['regex', '.*']]);
  const positive = parse('"`r`mod.*`-`**_reset"');
  assert.deepEqual(positive.regexRuns.map(r => r.text), ['mod.*']);
  assert.deepEqual(partKinds(positive).slice(2), [['tag', '`-`'], ['wildcard', '**'], ['literal', '_reset']]);
});

test('${name} is a part of its own, wherever it appears', () => {
  const interpolated = parse('"instance: ${root_mod}level2"');
  assert.deepEqual(partKinds(interpolated),
    [['keyword', 'instance:'], ['literal', ' '], ['interpolation', '${root_mod}'], ['literal', 'level2']]);
  assert.deepEqual(interpolated.interpolations.map(i => [i.name, i.terminated]), [['root_mod', true]]);
  const unterminated = parse('"instance: ${root_mod"');
  assert.deepEqual(unterminated.interpolations.map(i => [i.name, i.terminated]), [['root_mod', false]]);
  // A regular expression an interpolation appears in stays one run, flagged, so
  // the checks that cannot be trusted on it can skip it whole.
  const inside = parse('"`r`(${alt}|iowa)"');
  assert.deepEqual(inside.regexRuns.map(r => [r.text, r.interpolated]), [['(${alt}|iowa)', true]]);
});

test('every part carries a range into the document, past the literal\'s escapes', () => {
  const text = plan('"tree: a\\\\b.*"');
  const model = parseDocument(text);
  const expression = parseSourceExpression(model.source, sourceNodes(model)[0].values[0].tokens[0]);
  // `\\` in the document is one backslash in the decoded string.
  assert.equal(expression.text, 'tree: a\\b.*');
  // A part carries decoded indices; `spanAt` is the one mapping back to the
  // document, and it has to step over the extra backslash to land on the `*`.
  const part = expression.parts.find(p => p.kind === 'wildcard')!;
  const wildcard = expression.spanAt(part.start, part.end);
  assert.equal(model.source.text.slice(wildcard.start, wildcard.end), '*');
  assert.equal(model.source.offsetAt(wildcard.range.start), wildcard.start);
  assert.notEqual(wildcard.start, text.indexOf('"tree') + 1 + part.start, 'the escape shifts the offset');
  // Same check on a document whose source line is preceded by other lines, so a
  // character offset alone could not have produced the right range.
  assert.equal(wildcard.range.start.line, model.source.positionAt(text.indexOf('"tree')).line);
});

// ---------------------------------------------------------------------------
// POSIX ERE checking
// ---------------------------------------------------------------------------

test('the hand-written ERE check reports only what POSIX and JS agree is broken', () => {
  const problems = (pattern: string) => checkExtendedRegex(pattern).map(p => p.message);
  assert.deepEqual(problems('(ohio|iowa)'), []);
  assert.deepEqual(problems('[bcwt][ao]ke'), []);
  assert.deepEqual(problems('u[12][0-9]+'), []);
  assert.deepEqual(problems('[[:alpha:]]+'), []);
  // A `]` right after `[` is a literal member of the set, not the closer.
  assert.deepEqual(problems('[]a]'), []);
  // POSIX has no notion of `{` as an error on its own; a literal brace stands.
  assert.deepEqual(problems('a{2}'), []);
  assert.match(problems('(ohio|iowa')[0], /Unclosed '\('/);
  assert.match(problems('ohio)')[0], /Unmatched '\)'/);
  assert.match(problems('[0-2')[0], /Unterminated bracket expression/);
  assert.match(problems('abc\\')[0], /incomplete escape/);
  assert.match(problems('*abc')[0], /nothing to repeat/);
  assert.match(problems('a|*b')[0], /nothing to repeat/);
});

test('the first unescaped dot is found outside bracket expressions only', () => {
  assert.equal(firstUnescapedDot('u1.u2.resetbank[0-2]'), 2);
  assert.equal(firstUnescapedDot('u1\\.u2\\.resetbank'), undefined);
  assert.equal(firstUnescapedDot('[a.b]c'), undefined);
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test('a keyword incompatible with every metric the measure names is a warning', () => {
  assert.deepEqual(codes(plan('"module: top"', 'Line')), []);
  assert.deepEqual(codes(plan('"group bin: cg.cp.b"', 'Group')), []);
  assert.deepEqual(codes(plan('"property: top.a"', 'Assert')), []);
  // SnpsAvg aggregates six built-ins, so every source format applies to it.
  assert.deepEqual(codes(plan('"group: cg"', 'SnpsAvg')), []);
  assert.deepEqual(codes(plan('"group: cg"', 'Line')), ['incompatible-source-keyword']);
  assert.match(messages(plan('"instance: dut.u1"', 'Group'))[0],
    /'instance:' applies to Assert, Line, Cond, Toggle, FSM, Branch, but this measure annotates Group/);
  // One metric in the list is enough for the keyword to be justified.
  assert.deepEqual(codes(plan('"module: top"', 'Line, Group')), []);
  // Outside Table 4 nothing is asserted: `test` comes from userdata, and a
  // declared metric's source format is the plan's own business.
  assert.deepEqual(codes(plan('"group: cg"', 'test')), []);
  assert.deepEqual(codes(plan('"group: cg"', 'Cov', 'metric ratio Cov;\nendmetric\n')), []);
  // A plan that redeclares a built-in owns the name, so Table 4 stops applying.
  // WS1's redeclaration warning is the only thing left to say about it.
  assert.deepEqual(codes(plan('"group: cg"', 'Line', 'metric ratio Line;\nendmetric\n')), ['builtin-redeclaration']);
});

test('regular expressions after `r` are checked, and the dot trap is a warning', () => {
  assert.deepEqual(codes(plan('"tree: u1.u2.`r`(ohio|iowa)"')), []);
  assert.deepEqual(codes(plan('"tree: u1.u2.resetbank`r`[0-2]"')), []);
  assert.deepEqual(codes(plan('"tree: `r`(ohio|iowa"')), ['invalid-source-regex']);
  assert.match(messages(plan('"tree: `r`[0-2"'))[0], /Unterminated bracket expression/);
  // The chapter's own example of the trap, and both of its documented fixes.
  assert.deepEqual(codes(plan('"tree: `r`u1.u2.resetbank[0-2]"')), ['unescaped-regex-dot']);
  assert.deepEqual(codes(plan('"tree: `r`u1\\\\.u2\\\\.resetbank[0-2]"')), []);
  assert.deepEqual(codes(plan('"tree: u1.u2.resetbank`r`[0-2]"')), []);
  // A run an interpolation could complete is left alone in both respects.
  assert.deepEqual(codes(plan('"tree: `r`(${owner}", "tree: `r`${owner}.x"')), []);
});

test("Table 4's rows are derived from the built-in metric table", () => {
  // The hazard this pins: Table 4's rows used to hand-write the same nine names
  // the built-in table already held, with no link between them, so a typo or a
  // renamed built-in dropped a name out of TABLE_4_METRICS and made the
  // compatibility check quietly stop firing — a check that fails open.
  const builtins = new Set(BUILTIN_METRIC_DECLARATIONS.map(m => m.name));
  for (const keyword of SOURCE_KEYWORDS) {
    for (const name of keyword.metrics) {
      assert.ok(builtins.has(name), `Table 4 row '${keyword.name}' names an unknown metric '${name}'`);
    }
  }
  // `SnpsAvg` joins every row, because it aggregates what those rows are for —
  // stated once, as its own `members`, not hand-added ten times.
  const snpsAvg = BUILTIN_METRIC_DECLARATIONS.find(m => m.name === 'SnpsAvg')!;
  for (const keyword of SOURCE_KEYWORDS) {
    assert.ok(keyword.metrics.includes('SnpsAvg'), `Table 4 row '${keyword.name}' omits SnpsAvg`);
    assert.ok(keyword.metrics.some(name => snpsAvg.members.includes(name)),
      `Table 4 row '${keyword.name}' names nothing SnpsAvg aggregates`);
  }
  // And the mask spellings come from the keywords that carry a mask.
  assert.deepEqual([...SOURCE_MASK_WORDS], ['categoryMask', 'severityMask']);
});

test('${name} must resolve to a declaration in scope or to objpath', () => {
  const declared = 'attribute string root_mod = "";\n';
  assert.deepEqual(codes(plan('"instance: ${root_mod}level2"', 'Line', declared)), []);
  assert.deepEqual(codes(plan('"${objpath}"', 'test')), []);
  // Built-ins count, since they are declarations like any other.
  assert.deepEqual(codes(plan('"instance: ${owner}"')), []);
  assert.deepEqual(codes(plan('"instance: ${root_mod}"')), ['unknown-interpolation']);
  assert.match(messages(plan('"instance: ${root_mod}"'))[0], /not an attribute or annotation declared in this plan/);
  assert.deepEqual(codes(plan('"instance: ${root_mod"', 'Line', declared)), ['invalid-interpolation']);
  // A body that is not an identifier at all is a form the chapter never shows.
  assert.deepEqual(codes(plan('"instance: ${a b}"')), []);
  // A metric is not one of them: interpolation substitutes a *value* into the
  // string, and a metric carries a goal expression rather than a value. One rule
  // (resolver.ts's `interpolates`), so the checker, hover and completion agree —
  // they used to disagree three ways about exactly this name.
  assert.deepEqual(codes(plan('"instance: ${Line}"')), ['unknown-interpolation']);
  assert.deepEqual(codes(plan('"instance: ${Cov}"', 'Cov', 'metric ratio Cov;\nendmetric\n')),
    ['unknown-interpolation']);
});

test('sources differing only in their last segment earn a wildcard hint', () => {
  const three = plan('"tree: top.dut.u1", "tree: top.dut.u2", "tree: top.dut.u3"');
  assert.deepEqual(codes(three), ['wildcard-source-opportunity']);
  assert.match(messages(three)[0], /One pattern, "tree: top\.dut\.\*", would match all of them/);
  // Two is not enough to be worth saying.
  assert.deepEqual(codes(plan('"tree: top.dut.u1", "tree: top.dut.u2"')), []);
  // Differing higher up the hierarchy is not the case a single wildcard covers.
  assert.deepEqual(codes(plan('"tree: top.a.u1", "tree: top.b.u1", "tree: top.c.u1"')), []);
  // Neither is a set that already wildcards its last segment.
  assert.deepEqual(codes(plan('"tree: top.dut.u1*", "tree: top.dut.u2*", "tree: top.dut.u3*"')), []);
  // The strings may be spread over several `source` statements in one measure.
  assert.deepEqual(codes(`plan p;\nfeature f;\nmeasure Line m;\nsource = "tree: t.d.u1";\n`
    + `source = "tree: t.d.u2", "tree: t.d.u3";\nendmeasure\nendfeature\nendplan`),
    ['wildcard-source-opportunity']);
});

test('nothing is reported on a statement the parser already recovered from', () => {
  // The missing semicolon is the only complaint; the unknown ${name} is not
  // stacked on top of it.
  const recovered = parseDocument('plan p;\nfeature f;\nmeasure Line m;\nsource = "${nope}"\nendmeasure\nendfeature\nendplan');
  assert.deepEqual(recovered.diagnostics.filter(d => d.code).map(d => d.code), []);
  // Nor on a `source` statement whose own value run the parser could not reduce
  // to a single string literal.
  assert.deepEqual(codes('plan p;\nfeature f;\nmeasure Line m;\nsource = "a" "b";\nendmeasure\nendfeature\nendplan'), []);
});

// ---------------------------------------------------------------------------
// Completion and hover
// ---------------------------------------------------------------------------

test('keyword prefixes complete at the head of a source string only', () => {
  const text = plan('"gr"', 'Group');
  const labels = completionsAt(text, '"gr').map(i => i.label);
  assert.deepEqual(labels, ['group:', 'group bin:', 'group instance:', 'group instance bin:']);
  // The replacement covers what was typed, not just the caret.
  const edit = completionsAt(text, '"gr')[0].textEdit!;
  assert.equal('range' in edit && edit.range.end.character - edit.range.start.character, 2);
  assert.deepEqual(completionsAt(plan('""'), '"').map(i => i.label).slice(0, 2), ['module:', 'instance:']);
  // Past the prefix the pattern is data this server has no index of.
  assert.deepEqual(completionsAt(plan('"tree: top.d"'), 'top.d'), []);
  // And a string that is not a `source` value still suppresses completion.
  assert.deepEqual(completionsAt('plan p;\nowner = "gr";\nendplan', '"gr'), []);
});

test('attribute, annotation and objpath names complete inside ${', () => {
  const text = plan('"instance: ${}"', 'Line', 'attribute string root_mod = "";\nannotation string note = "";\n');
  const labels = completionsAt(text, '${').map(i => i.label);
  assert.ok(labels.includes('objpath'));
  assert.ok(labels.includes('root_mod'));
  assert.ok(labels.includes('note'));
  assert.ok(labels.includes('owner'), 'built-in attributes are declarations too');
  assert.ok(!labels.includes('Line'), 'a metric is not substituted into a source string');
  // Partially typed, the edit replaces the name and not the braces.
  const typed = plan('"instance: ${root}"', 'Line', 'attribute string root_mod = "";\n');
  const item = completionsAt(typed, '${root', 6).find(i => i.label === 'root_mod')!;
  const edit = item.textEdit!;
  assert.equal('range' in edit && edit.range.start.character, typed.split('\n')[4].indexOf('${root') + 2);
});

test('hover on a source string shows the string as the tool expands it', () => {
  const text = `plan cache_plan;\nattribute string root_mod = "";\nfeature cache1;\nroot_mod = "top.";\n`
    + `measure Line cov;\nsource = "instance: \${root_mod}level2";\nendmeasure\nendfeature\nendplan`;
  const hover = hoverAt(text, '"instance:')!;
  assert.match(hover, /Expands to `instance: top\.level2`/);
  assert.match(hover, /Keyword `instance:`/);
  assert.match(hover, /\| `\$\{root_mod\}` \| `top\.` \| assigned in cache1 \|/);

  // The chapter's second example: ${objpath} is plan.feature.measure.
  const objpath = `plan cache_plan;\nfeature cache1;\nmeasure test mBug;\nsource = "\${objpath}";\n`
    + `endmeasure\nendfeature\nendplan`;
  assert.match(hoverAt(objpath, '"${objpath}')!, /Expands to `cache_plan\.cache1\.mBug`/);

  // A name that resolves to nothing stays as written rather than vanishing.
  const unknown = plan('"instance: ${nope}x"');
  assert.match(hoverAt(unknown, '"instance:')!, /Expands to `instance: \$\{nope\}x`/);

  // A removal expression is called out, since it subtracts from the match.
  assert.match(hoverAt(plan('"mod*`-`mod1*"'), '"mod')!, /removal expression/);
});

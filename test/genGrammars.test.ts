// Tests for tools/gen-grammars.ts (see ../MIGRATION.md, Phase 2). Two things
// need proving: (1) the regenerated tmLanguage is semantically equivalent to
// the checked-in vscode-hvp/syntaxes/hvp.tmLanguage.json (same keyword sets
// per scope — that file is a checked-in copy of this generator's own output,
// re-synced whenever keywords.ts changes, per vscode-hvp/README.md's "Syntax
// grammar" section), and (2) the longest-first alternation ordering actually
// prevents the "short prefix wins" regex trap for dotted names like `test`
// vs. `test.percent.pass`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { generateGrammars } from '../tools/gen-grammars';
import { SOURCE_KEYWORDS, SOURCE_TAGS, SOURCE_WILDCARDS } from '../src/core/keywords';

const PACKAGE_ROOT = process.cwd();
const HVP_ROOT = path.resolve(PACKAGE_ROOT, '..');
const HAND_WRITTEN_PATH = path.join(HVP_ROOT, 'vscode-hvp', 'syntaxes', 'hvp.tmLanguage.json');

const REPO_KEYS = ['keywords-block', 'keywords-declaration', 'keywords-type', 'keywords-field', 'builtin-metrics', 'keywords-filter'];

/** The `source-string` sub-patterns, by the scope each one applies. A source
 * string's rules are a pattern *list*, not one alternation per scope, so they
 * are addressed by scope name rather than by index. */
function sourcePattern(tmLanguage: any, scope: string): any {
  const found = tmLanguage.repository['source-string'].patterns.filter(
    (p: any) => p.name === scope || Object.values(p.captures ?? {}).some((c: any) => c.name === scope)
  );
  assert.ok(found.length > 0, `source-string has a pattern scoped ${scope}`);
  return found;
}

/**
 * Expands a regex alternation/concatenation/group pattern (the small subset
 * these grammars use: literal chars, `\`-escaped chars including `\b`
 * anchors, `(...)`  groups, and `|` alternation, no nesting beyond what the
 * grammars actually use) into the set of literal strings it can match.
 * Needed because the hand-written grammar nests alternation inside a shared
 * prefix (e.g. `test\.percent\.(pass|fail|warn|unknown|assert)`) while the
 * generator emits one flat alternation per scope — both are valid regexes
 * for the same keyword set, so a flat `split('|')` isn't enough to compare
 * them; this recovers the actual matched-string set from either shape.
 */
function expandKeywords(pattern: string): string[] {
  const pos = { i: 0 };

  function parseSequence(): string[] {
    let results = [''];
    while (pos.i < pattern.length && pattern[pos.i] !== '|' && pattern[pos.i] !== ')') {
      let piece: string[];
      if (pattern[pos.i] === '(') {
        pos.i++; // consume '('
        piece = parseAlternation();
        if (pattern[pos.i] === ')') pos.i++; // consume ')'
      } else if (pattern[pos.i] === '\\') {
        const escaped = pattern[pos.i + 1];
        pos.i += 2;
        if (escaped === 'b') continue; // zero-width word-boundary anchor
        piece = [escaped];
      } else {
        piece = [pattern[pos.i]];
        pos.i++;
      }
      results = results.flatMap((r) => piece.map((p) => r + p));
    }
    return results;
  }

  function parseAlternation(): string[] {
    const branches = [parseSequence()];
    while (pos.i < pattern.length && pattern[pos.i] === '|') {
      pos.i++; // consume '|'
      branches.push(parseSequence());
    }
    return branches.flat();
  }

  return parseAlternation();
}

test('generated tmLanguage has the expected static scaffolding', () => {
  const { tmLanguage } = generateGrammars() as any;
  assert.equal(tmLanguage.scopeName, 'source.hvp');
  assert.ok(tmLanguage.repository.comments, 'comments section copied from the static template');
  assert.ok(tmLanguage.repository.strings, 'strings section copied from the static template');
  assert.ok(tmLanguage.repository.numbers, 'numbers section copied from the static template');
  assert.ok(tmLanguage.repository.operators, 'operators section copied from the static template');
  assert.ok(tmLanguage.repository['declaration-name'], 'declaration-name section copied from the static template');
});

test('generated tmLanguage keyword sets are semantically equivalent to the hand-written grammar', () => {
  const { tmLanguage } = generateGrammars() as any;
  const handWritten = JSON.parse(readFileSync(HAND_WRITTEN_PATH, 'utf8'));

  for (const key of REPO_KEYS) {
    const generatedSet = new Set(expandKeywords(tmLanguage.repository[key].match));
    const handSet = new Set(expandKeywords(handWritten.repository[key].match));
    assert.equal(tmLanguage.repository[key].name, handWritten.repository[key].name, `scope name for ${key}`);

    assert.deepStrictEqual([...generatedSet].sort(), [...handSet].sort(), `keyword set for ${key}`);
  }
});

test('longest-first ordering: dotted builtin-metric names are matched in full, not truncated to a shorter prefix', () => {
  const { tmLanguage } = generateGrammars() as any;
  const re = new RegExp(tmLanguage.repository['builtin-metrics'].match);

  assert.equal(re.exec('test.percent.pass')?.[0], 'test.percent.pass');
  assert.equal(re.exec('test.pass')?.[0], 'test.pass');
  assert.equal(re.exec('just test here')?.[0], 'test');
  assert.equal(new RegExp(tmLanguage.repository['builtin-metrics'].match).exec('Group.grp_count')?.[0], 'Group.grp_count');
  assert.equal(new RegExp(tmLanguage.repository['builtin-metrics'].match).exec('a Group value')?.[0], 'Group');
});

test('generated sublime-syntax has one context per generated scope, keyed the same as the tmLanguage repository', () => {
  const { sublimeSyntax } = generateGrammars();
  assert.match(sublimeSyntax, /^%YAML 1\.2/);
  for (const key of REPO_KEYS) {
    assert.match(sublimeSyntax, new RegExp(`\\n  ${key}:\\n`), `context block for ${key}`);
  }
});

test('both formats list the top-level rules in the same order, from one table', () => {
  const { tmLanguage, sublimeSyntax } = generateGrammars();
  const tmOrder = (tmLanguage as any).patterns.map((p: any) => p.include.replace(/^#/, ''));
  const main = sublimeSyntax.match(/\n  main:\n((?:    - include: [a-z-]+\n)+)/);
  assert.ok(main, 'sublime main context');
  const sublimeOrder = main![1].trim().split('\n').map((line) => line.replace('- include: ', '').trim());
  assert.deepEqual(sublimeOrder, tmOrder);
  // Order is load-bearing, not incidental: a source string must beat the plain
  // string rule, and both must beat the `#(` of a subplan parameter list.
  assert.ok(tmOrder.indexOf('source-statement') < tmOrder.indexOf('strings'));
  assert.ok(tmOrder.indexOf('strings') < tmOrder.indexOf('subplan-parameters'));
});

test('gen-grammars CLI writes valid JSON and sublime-syntax files to generated/', () => {
  execFileSync(process.execPath, [path.join(PACKAGE_ROOT, 'out', 'tools', 'gen-grammars.js')], { cwd: PACKAGE_ROOT });

  const tmLanguageText = readFileSync(path.join(PACKAGE_ROOT, 'generated', 'hvp.tmLanguage.json'), 'utf8');
  const parsed = JSON.parse(tmLanguageText); // throws if not valid JSON
  assert.equal(parsed.scopeName, 'source.hvp');

  const sublimeSyntaxText = readFileSync(path.join(PACKAGE_ROOT, 'generated', 'HVP.sublime-syntax'), 'utf8');
  assert.match(sublimeSyntaxText, /^%YAML 1\.2/);
  assert.match(sublimeSyntaxText, /\nscope: source\.hvp\n/);
});

// --- WS8b: source strings, enum/aggregate members, subplan parameters -------

/**
 * The `source-string` rules applied to one string body the way a TextMate
 * engine applies a pattern list: leftmost match wins, ties broken by the order
 * the patterns are listed. Enough of the engine to assert what gets scoped.
 */
function scanSourceString(tmLanguage: any, body: string): { at: number; scope: string; text: string }[] {
  const rules = tmLanguage.repository['source-string'].patterns.map((p: any) => ({
    re: new RegExp(p.match),
    scopeOf: (m: RegExpExecArray) =>
      p.name ??
      // A capture-scoped rule: report the scope of the first non-empty capture.
      (Object.entries(p.captures as Record<string, { name: string }>).find(([i]) => m[Number(i)])?.[1].name as string),
  }));
  const out: { at: number; scope: string; text: string }[] = [];
  for (let i = 0; i < body.length; ) {
    let best: { at: number; scope: string; text: string } | undefined;
    for (const rule of rules) {
      const m = new RegExp(rule.re.source).exec(body.slice(i));
      if (!m) continue;
      const at = i + m.index;
      if (!best || at < best.at) best = { at, scope: rule.scopeOf(m), text: m[0] };
    }
    if (!best) break;
    out.push(best);
    i = best.at + Math.max(best.text.length, 1);
  }
  return out;
}

/** The whole-match text the source-keyword rule finds at the head of `body`. */
function sourceKeywordAt(tmLanguage: any, body: string): string | undefined {
  const first = scanSourceString(tmLanguage, body)[0];
  return first?.at === 0 && first.scope === 'keyword.other.source.hvp' ? first.text : undefined;
}

test('longest-first ordering: group instance bin beats group instance, which beats group', () => {
  const { tmLanguage } = generateGrammars() as any;

  assert.equal(sourceKeywordAt(tmLanguage, 'group instance bin: cg.i.cp.b'), 'group instance bin:');
  assert.equal(sourceKeywordAt(tmLanguage, 'group instance: cg.i'), 'group instance:');
  assert.equal(sourceKeywordAt(tmLanguage, 'group bin: cg.cp.b'), 'group bin:');
  assert.equal(sourceKeywordAt(tmLanguage, 'group: cg.cp'), 'group:');
});

test('every Table 4 source keyword is scoped, and only through keywords.ts', () => {
  const { tmLanguage } = generateGrammars() as any;
  for (const keyword of SOURCE_KEYWORDS) {
    const body = keyword.mask ? `${keyword.name} 'h00f: top.a` : `${keyword.name}: top.a`;
    const first = scanSourceString(tmLanguage, body)[0];
    assert.equal(first?.at, 0, `${keyword.name} is scoped at the head of its string`);
    assert.equal(first?.scope, 'keyword.other.source.hvp', `${keyword.name} takes the source-keyword scope`);
  }
});

test("`::` is the database scope separator, never a keyword's colon", () => {
  const { tmLanguage } = generateGrammars() as any;
  // `group: instance.cp1` names a covergroup called `instance` (the WS4 trap).
  assert.equal(sourceKeywordAt(tmLanguage, 'group: instance.cp1'), 'group:');
  // A package qualifier that happens to end in a keyword word must not match.
  const scoped = scanSourceString(tmLanguage, 'cmm_pkg::cmm_checker_coverage::cg');
  assert.deepEqual(scoped, [], 'nothing in a `::`-qualified path is scoped');
  assert.equal(sourceKeywordAt(tmLanguage, 'module::foo'), undefined);
});

test("both documented spellings of the property 'h### mask are scoped, value included", () => {
  const { tmLanguage } = generateGrammars() as any;
  for (const body of [
    "property categoryMask 'h00f: top.cpu.a",
    "property categorymask 'h00f: top.cpu.a",
    "property: severityMask 'h010",
  ]) {
    const parts = scanSourceString(tmLanguage, body);
    assert.equal(parts[0].at, 0, body);
    assert.equal(parts[0].scope, 'keyword.other.source.hvp', body);
    assert.ok(
      /'h[0-9A-Fa-f]+/.test(parts[0].text),
      `${body}: the mask value is part of the keyword match, in its own capture`
    );
  }
  // The mask rules must be listed before the bare `property:` rule, or that
  // rule would match first at the same offset and swallow the mask spelling.
  const patterns: string[] = tmLanguage.repository['source-string'].patterns.map((p: any) => p.match ?? '');
  const maskIndex = patterns.findIndex((m: string) => m.includes('categoryMask'));
  const plainIndex = patterns.findIndex((m: string) => m.includes('group[ \\t]+instance[ \\t]+bin'));
  assert.ok(maskIndex >= 0 && plainIndex > maskIndex, 'mask rules precede the plain keyword rule');
});

test('source tags and wildcards are the keywords.ts tables, with ** ahead of *', () => {
  const { tmLanguage } = generateGrammars() as any;
  const tagRule = sourcePattern(tmLanguage, 'keyword.other.tag.hvp')[0];
  const wildcardRule = sourcePattern(tmLanguage, 'keyword.operator.wildcard.hvp')[0];

  for (const tag of SOURCE_TAGS) assert.equal(new RegExp(tagRule.match).exec(`a${tag}b`)?.[0], tag);
  for (const wildcard of SOURCE_WILDCARDS) {
    assert.equal(new RegExp(wildcardRule.match).exec(wildcard)?.[0], wildcard, wildcard);
  }
  // The longest-first trap, one level down from the dotted metric names.
  assert.equal(new RegExp(wildcardRule.match).exec('top.**.u')?.[0], '**');
});

test('a source string scopes its keyword, tags, wildcards and interpolation, and escapes win over wildcards', () => {
  const { tmLanguage } = generateGrammars() as any;
  assert.deepEqual(
    scanSourceString(tmLanguage, 'module: `r`top\\.[a-z]+`n`.**').map((p) => [p.text, p.scope]),
    [
      ['module:', 'keyword.other.source.hvp'],
      ['`r`', 'keyword.other.tag.hvp'],
      ['\\.', 'constant.character.escape.hvp'],
      ['`n`', 'keyword.other.tag.hvp'],
      ['**', 'keyword.operator.wildcard.hvp'],
    ]
  );
  assert.deepEqual(
    scanSourceString(tmLanguage, 'tree: ${objpath}.\\*').map((p) => [p.text, p.scope]),
    [
      ['tree:', 'keyword.other.source.hvp'],
      ['${objpath}', 'variable.other.hvp'],
      // `\*` is an escaped literal asterisk, not a wildcard: the escape rule is
      // listed first for exactly this case.
      ['\\*', 'constant.character.escape.hvp'],
    ]
  );
});

test('source strings are recognised through the `source` statement, so a keywordless pattern still scopes', () => {
  const { tmLanguage } = generateGrammars() as any;
  const statement = tmLanguage.repository['source-statement'];
  assert.match('source = "top.cpu.*";', new RegExp(statement.begin));
  assert.equal(statement.end, ';');
  assert.deepEqual(statement.patterns, [{ include: '#comments' }, { include: '#source-string' }]);
  assert.deepEqual(
    scanSourceString(tmLanguage, 'top.cpu.*').map((p) => p.scope),
    ['keyword.operator.wildcard.hvp']
  );
});

test('enum members, aggregate members with weights, and subplan parameters each get their own scope', () => {
  const { tmLanguage } = generateGrammars() as any;

  const enumMembers = tmLanguage.repository['enum-members'];
  assert.match('attribute enum{orange, apple}', new RegExp(enumMembers.begin));
  assert.match('metric enum {pass, fail} uniq;', new RegExp(enumMembers.begin));
  const member = enumMembers.patterns.find((p: any) => p.name === 'variable.other.enummember.hvp');
  assert.equal(new RegExp(member.match).exec('orange, apple')?.[0], 'orange');
  // `enum-identifier ::= identifier | INT | SNUM`, so numbers are members too.
  assert.ok(enumMembers.patterns.some((p: any) => p.include === '#numbers'));

  const aggregateMembers = tmLanguage.repository['aggregate-members'];
  assert.match('metric aggregate {Line(weight=1.0)} A;', new RegExp(aggregateMembers.begin));
  const weight = aggregateMembers.patterns.find((p: any) => p.captures?.['1']?.name === 'variable.other.property.hvp');
  assert.equal(new RegExp(weight.match).exec('weight=1.0')?.[0], 'weight=');
  const name = aggregateMembers.patterns.find((p: any) => p.name === 'entity.name.type.hvp');
  assert.equal(new RegExp(name.match).exec('Line(weight=1.0)')?.[0], 'Line');

  const parameters = tmLanguage.repository['subplan-parameters'];
  assert.match('subplan cache_plan #(root_mod="top.", grpA=0);', new RegExp(parameters.begin));
  const parameter = parameters.patterns.find((p: any) => p.captures?.['1']?.name === 'variable.parameter.hvp');
  assert.equal(new RegExp(parameter.match).exec('root_mod="top."')?.[1], 'root_mod');
});

test('the `#(` of a subplan parameter list never fires inside a source string', () => {
  const { tmLanguage } = generateGrammars() as any;
  // mipi_dphy.hvp has 53 source strings; several carry a SystemVerilog
  // parameterised class name (`..._cg#(10)::cg...`). #source-statement and
  // #strings both precede #subplan-parameters in the include list, so the
  // string wins at the earlier offset and the `#(` is never reached.
  const order = tmLanguage.patterns.map((p: any) => p.include);
  assert.ok(order.indexOf('#source-statement') < order.indexOf('#subplan-parameters'));
  assert.ok(order.indexOf('#strings') < order.indexOf('#subplan-parameters'));
  assert.ok(order.indexOf('#source-statement') < order.indexOf('#strings'), 'source strings beat plain strings');
});

test('the declaration-name keywords come from the block table, not a literal', () => {
  const { tmLanguage } = generateGrammars() as any;
  const match = tmLanguage.repository['declaration-name'].match;
  assert.deepEqual(
    new Set(expandKeywords(/\(([^)]*)\)/.exec(match)![1])),
    new Set(['feature', 'plan', 'override', 'filter', 'subplan'])
  );
  assert.equal(new RegExp(match).exec('  feature Fetch')?.[2], 'Fetch');
});

test('WS1 dropped `phase` from the field scope', () => {
  const { tmLanguage, sublimeSyntax } = generateGrammars() as any;
  assert.ok(!expandKeywords(tmLanguage.repository['keywords-field'].match).includes('phase'));
  assert.ok(!/\bphase\b/.test(sublimeSyntax));
});

test('the sublime syntax carries WS8b contexts whose patterns read back identical to the tmLanguage ones', () => {
  const { tmLanguage, sublimeSyntax } = generateGrammars() as any;
  // Sublime spells a pushed context `inside-<name>`; the tmLanguage repository
  // spells the same rules under the entry that includes them.
  for (const key of ['source-statement', 'inside-source-statement', 'inside-source-string', 'enum-members',
                     'inside-enum-members', 'aggregate-members', 'inside-aggregate-members', 'subplan-parameters',
                     'inside-subplan-parameters']) {
    assert.match(sublimeSyntax, new RegExp(`\\n  ${key}:\\n`), `context block for ${key}`);
  }

  // YAML single-quoted scalars escape `'` as `''` — the `'h###` mask patterns
  // are the first generated regexes that contain one, so prove the quoting is
  // reversible rather than trusting it.
  const quoted = new Set(
    [...sublimeSyntax.matchAll(/^\s+- match: '((?:[^']|'')*)'$/gm)].map((m) => m[1].replace(/''/g, "'"))
  );
  const expected = [
    tmLanguage.repository['source-statement'].begin,
    tmLanguage.repository['enum-members'].begin,
    tmLanguage.repository['aggregate-members'].begin,
    tmLanguage.repository['subplan-parameters'].begin,
    tmLanguage.repository['declaration-name'].match,
    ...tmLanguage.repository['source-string'].patterns.map((p: any) => p.match),
    ...tmLanguage.repository['aggregate-members'].patterns.map((p: any) => p.match),
  ].filter(Boolean);
  for (const pattern of expected) {
    assert.ok(quoted.has(pattern), `sublime syntax carries ${JSON.stringify(pattern)}`);
  }
});

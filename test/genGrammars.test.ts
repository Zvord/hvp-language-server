// Tests for tools/gen-grammars.ts (see ../MIGRATION.md, Phase 2). Two things
// need proving: (1) the regenerated tmLanguage is semantically equivalent to
// the pre-Phase-2 hand-written vscode-hvp/syntaxes/hvp.tmLanguage.json (same
// keyword sets per scope, modulo `apply` — a keyword added to keywords.ts
// after the hand-written grammar was last touched, i.e. exactly the
// hand-sync drift this generator exists to eliminate), and (2) the
// longest-first alternation ordering actually prevents the "short prefix
// wins" regex trap for dotted names like `test` vs. `test.percent.pass`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { generateGrammars } from '../tools/gen-grammars';

const PACKAGE_ROOT = process.cwd();
const HVP_ROOT = path.resolve(PACKAGE_ROOT, '..');
const HAND_WRITTEN_PATH = path.join(HVP_ROOT, 'vscode-hvp', 'syntaxes', 'hvp.tmLanguage.json');

const REPO_KEYS = ['keywords-block', 'keywords-declaration', 'keywords-type', 'keywords-field', 'builtin-metrics', 'keywords-filter'];

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

    if (key === 'keywords-field') {
      assert.ok(generatedSet.has('apply'), "'apply' is new in keywords.ts since the hand-written grammar was last touched");
      generatedSet.delete('apply');
    }
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

test('gen-grammars CLI writes valid JSON and sublime-syntax files to generated/', () => {
  execFileSync(process.execPath, [path.join(PACKAGE_ROOT, 'out', 'tools', 'gen-grammars.js')], { cwd: PACKAGE_ROOT });

  const tmLanguageText = readFileSync(path.join(PACKAGE_ROOT, 'generated', 'hvp.tmLanguage.json'), 'utf8');
  const parsed = JSON.parse(tmLanguageText); // throws if not valid JSON
  assert.equal(parsed.scopeName, 'source.hvp');

  const sublimeSyntaxText = readFileSync(path.join(PACKAGE_ROOT, 'generated', 'HVP.sublime-syntax'), 'utf8');
  assert.match(sublimeSyntaxText, /^%YAML 1\.2/);
  assert.match(sublimeSyntaxText, /\nscope: source\.hvp\n/);
});

// Targeted lexical edge cases not exercised by the fixtures. Masking used to be
// a per-line regex pass; the tokenizer now owns it, so these assert on the
// comment/string tokens it produces.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceText, Token, tokenize } from '../src/core/tokenizer';

const tokensOf = (text: string): Token[] => tokenize(new SourceText(text)).tokens;
const textsOf = (text: string, kind: Token['kind']): string[] =>
  tokensOf(text).filter(t => t.kind === kind).map(t => t.text);

test('escaped quote inside a string does not end it early', () => {
  assert.deepEqual(textsOf('description = "say \\"feature\\" here";', 'string'),
    ['"say \\"feature\\" here"']);
});

test('// inside a string is not treated as a comment start', () => {
  const text = 'source = "http://example.com"; feature Foo;';
  assert.deepEqual(textsOf(text, 'string'), ['"http://example.com"']);
  assert.deepEqual(textsOf(text, 'comment'), []);
  // The `feature` after the string is still a real keyword token.
  assert.ok(tokensOf(text).some(t => t.kind === 'identifier' && t.text === 'feature'));
});

test('block comment spanning multiple lines swallows the keywords inside it', () => {
  const text = '/* feature Foo\nendfeature still commented\nstill commented */ feature Bar;';
  assert.deepEqual(textsOf(text, 'comment'),
    ['/* feature Foo\nendfeature still commented\nstill commented */']);
  // Only the `feature` after the closing */ survives as a keyword.
  assert.deepEqual(textsOf(text, 'identifier'), ['feature', 'Bar']);
});

test('unterminated block comment runs to EOF and is diagnosed', () => {
  const { tokens, diagnostics } = tokenize(new SourceText('/* feature Foo'));
  assert.deepEqual(tokens.map(t => t.kind), ['comment']);
  assert.equal(tokens[0].terminated, false);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Unterminated block comment/);
});

test('unterminated string runs to EOF and is diagnosed', () => {
  const { tokens, diagnostics } = tokenize(new SourceText('description = "no end'));
  const string = tokens.find(t => t.kind === 'string');
  assert.equal(string?.text, '"no end');
  assert.equal(string?.terminated, false);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Unterminated string literal/);
});

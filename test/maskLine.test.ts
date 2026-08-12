import assert from 'node:assert/strict';
import test from 'node:test';
import { maskLine, MaskState } from '../src/core/blockAnalysis';

test('maskLine: escaped quote inside a string does not end it early', () => {
  const state: MaskState = { inBlockComment: false };
  const masked = maskLine('description = "say \\"feature\\" here";', state);
  // The escaped quotes keep the string open through "feature", so it stays masked.
  assert.equal(masked.includes('feature'), false);
});

test('maskLine: // inside a string is not treated as a comment start', () => {
  const state: MaskState = { inBlockComment: false };
  const masked = maskLine('source = "http://example.com"; feature Foo;', state);
  assert.equal(masked.includes('feature Foo'), true);
  assert.equal(masked.includes('http://example.com'), false);
});

test('maskLine: block comment spanning multiple lines masks every line in between', () => {
  const state: MaskState = { inBlockComment: false };
  const first = maskLine('/* feature Foo', state);
  assert.equal(state.inBlockComment, true);
  assert.equal(first.includes('feature'), false);

  const middle = maskLine('endfeature still commented', state);
  assert.equal(state.inBlockComment, true);
  assert.equal(middle.trim(), '');

  const last = maskLine('still commented */ feature Bar;', state);
  assert.equal(state.inBlockComment, false);
  assert.equal(last.includes('feature Bar'), true);
});

test('maskLine: unterminated block comment on its own line masks the whole line', () => {
  const state: MaskState = { inBlockComment: false };
  const masked = maskLine('/* feature Foo', state);
  assert.equal(masked.trim(), '');
  assert.equal(state.inBlockComment, true);
});

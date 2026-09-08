/**
 * POSIX 1003.2 extended regular expressions, checked by hand.
 *
 * Pure string functions over a pattern: no document, no model, no `vscode`.
 * `sourceDiagnostics.ts` runs these over the text between a `` `r` `` tag and
 * the tag or string end that closes it.
 *
 * `RegExp` is deliberately not used. JavaScript's flavour and POSIX ERE
 * disagree in both directions: JS rejects a lone `{` that POSIX allows as a
 * literal, accepts `\d`/`\w`/lookahead/lazy quantifiers that POSIX has no
 * notion of, and reads `[[:alpha:]]` as a character class of `:`, `a`, `l`, …
 * rather than a POSIX class. Only the constructs both flavours agree are
 * malformed are reported here — an unbalanced `(`/`)`, an unterminated bracket
 * expression, a dangling `\`, and a repetition operator with nothing before it
 * to repeat. Everything else produces no diagnostic on purpose.
 */

/** One malformed construct, reported at a single character: every problem this
 * module finds is an operator or a delimiter, so the caller renders a one-column
 * span at `index` rather than being handed a width to add to it. */
export interface RegexProblem {
  message: string;
  /** Index into the pattern. */
  index: number;
}

/** Syntax errors in a POSIX ERE; see the module comment for what is left alone. */
export function checkExtendedRegex(pattern: string): RegexProblem[] {
  const problems: RegexProblem[] = [];
  const open: number[] = [];
  /** True when the previous position produced something a `*`/`+`/`?` can repeat. */
  let repeatable = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') {
      if (i + 1 >= pattern.length) {
        problems.push({ message: 'Regular expression ends with an incomplete escape sequence.', index: i });
        break;
      }
      i += 2; repeatable = true; continue;
    }
    if (ch === '[') {
      const end = bracketEnd(pattern, i);
      if (end === -1) {
        problems.push({ message: "Unterminated bracket expression: missing ']'.", index: i });
        break;
      }
      i = end; repeatable = true; continue;
    }
    if (ch === '(') { open.push(i); i++; repeatable = false; continue; }
    if (ch === ')') {
      if (!open.length) {
        problems.push({ message: "Unmatched ')' in regular expression.", index: i });
      } else open.pop();
      i++; repeatable = true; continue;
    }
    if (ch === '|') { i++; repeatable = false; continue; }
    if (ch === '*' || ch === '+' || ch === '?') {
      if (!repeatable) {
        problems.push({ message: `'${ch}' has nothing to repeat in this regular expression.`, index: i });
      }
      i++; continue;
    }
    if (ch === '^') { i++; continue; }
    i++; repeatable = true;
  }
  for (const index of open) {
    problems.push({ message: "Unclosed '(' in regular expression: missing ')'.", index });
  }
  return problems;
}

/** Index just past the `]` closing the bracket expression opened at `start`, or
 * -1. POSIX puts a leading `]` (after an optional `^`) in the set literally, and
 * `[: :]`, `[= =]` and `[. .]` run to their own closer. */
function bracketEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;
  while (i < pattern.length) {
    if (pattern[i] === '[' && ':=.'.includes(pattern[i + 1] ?? '')) {
      const close = pattern.indexOf(`${pattern[i + 1]}]`, i + 2);
      if (close === -1) return -1;
      i = close + 2; continue;
    }
    if (pattern[i] === ']') return i + 1;
    i++;
  }
  return -1;
}

/**
 * Index of the first `.` a regular expression leaves unescaped, or undefined.
 *
 * The chapter calls this out by name: `.` is the hierarchy separator in the
 * design and "match any character" in the regular expression, so
 * `` `r`u1.u2 `` also matches `u1Xu2`. A `.` inside a bracket expression is
 * already literal and is skipped.
 *
 * Only the first is returned: a hierarchy path is all dots, and one warning per
 * expression is the point — a message on each would bury it.
 */
export function firstUnescapedDot(pattern: string): number | undefined {
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '\\') { i += 2; continue; }
    if (pattern[i] === '[') {
      const end = bracketEnd(pattern, i);
      if (end === -1) return undefined;
      i = end; continue;
    }
    if (pattern[i] === '.') return i;
    i++;
  }
  return undefined;
}

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import { metricIn, scopeOf } from './declarations';
import { Report, reporter } from './diagnostics';
import { checkExtendedRegex, firstUnescapedDot } from './extendedRegex';
import { TABLE_4_METRICS } from './keywords';
import { PlanDocument, PlanNode, nameToken, runText } from './planModel';
import { interpolates } from './resolver';
import { SourceExpression, isTerminated, parseSourceExpression, sourceLiterals } from './sourceExpressions';

/** Fewer than this many sibling sources is not worth a wildcard: the chapter's
 * own advice is about cutting the number of strings the tool match-tests, and
 * two strings barely move that number. */
const WILDCARD_HINT_THRESHOLD = 3;

/**
 * WS4's pass: the contents of `source = "..."` strings.
 *
 * Runs from `parser.ts` after `metricDiagnostics`. Exempts what every other
 * pass exempts, through the same `model.checkable` predicate. Beyond that,
 * anything the chapter does not describe precisely enough to model produces no
 * diagnostic at all: an unrecognised keyword-looking prefix, a mask value's
 * width, a regular expression whose text an interpolation could complete.
 */
export function sourceDiagnostics(model: PlanDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = reporter(diagnostics);
  for (const measure of model.nodes) {
    if (measure.kind !== 'measure' || !model.checkable(measure)) continue;
    const expressions: SourceExpression[] = [];
    // Table 4's inputs are the same for every literal in one measure, and the
    // keyword check early-returns on a keywordless string, so they are resolved
    // at most once per measure and only when a keyword actually turns up.
    let table4: Table4Context | undefined;
    for (const { statement, token } of sourceLiterals(model, measure)) {
      // The same exemption again, on the statement rather than the measure: the
      // pass used to test `incomplete` here and leave `insideModifier` to the
      // loop above, which is one asymmetry too many for WS7 to have to spot.
      // An unterminated literal already carries a syntax error of its own and
      // its contents run to the end of the line, so nothing is said about them.
      if (!model.checkable(statement) || !isTerminated(token)) continue;
      const expression = parseSourceExpression(model.source, token);
      expressions.push(expression);
      if (expression.keyword) {
        checkKeyword(table4 ??= table4ContextOf(model, measure), expression, report);
      }
      checkInterpolations(model, statement, expression, report);
      checkRegex(expression, report);
    }
    checkWildcardOpportunity(measure, expressions, report);
  }
  return diagnostics;
}

/** What Table 4 is asked about, per measure rather than per source literal. */
interface Table4Context { names: string[]; builtinOnly: boolean }

function table4ContextOf(model: PlanDocument, measure: PlanNode & { kind: 'measure' }): Table4Context {
  const scope = scopeOf(model, measure);
  const names = measure.metrics.map(runText).filter(Boolean);
  // A plan that declares its own `Line` owns the name (see declarations.ts), and
  // what its source format is then is the plan's business, not Table 4's.
  return { names, builtinOnly: names.every(name => TABLE_4_METRICS.has(name) && metricIn(scope, name)?.builtin) };
}

/**
 * Table 4's compatibility check.
 *
 * Only a measure whose every metric is a built-in the table describes is held to
 * it: a declared metric, `test`, or a sub-metric like `Group.bin_count` has no
 * documented source format, so nothing is said about the keyword in front of it.
 * One matching metric is enough, since a measure's sources serve all of its
 * metrics at once.
 *
 * A warning rather than an error: the table's column is headed "Available
 * Metrics" and reads as guidance for choosing a keyword, not as a rule the tool
 * is stated to enforce.
 */
function checkKeyword(table4: Table4Context, expression: SourceExpression, report: Report): void {
  const keyword = expression.keyword!;
  const { names, builtinOnly } = table4;
  if (!names.length || !builtinOnly) return;
  if (names.some(name => keyword.info.metrics.includes(name))) return;
  report(keyword.wordsSpan.range, 'incompatible-source-keyword',
    `Source keyword '${keyword.info.name}:' applies to `
    + `${keyword.info.metrics.filter(m => m !== 'SnpsAvg').join(', ')}, `
    + `but this measure annotates ${names.join(', ')}.`, DiagnosticSeverity.Warning);
}

/**
 * `${name}` must name something a source string can substitute — which is
 * `resolver.ts`'s `interpolates`, the one rule hover and completion also ask.
 * Attributes and annotations, plus the reserved `objpath`; a metric has a goal
 * rather than a value, so `${Line}` names nothing that can be substituted.
 */
function checkInterpolations(model: PlanDocument, statement: PlanNode,
                             expression: SourceExpression, report: Report): void {
  if (!expression.interpolations.length) return;
  const scope = scopeOf(model, statement);
  // A modifier file with no plan of its own names another plan's declarations.
  const resolvable = !!model.enclosingOf(statement, 'plan');
  for (const interpolation of expression.interpolations) {
    if (!interpolation.terminated) {
      report(interpolation.range, 'invalid-interpolation', "Unterminated '${': missing '}'.");
      continue;
    }
    const name = interpolation.name;
    // An empty or non-identifier body is a form the chapter never shows; it is
    // left alone rather than guessed at.
    if (!resolvable || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) continue;
    if (interpolates(scope, name)) continue;
    report(interpolation.nameSpan.range, 'unknown-interpolation',
      `'${name}' is not an attribute or annotation declared in this plan, and is not the reserved 'objpath'.`);
  }
}

/** POSIX ERE syntax after a `` `r` `` tag, and the dot the chapter warns about. */
function checkRegex(expression: SourceExpression, report: Report): void {
  const at = (index: number) => expression.spanAt(index, index + 1).range;
  for (const run of expression.regexRuns) {
    // An interpolated run is only half written here: the substituted value could
    // open or close anything, so neither check can be trusted on it.
    if (run.interpolated || !run.text) continue;
    const problems = checkExtendedRegex(run.text);
    for (const problem of problems) {
      report(at(run.textStart + problem.index), 'invalid-source-regex', problem.message);
    }
    if (problems.length) continue;
    // One warning per run: a hierarchy path is all dots, and a message on each
    // would bury the point.
    const dot = firstUnescapedDot(run.text);
    if (dot === undefined) continue;
    report(at(run.textStart + dot), 'unescaped-regex-dot',
      "'.' matches any character inside a regular expression, not just the hierarchy separator. "
      + "Escape it as '\\.', or move the `r` tag to the right of it.", DiagnosticSeverity.Warning);
  }
}

/**
 * The chapter's "Performance Tip": sources that differ only in their last
 * hierarchy segment are the case a single wildcard covers.
 *
 * Restricted to plain wildcard-mode strings with no tags and no interpolation,
 * where the segments being replaced carry no wildcard of their own — anywhere
 * else, "the last segment" is not a thing this pass can point at confidently.
 */
function checkWildcardOpportunity(measure: PlanNode & { kind: 'measure' },
                                  expressions: readonly SourceExpression[], report: Report): void {
  const groups = new Map<string, SourceExpression[]>();
  for (const expression of expressions) {
    if (expression.regexRuns.length || expression.hasRemoval || expression.interpolations.length) continue;
    const dot = expression.text.lastIndexOf('.');
    if (dot <= 0 || dot === expression.text.length - 1) continue;
    const last = expression.text.slice(dot + 1);
    if (/[*?]/.test(last)) continue;
    const prefix = expression.text.slice(0, dot + 1);
    groups.get(prefix)?.push(expression) ?? groups.set(prefix, [expression]);
  }
  const name = nameToken(measure)?.text;
  for (const [prefix, group] of groups) {
    if (group.length < WILDCARD_HINT_THRESHOLD) continue;
    report(group[0].literal.range, 'wildcard-source-opportunity',
      `${group.length} source strings ${name ? `in measure '${name}' ` : ''}differ only in their last segment. `
      + `One pattern, "${prefix}*", would match all of them.`, DiagnosticSeverity.Hint);
  }
}

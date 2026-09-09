/**
 * WS7's diagnostics, in two passes that run on two different clocks.
 *
 * `modifierDiagnostics(model)` is document-local — date spelling, branch
 * ordering, filter expressions — and runs from `parser.ts` beside WS1–WS4.
 * `modifierWorkspaceDiagnostics(model, index, …)` needs the instantiated
 * hierarchy to say whether a path resolves, and the calendar to say whether a
 * branch has expired, so it runs from `workspaceDiagnostics` instead: the same
 * reason `unknown-plan` lives there, plus one more — a check whose answer
 * changes at midnight must not be baked into a parse the editor caches.
 *
 * Every check here is deliberately narrow. A modifier file names a plan set the
 * workspace may not hold, and the failure mode that matters is a false positive
 * on a correct file, so a path that cannot be resolved with confidence produces
 * a warning at most and an unmodelled expression produces nothing.
 */
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import { Scope, lookup } from './declarations';
import { Report, reporter } from './diagnostics';
import { GoalNode, walkGoal } from './goals';
import { checkGoal } from './metricDiagnostics';
import { PlanDocument, PlanNode, runText, valueSpan } from './planModel';
import {
  FilterStatement,
  ModifierDate,
  UntilBlock,
  dateValueOf,
  filterIdentifier,
  filterOperandType,
  filterScope,
  hasWildcard,
  isDateProblem,
  modifierStatements,
  resolveOverride,
  untilBlocks,
} from './modifiers';
import { Span } from './tokenizer';
import { WorkspaceIndex } from './workspace';
import { checkValue } from './values';

/** The operators the chapter lists for a filter expression. `!` is not among
 * them and is not reported either: the sentence introducing the list says "you
 * can *also* include the following operators", which reads as an addition to
 * what the examples show rather than as a closed set, and a `!` the tool
 * accepts must not be called an error here. */
const FILTER_OPERATORS = new Set(['>', '<', '>=', '<=', '==', '!=', '+', '-', '*', '/', '||', '&&', '!']);

export function modifierDiagnostics(model: PlanDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = reporter(diagnostics);
  for (const block of untilBlocks(model)) checkUntil(block, report);
  const { overrides, filters } = modifierStatements(model);
  for (const statement of overrides) {
    // Table 5's wildcards "specify scope names such as plans and features, but
    // not attribute names", and the statement's whole point is the one name it
    // sets, so this is an error rather than a hint.
    if (hasWildcard(statement.name)) {
      report(statement.nameRun.range, 'wildcard-in-name',
        `'${statement.name}' is the name an override sets: a wildcard may only stand for a plan or feature name.`);
    }
  }
  for (const filter of filters) checkFilter(model, filter, report);
  return diagnostics;
}

/**
 * A date branch's spelling, and the order the branches are written in.
 *
 * Order matters because an `until` block is a chain of "before this date"
 * tests read top to bottom: a branch dated no later than one above it can never
 * be reached, and an `elseuntil` after the `else` can never be reached either.
 * Both are the author saying one thing and the tool doing another, so both are
 * reported — the unreachable date as a warning, since the file still means
 * something, and the misplaced branch as an error, since the BNF puts `else`
 * last.
 */
function checkUntil(block: UntilBlock, report: Report): void {
  let previous: ModifierDate | undefined;
  let seenElse = false;
  for (const branch of block.branches) {
    const range = branch.node.header.range;
    if (branch.kind === 'else') {
      if (seenElse) report(range, 'invalid-branch-order', "An 'until' block takes only one 'else' branch.");
      seenElse = true;
      continue;
    }
    if (seenElse) {
      report(range, 'invalid-branch-order',
        `'${branch.kind}' cannot follow 'else': the 'else' branch is the last one.`);
    }
    const date = branch.date;
    if (!date) continue;
    const where = branch.node.date?.tokens.length ? branch.node.date.range : range;
    if (isDateProblem(date)) {
      report(where, 'invalid-date', date === 'format'
        ? `'${runText(branch.node.date)}' is not a date: an until branch takes MM-DD-YYYY.`
        : `'${runText(branch.node.date)}' is not a calendar date. An until branch is read as MM-DD-YYYY, `
          + 'which the chapter fixes with its own `elseuntil 04-30-2014;` example.');
      continue;
    }
    if (previous && date.value <= previous.value) {
      report(where, 'unreachable-branch',
        `This branch is never reached: an earlier branch already covers every date up to ${text(previous)}.`,
        DiagnosticSeverity.Warning);
    }
    previous = date;
  }
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');
const text = (date: ModifierDate): string => `${pad(date.month, 2)}-${pad(date.day, 2)}-${pad(date.year, 4)}`;

/**
 * One `keep`/`remove feature where …` statement.
 *
 * Names are checked only when the filter block sits inside a plan. In a
 * modifier file it names the attributes of whatever plan the file modifies, and
 * nothing in the file says which — the same reason `navigation.ts` refuses to
 * rename through a filter expression.
 */
function checkFilter(model: PlanDocument, filter: FilterStatement, report: Report): void {
  const { problems, expression } = filter.goal;
  for (const problem of problems) report(problem.span.range, 'invalid-filter-expression', problem.message);
  if (problems.length) return;
  const scope = filterScope(model, filter.node);
  for (const node of walkGoal(expression)) {
    switch (node.kind) {
      case 'call':
        // The chapter lists `match (owner, "bo*")` under "Verification Planner
        // does not support the following expressions".
        report(node.span.range, 'unsupported-expression',
          `'${node.name}(...)' is not supported in a filter expression.`);
        break;
      case 'inside':
        report(node.span.range, 'unsupported-expression',
          "'inside {...}' is not supported in a filter expression.");
        break;
      case 'binary':
        if (!FILTER_OPERATORS.has(node.op)) {
          report(node.span.range, 'unsupported-expression',
            `'${node.op}' is not one of the operators a filter expression may use.`);
          break;
        }
        checkOperands(node, scope, report);
        break;
      case 'name':
        if (!scope) break;
        if (filterIdentifier(scope, node.text)) break;
        report(node.span.range, 'unknown-filter-identifier',
          lookup(scope, node.text)
            ? `'${node.text}' is a metric: a filter expression reads attributes and annotations, `
              + 'and any other identifier is not interpreted.'
            : `'${node.text}' is not an attribute or annotation declared in this plan, so the filter `
              + 'expression does not interpret it.',
          DiagnosticSeverity.Warning);
        break;
    }
  }
}

/** Comparing a string against a number, or doing arithmetic on one. Only the
 * operand types `values.ts` classifies confidently take part, so an expression
 * over anything else is silent rather than guessed at. */
function checkOperands(node: GoalNode & { kind: 'binary' }, scope: Scope | undefined, report: Report): void {
  const left = filterOperandType(node.left, scope);
  const right = filterOperandType(node.right, scope);
  if (!left || !right) return;
  if (['+', '-', '*', '/'].includes(node.op)) {
    for (const operand of [node.left, node.right]) {
      if (filterOperandType(operand, scope) === 'string') {
        report(operand.span.range, 'invalid-filter-operand',
          `Numerical operator '${node.op}' cannot be applied to a string value.`);
      }
    }
    return;
  }
  if (left === right) return;
  report(node.span.range, 'invalid-filter-operand',
    `'${node.op}' compares a ${left} with a ${right}.`);
}

// ---------------------------------------------------------------------------
// The half that needs the workspace and the calendar
// ---------------------------------------------------------------------------

export interface ModifierWorkspaceOptions {
  /** Today. Injected rather than read here, so a test pins the calendar. */
  /** The day to read `until` branches against. Required: a check whose answer
   * changes at midnight must not depend on core reading the wall clock. */
  now: Date;
}

/**
 * Override paths against the instantiated hierarchy, and branches whose date
 * has passed.
 *
 * Everything reported here is a **warning**. A modifier file is handed to the
 * tool alongside the plan files it modifies, and the editor only approximates
 * that set with the workspace: a path that resolves to nothing may well be
 * correct against a plan set this window has never opened. An error there would
 * be exactly the false positive this workstream is most at risk of.
 */
export function modifierWorkspaceDiagnostics(model: PlanDocument, index: WorkspaceIndex,
                                             options: ModifierWorkspaceOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = reporter(diagnostics);
  const today = dateValueOf(options.now);
  for (const block of untilBlocks(model)) {
    for (const branch of block.branches) {
      const date = branch.date;
      if (!date || isDateProblem(date) || date.value >= today) continue;
      report(branch.node.date?.range ?? branch.node.header.range, 'expired-until-branch',
        `The ${text(date)} branch no longer applies: that date has passed.`, DiagnosticSeverity.Warning);
    }
  }
  // Nothing has been instantiated yet — an index still filling up, or a
  // workspace of modifier files alone. Every path would read as unresolved.
  if (!index.instances().length) return diagnostics;
  for (const statement of modifierStatements(model).overrides) {
    if (hasWildcard(statement.name)) continue; // Already reported, document-locally.
    const resolved = resolveOverride(index, statement);
    const where: Span = statement.path ?? statement.node.target;
    const problem = resolved.problem;
    if (problem?.kind === 'unknown-plan') {
      report(where.range, 'unresolved-override-path',
        `Unknown plan '${problem.plan}': no .hvp file in this workspace declares it, so this path `
        + 'reaches nothing.', DiagnosticSeverity.Warning);
      continue;
    }
    if (problem?.kind === 'unresolved') {
      report(where.range, 'unresolved-override-path',
        `'${[...statement.scope, statement.name].join('.')}' matches no plan or feature in the instantiated `
        + 'hierarchy.', DiagnosticSeverity.Warning);
      continue;
    }
    if (problem?.kind === 'unknown-target') {
      report(statement.nameRun.range, 'unresolved-override-path',
        `'${statement.name}' is not an attribute, annotation or metric of `
        + `${problem.plans.length === 1 ? `plan '${problem.plans[0]}'` : `plans ${problem.plans.join(', ')}`}.`,
        DiagnosticSeverity.Warning);
      continue;
    }
    if (resolved.declaration) checkOverrideValue(model, statement, resolved.declaration, report);
  }
  return diagnostics;
}

/**
 * The value an override assigns, typed against the declaration its path found.
 *
 * A metric override carries a goal expression rather than a literal, so it goes
 * through the very same check a `goal = …` statement does — one grammar, one
 * set of messages, whether the expression was written in the plan or in a
 * modifier file. This is the check the old blanket exemption made impossible.
 */
function checkOverrideValue(model: PlanDocument, statement: { node: PlanNode & { kind: 'assignment' } },
                            declaration: ReturnType<typeof lookup> & object, report: Report): void {
  const node = statement.node;
  if (declaration.kind === 'metric') {
    checkGoal(model, node.value, node.header, declaration, report);
    return;
  }
  const message = checkValue(declaration, node.value);
  if (message) report(valueSpan(node.value, node.header).range, 'invalid-value', message);
}

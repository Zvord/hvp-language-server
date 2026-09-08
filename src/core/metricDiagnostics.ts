import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import { Declaration, Scope, declarationFromNode, metricIn, scopeOf } from './declarations';
import { Report, reporter } from './diagnostics';
import { ARITHMETIC, COMPARISON, GoalNode, GoalType, LOGICAL, parseGoal, walkGoal } from './goals';
import { AGGREGATOR_NAMES, METRIC_TYPES, METRIC_TYPE_AGGREGATORS } from './keywords';
import { PlanDocument, PlanNode, TokenRun, runText, valueSpan } from './planModel';
import { Span } from './tokenizer';
import { goalIdentifierType } from './metrics';

const AGGREGATORS = new Set(AGGREGATOR_NAMES.map(a => a.name));

/** Both a `measure` reference and an `aggregate` member are held to the same
 * rule, so they say so in the same words. */
const reportUnknownMetric = (report: Report, reference: TokenRun, name: string): void =>
  report(reference.range, 'unknown-metric', `'${name}' is not a metric declared in this plan or built in.`);

/** `ratio` and `percent` hold the same coverage figure in different shapes, and
 * the documentation lets a ratio aggregate take a percent sub-metric. */
const sameFamily = (a: string, b: string): boolean =>
  a === b || (['ratio', 'percent'].includes(a) && ['ratio', 'percent'].includes(b));

/**
 * Metric declarations, measure references and goal expressions.
 *
 * Runs after the structural and value passes, so it can assume names resolve
 * through the same per-plan table. Modifier blocks address the instantiated
 * hierarchy and are left to WS7; a statement the parser recovered from already
 * carries a syntax diagnostic and is not checked again.
 */
export function metricDiagnostics(model: PlanDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = reporter(diagnostics);
  for (const node of model.nodes) {
    if (node.incomplete || model.insideModifier(node)) continue;
    const scope = scopeOf(model, node);
    if (node.kind === 'metric' && node.name) checkDeclaration(model, node, scope, report);
    else if (node.kind === 'measure') checkMeasure(node, scope, report);
    else if (node.kind === 'assignment') {
      const metric = metricIn(scope, runText(node.target));
      // A goal override reuses the metric's own expression grammar; anything
      // else is an attribute or annotation assignment, already typed by WS2.
      if (metric) checkGoal(model, node.value, node.header, metric, report);
    }
  }
  return diagnostics;
}

function checkDeclaration(model: PlanDocument, node: PlanNode & { kind: 'metric' }, scope: Scope, report: Report): void {
  const declaration = declarationFromNode(node);
  const type = declaration.type;
  if (!METRIC_TYPES.includes(type)) {
    report(node.type.name?.range ?? node.header.range, 'invalid-metric-type',
      `'${type}' is not a metric type: expected one of ${METRIC_TYPES.join(', ')}.`);
  }
  for (const statement of node.children) {
    // A statement the parser recovered from already carries a syntax
    // diagnostic; its value run is unreliable, so nothing is stacked on it.
    if (statement.incomplete) continue;
    if (statement.kind === 'aggregator') checkAggregator(statement.value, statement.header, type, report);
    if (statement.kind === 'goal') checkGoal(model, statement.value, statement.header, declaration, report);
  }
  if (type === 'aggregate') checkAggregate(node, scope, report);
  for (const member of node.type.members) {
    if (member.weight && !/^[-+]?[0-9]+(\.[0-9]+)?$/.test(runText(member.weight))) {
      report(member.weight.range, 'invalid-weight',
        `Weight of '${runText(member.name)}' must be a number, not '${runText(member.weight)}'.`);
    }
  }
}

function checkAggregator(value: TokenRun, header: Span, type: string, report: Report): void {
  const name = runText(value);
  const range = valueSpan(value, header).range;
  if (!AGGREGATORS.has(name)) {
    report(range, 'invalid-aggregator', `'${name}' is not an aggregator: expected one of ${[...AGGREGATORS].join(', ')}.`);
    return;
  }
  const allowed = METRIC_TYPE_AGGREGATORS[type];
  if (!allowed) return; // The type is already reported as invalid; say nothing more about it.
  if (!allowed.length) {
    report(range, 'invalid-aggregator',
      `An ${type} metric takes no aggregator: each sub-metric aggregates with its own.`);
  } else if (!allowed.includes(name)) {
    report(range, 'invalid-aggregator',
      `The '${name}' aggregator does not apply to a ${type} metric: expected one of ${allowed.join(', ')}.`);
  }
}

/** Sub-metrics of an aggregate must be known and must agree on type and
 * aggregator, so the first resolvable member sets what the rest are held to. */
function checkAggregate(node: PlanNode & { kind: 'metric' }, scope: Scope, report: Report): void {
  let first: Declaration | undefined;
  for (const member of node.type.members) {
    const name = runText(member.name);
    const declaration = metricIn(scope, name);
    if (!declaration) {
      reportUnknownMetric(report, member.name, name);
      continue;
    }
    if (!first) { first = declaration; continue; }
    const aggregatorOf = (d: Declaration) => d.metric?.aggregator ?? '';
    if (!sameFamily(declaration.type, first.type)) {
      report(member.name.range, 'incompatible-aggregate-member',
        `Sub-metric '${name}' is ${declaration.type}, but '${first.name}' is ${first.type}: an aggregate needs one type.`);
    } else if (aggregatorOf(declaration) !== aggregatorOf(first)) {
      report(member.name.range, 'incompatible-aggregate-member',
        `Sub-metric '${name}' aggregates with '${aggregatorOf(declaration) || 'no aggregator'}', but '${first.name}' uses '${aggregatorOf(first) || 'no aggregator'}'.`);
    }
  }
}

/** Every metric a measure annotates must be declared in the same plan or be
 * built in. The missing-source warning stays in the parser, where it has been
 * since before this workstream. */
function checkMeasure(node: PlanNode & { kind: 'measure' }, scope: Scope, report: Report): void {
  for (const reference of node.metrics) {
    const name = runText(reference);
    if (!name || metricIn(scope, name)) continue;
    reportUnknownMetric(report, reference, name);
  }
}

/** Reports on a goal expression, whether it came from `goal = ...` inside a
 * metric or from a feature-level override of that metric. */
function checkGoal(model: PlanDocument, value: TokenRun, header: Span, metric: Declaration, report: Report): void {
  const { expression, problems } = parseGoal(model.source, value.tokens, valueSpan(value, header));
  for (const problem of problems) report(problem.span.range, 'invalid-goal-expression', problem.message);
  if (problems.length) return;

  const typeOf = (node: GoalNode): GoalType => {
    switch (node.kind) {
      case 'literal': return node.type;
      case 'name': return goalIdentifierType(metric, node.text) ?? 'unknown';
      case 'unary': return node.op === '!' ? 'boolean' : typeOf(node.operand);
      case 'binary': return COMPARISON.includes(node.op) || LOGICAL.includes(node.op) ? 'boolean' : 'real';
      default: return 'unknown';
    }
  };
  /** Only arithmetic and comparison constrain their operands; the logical
   * operators take whatever the comparisons below them produced. */
  const checkOperand = (op: string, operand: GoalNode): void => {
    const type = typeOf(operand);
    if (type !== 'string' && type !== 'ratio') return;
    if (ARITHMETIC.includes(op)) {
      if (type === 'string') {
        report(operand.span.range, 'invalid-goal-operand',
          `Numerical operator '${op}' cannot be applied to a string value.`);
      } else {
        // The same chapter says a ratio metric is converted to a percentage
        // before the goal is evaluated, so this is a warning, not an error.
        report(operand.span.range, 'invalid-goal-operand',
          `Numerical operator '${op}' cannot be applied to the ratio value `
          + `'${model.source.text.slice(operand.span.start, operand.span.end)}'.`,
          DiagnosticSeverity.Warning);
      }
    } else if (type === 'string' && COMPARISON.includes(op)) {
      report(operand.span.range, 'invalid-goal-operand', `Comparison operator '${op}' cannot compare string values.`);
    }
  };

  for (const node of walkGoal(expression)) {
    switch (node.kind) {
      case 'name':
        if (goalIdentifierType(metric, node.text) !== undefined) break;
        report(node.span.range, 'unknown-goal-identifier',
          `'${node.text}' is not part of metric '${metric.name}': a goal expression may name `
          + (metric.members.length
            ? `'${metric.name}', one of ${metric.members.join(', ')}, or '${metric.name}.<member>'.`
            : `'${metric.name}'.`),
          DiagnosticSeverity.Warning);
        break;
      case 'call':
        report(node.span.range, 'unsupported-expression', `'${node.name}(...)' is not supported in a goal expression.`);
        break;
      case 'inside':
        report(node.span.range, 'unsupported-expression', "'inside {...}' is not supported in a goal expression.");
        break;
      case 'binary':
        checkOperand(node.op, node.left);
        checkOperand(node.op, node.right);
        break;
    }
  }
}

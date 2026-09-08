// WS3: metric declarations, goal expressions, measure references and the
// metric hover.
import assert from 'node:assert/strict';
import test from 'node:test';
import { provideCompletionItems } from '../src/core/completion';
import { scopeAt } from '../src/core/declarations';
import { parseGoal } from '../src/core/goals';
import { provideHover } from '../src/core/hover';
import { resolveGoal } from '../src/core/metrics';
import { parseDocument } from '../src/core/parser';
import { PlanDocument, PlanNode } from '../src/core/planModel';

const codes = (text: string) => parseDocument(text).diagnostics.filter(d => d.code).map(d => d.code);
const messages = (text: string) => parseDocument(text).diagnostics.filter(d => d.code).map(d => d.message);
const featureNamed = (model: PlanDocument, name: string): PlanNode =>
  model.nodes.find(n => n.kind === 'feature' && 'name' in n && n.name?.text === name)!;
const hoverAt = (model: PlanDocument, text: string, needle: string, uri?: string) =>
  provideHover(model, model.source.positionAt(text.indexOf(needle)), uri);
const hoverText = (model: PlanDocument, text: string, needle: string, uri?: string) =>
  (hoverAt(model, text, needle, uri)!.contents as { value: string }).value;
const boosted = (text: string, at = text.length) => {
  const model = parseDocument(text);
  return provideCompletionItems(model, model.source.positionAt(at))
    .filter(i => i.sortText?.startsWith('0_')).map(i => i.label);
};

const PLAN = `plan cpu_plan;
metric aggregate {Line(weight=1.0), Cond(weight=2.0)} MyAgg;
goal = MyAgg > 0.1;
endmetric
metric enum {created, reviewed} spec_status;
aggregator = sum;
goal = spec_status >= 10;
endmetric
feature cpu;
spec_status = spec_status >= 20;
feature core;
measure Line, MyAgg cov;
source = "x";
endmeasure
endfeature
endfeature
endplan`;

test('built-in metrics carry their documented type, aggregator and members', () => {
  const scope = scopeAt(parseDocument('plan p; endplan'), 3);
  const shape = (name: string) => {
    const declaration = scope.declarations.get(name)!;
    return [declaration.type, declaration.metric!.aggregator, declaration.members];
  };
  assert.deepEqual(shape('Line'), ['ratio', 'average', []]);
  assert.deepEqual(shape('Group'), ['percent', 'average', []]);
  assert.deepEqual(shape('Group.grp_count'), ['integer', 'sum', []]);
  assert.deepEqual(shape('test'), ['enum', 'sum', ['pass', 'fail', 'warn', 'unknown', 'assert']]);
  assert.deepEqual(shape('AssertResult'), ['enum', 'sum', ['successes', 'failures']]);
  assert.deepEqual(shape('SnpsAvg'), ['aggregate', '', ['Line', 'Cond', 'FSM', 'Toggle', 'Branch', 'Assert', 'Group']]);
  // Derived test metrics: counts per enum member, then the percentages.
  assert.deepEqual(shape('test.fail'), ['integer', 'sum', []]);
  assert.deepEqual(shape('test.percent.pass'), ['percent', '', []]);
  assert.deepEqual(shape('test.completion'), ['percent', '', []]);
  // test.expected stays an attribute, not a metric.
  assert.equal(scope.declarations.get('test.expected')?.kind, 'attribute');
});

test('a metric declaration states a type its aggregator applies to', () => {
  assert.deepEqual(codes('plan p; metric ratio r; aggregator = average; goal = r >= 80%; endmetric endplan'), []);
  assert.deepEqual(codes('plan p; metric enum {a, b} e; aggregator = uniquesum; endmetric endplan'), []);
  assert.deepEqual(codes('plan p; metric ratio r; aggregator = sum; endmetric endplan'), ['invalid-aggregator']);
  assert.deepEqual(codes('plan p; metric enum {a} e; aggregator = average; endmetric endplan'), ['invalid-aggregator']);
  assert.deepEqual(codes('plan p; metric integer n; aggregator = mode; endmetric endplan'), ['invalid-aggregator']);
  // An aggregate uses each sub-metric's own aggregator, so it declares none.
  assert.match(messages('plan p; metric aggregate {Line, Cond} A; aggregator = average; endmetric endplan')[0],
    /aggregate metric takes no aggregator/);
  assert.deepEqual(codes('plan p; metric string s; endmetric endplan'), ['invalid-metric-type']);
});

test('aggregate members must be known metrics that agree on type and aggregator', () => {
  assert.deepEqual(codes('plan p; metric aggregate {Line(weight=1.0), Cond(weight=2.0)} A; goal = A > 0.1; endmetric endplan'), []);
  // The documented exception: a ratio aggregate may take a percent sub-metric.
  assert.deepEqual(codes('plan p; metric aggregate {Line, Group} A; endmetric endplan'), []);
  assert.deepEqual(codes('plan p; metric aggregate {Line, Nope} A; endmetric endplan'), ['unknown-metric']);
  assert.deepEqual(codes('plan p; metric aggregate {Line, Group.grp_count} A; endmetric endplan'), ['incompatible-aggregate-member']);
  const aggregators = 'plan p; metric integer a; aggregator = sum; endmetric metric integer b; aggregator = max; endmetric ';
  assert.match(messages(`${aggregators}metric aggregate {a, b} A; endmetric endplan`)[0],
    /Sub-metric 'b' aggregates with 'max', but 'a' uses 'sum'/);
  assert.deepEqual(codes('plan p; metric aggregate {Line(weight=1.0), Cond(weight=x)} A; endmetric endplan'), ['invalid-weight']);
  // A metric declared in the plan is as good a sub-metric as a built-in.
  assert.deepEqual(codes('plan p; metric ratio r; aggregator = average; endmetric metric aggregate {Line, r} A; endmetric endplan'), []);
});

test('goal expressions follow the documented precedence', () => {
  const model = parseDocument('plan p; endplan');
  const parse = (text: string) => {
    const { tokens, source } = parseDocument(text);
    return parseGoal(source, tokens.filter(t => t.kind !== 'comment'), source.span(0, text.length));
  };
  const shape = (node: ReturnType<typeof parse>['expression']): string =>
    node.kind === 'binary' ? `(${shape(node.left)} ${node.op} ${shape(node.right)})`
      : node.kind === 'unary' ? `(${node.op} ${shape(node.operand)})`
      : node.kind === 'name' || node.kind === 'literal' ? node.text : node.kind;
  assert.equal(shape(parse('a + b * c').expression), '(a + (b * c))');
  assert.equal(shape(parse('a > b + c && d').expression), '((a > (b + c)) && d)');
  assert.equal(shape(parse('a || b && c').expression), '(a || (b && c))');
  // Table 3 puts `!` below the comparisons, so it takes the whole comparison.
  assert.equal(shape(parse('! a == b').expression), '(! (a == b))');
  assert.equal(shape(parse('(a || b) && c').expression), '((a || b) && c)');
  assert.equal(shape(parse('-1 >= x').expression), '((- 1) >= x)');
  assert.deepEqual(parse('a > 1').problems, []);
  assert.equal(model.diagnostics.length, 0);
});

test('a goal expression may only name its own metric and that metric’s members', () => {
  const goal = (expression: string, metric = 'metric enum {pass, fail} t;\naggregator = sum;') =>
    codes(`plan p;\n${metric}\ngoal = ${expression};\nendmetric\nendplan`);
  assert.deepEqual(goal('t > 10 && t.fail == 0'), []);
  assert.deepEqual(goal('(pass + fail / t) > 80%'), []);
  assert.deepEqual(goal('t.missing == 0'), ['unknown-goal-identifier']);
  assert.deepEqual(goal('other > 1'), ['unknown-goal-identifier']);
  assert.match(messages('plan p;\nmetric integer n;\ngoal = other > 1;\nendmetric\nendplan')[0],
    /'other' is not part of metric 'n'/);
  // An aggregate's sub-metrics count as its members.
  assert.deepEqual(goal('A >= 90% && (Line > 0 || Cond > 0)', 'metric aggregate {Line, Cond} A;'), []);
});

test('unsupported forms and mistyped operands in a goal are reported', () => {
  const goal = (expression: string) => codes(`plan p; metric integer n; goal = ${expression}; endmetric endplan`);
  assert.deepEqual(goal('match(owner, "b*")'), ['unsupported-expression', 'unknown-goal-identifier']);
  assert.deepEqual(goal('n inside {1:10}'), ['unsupported-expression']);
  assert.deepEqual(goal('n > "x"'), ['invalid-goal-operand']);
  assert.deepEqual(goal('n + "x" > 1'), ['invalid-goal-operand']);
  assert.deepEqual(goal('n <= '), ['invalid-goal-expression']);
  assert.deepEqual(goal('n 5'), ['invalid-goal-expression']);
  // A ratio metric is converted to a percentage before the goal is evaluated,
  // so arithmetic on one is a warning rather than an error.
  const ratio = parseDocument('plan p; metric ratio r; aggregator = average; goal = r * 2 > 1; endmetric endplan');
  assert.deepEqual(ratio.diagnostics.filter(d => d.code).map(d => [d.code, d.severity]), [['invalid-goal-operand', 2]]);
  // A statement the parser recovered from carries no goal diagnostic on top.
  assert.deepEqual(codes('plan p; metric integer n; goal = (n <= 0; endmetric endplan'), []);
});

test('feature-level goal overrides are checked with the same parser', () => {
  assert.deepEqual(codes('plan p; feature f; Group = Group >= 0.8; test = test.fail <= 1; endfeature endplan')
    .filter(c => c !== 'unknown-assignment-target'), []);
  assert.deepEqual(codes('plan p; feature f; test.percent.pass = test.percent.pass > 60%; endfeature endplan'), []);
  assert.deepEqual(codes('plan p; feature f; Group = Bogus >= 0.8; endfeature endplan'), ['unknown-goal-identifier']);
  assert.deepEqual(codes('plan p; feature f; Line = match(Line, "x"); endfeature endplan'), ['unsupported-expression']);
  // test.expected is a built-in attribute, so its value is not a goal.
  assert.deepEqual(codes('plan p; feature f; test.expected = 100; endfeature endplan'), []);
  // Modifier blocks address the instantiated hierarchy; that is WS7's.
  assert.deepEqual(codes('plan p; override o; p.f.Line = nonsense inside {1}; endoverride endplan'), []);
});

test('a measure may only annotate metrics the plan declares or the tool builds in', () => {
  assert.deepEqual(codes('plan p; feature f; measure Line, test.percent.pass m; source = "x"; endmeasure endfeature endplan'), []);
  assert.deepEqual(codes('plan p; feature f; measure Line, Nope m; source = "x"; endmeasure endfeature endplan'), ['unknown-metric']);
  assert.deepEqual(codes('plan p; metric integer S; endmetric feature f; measure S m; source = "x"; endmeasure endfeature endplan'), []);
  // An attribute is not a metric, however well the name resolves.
  assert.deepEqual(codes('plan p; attribute integer a = 0; feature f; measure a m; source = "x"; endmeasure endfeature endplan'), ['unknown-metric']);
  // A metric declared in another plan is not declared in this one.
  assert.deepEqual(codes('plan b; feature g; measure S m; source = "x"; endmeasure endfeature endplan plan a; metric integer S; endmetric feature f; subplan b; endfeature endplan'), ['unknown-metric']);
});

test('the goal in force at a feature is the metric’s own until one overrides it', () => {
  const model = parseDocument(PLAN);
  const declaration = scopeAt(model, PLAN.indexOf('feature cpu')).declarations.get('spec_status')!;
  const at = (feature?: string) => {
    const goal = resolveGoal(model, feature ? featureNamed(model, feature) : model.plans[0], declaration);
    return [goal.text, goal.origin.kind === 'assignment' ? `${goal.origin.local ? 'in' : 'from'} ${goal.origin.scope}` : goal.origin.kind];
  };
  assert.deepEqual(at(), ['spec_status >= 10', 'default']);
  assert.deepEqual(at('cpu'), ['spec_status >= 20', 'in cpu']);
  // Like an attribute, an override applies to the features below it.
  assert.deepEqual(at('core'), ['spec_status >= 20', 'from cpu']);
  // The WS7 seam: a modifier override wins over both.
  assert.equal(resolveGoal(model, featureNamed(model, 'core'), declaration,
    { overrides: [{ name: 'spec_status', text: 'spec_status >= 30', label: 'override patch' }] }).text, 'spec_status >= 30');
});

test('hover on a metric shows its shape, aggregator and the goal in force', () => {
  const model = parseDocument(PLAN);
  const aggregate = hoverText(model, PLAN, 'MyAgg;', 'file:///t.hvp');
  assert.match(aggregate, /\*\*metric\*\* `aggregate \{Line\(weight=1\.0\), Cond\(weight=2\.0\)\} MyAgg`/);
  assert.match(aggregate, /\[declared in plan cpu_plan\]\(file:\/\/\/t\.hvp#L2,\d+\)/);
  assert.match(aggregate, /Goal: `MyAgg > 0\.1`/);
  // An aggregate declares no aggregator of its own.
  assert.doesNotMatch(aggregate, /aggregator/);
  assert.match(hoverText(model, PLAN, 'spec_status;'), /aggregator `sum`[\s\S]*Goal: `spec_status >= 10`/);
  // A measure's metric reference reads the goal in force in its feature.
  assert.match(hoverText(model, PLAN, 'MyAgg cov'), /\*\*metric\*\* `aggregate/);
  // A sub-metric of an aggregate is a metric name too.
  const member = hoverText(model, PLAN, 'Line(weight');
  assert.match(member, /\*\*metric\*\* `ratio Line`/);
  assert.match(member, /built-in · aggregator `average`/);
  assert.match(member, /No goal\./);
});

test('hover on a goal override names the override and the goal it establishes', () => {
  const model = parseDocument(PLAN);
  const override = hoverText(model, PLAN, 'spec_status = spec_status', 'file:///t.hvp');
  assert.match(override, /\*\*metric\*\* `enum \{created, reviewed\} spec_status`/);
  assert.match(override, /Goal: `spec_status >= 20` \(\[assigned in cpu\]\(file:\/\/\/t\.hvp#L10,1\)\)/);
  assert.match(override, /Feature-level goal override for `spec_status`\./);
});

test('completion offers metrics where a metric reference belongs', () => {
  const head = 'plan p; metric integer Score; endmetric feature f; ';
  assert.ok(boosted(`${head}measure `).includes('Score'));
  // The list continues after a comma, across a line break.
  assert.ok(boosted(`${head}measure Line,\n  `).includes('Score'));
  assert.ok(boosted('plan p; metric integer Score; endmetric metric aggregate {Line, ').includes('Score'));
  // Past the metric list the measure's own name is being typed.
  assert.ok(!boosted(`${head}measure Line `).includes('Score'));
  assert.ok(!boosted(`${head}`).includes('Score'));
  // Members are offered qualified, because the replacement range covers the
  // dotted prefix the user has already typed.
  const members = (text: string) => boosted(text).filter(label => label.startsWith('test.'));
  assert.deepEqual(members(`${head}measure test.`),
    ['test.pass', 'test.fail', 'test.warn', 'test.unknown', 'test.assert', 'test.completion',
      'test.percent.pass', 'test.percent.fail', 'test.percent.warn', 'test.percent.unknown', 'test.percent.assert']);
  const declared = 'plan p; metric enum {created, reviewed} st; aggregator = sum; endmetric feature f; st = st.';
  assert.deepEqual(boosted(declared).filter(label => label.startsWith('st.')), ['st.created', 'st.reviewed']);
});

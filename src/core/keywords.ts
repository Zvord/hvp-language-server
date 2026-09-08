/**
 * Source-of-truth keyword/attribute/metric data for completion and snippets.
 * `tools/gen-grammars.ts` generates the TextMate/sublime-syntax keyword
 * scopes from this file, and `BLOCK_SNIPPET_BODY` below is consumed
 * directly by `completion.ts` — no more hand-synced copies. See CLAUDE.md.
 */

export type PairKind = 'plan' | 'feature' | 'metric' | 'measure' | 'override' | 'filter' | 'until';

export const BLOCK_OPEN_KEYWORD: Record<PairKind, string> = {
  plan: 'plan',
  feature: 'feature',
  metric: 'metric',
  measure: 'measure',
  override: 'override',
  filter: 'filter',
  until: 'until',
};

export const BLOCK_CLOSE_KEYWORD: Record<PairKind, string> = {
  plan: 'endplan',
  feature: 'endfeature',
  metric: 'endmetric',
  measure: 'endmeasure',
  override: 'endoverride',
  filter: 'endfilter',
  until: 'enduntil',
};

export interface KeywordInfo {
  name: string;
  detail: string;
}

export const NON_PAIRED_KEYWORDS: KeywordInfo[] = [
  { name: 'subplan', detail: 'Reference another plan file as a subplan' },
  { name: 'attribute', detail: 'Declare a custom attribute' },
  { name: 'annotation', detail: 'Declare a custom annotation' },
  { name: 'goal', detail: 'Metric goal expression (inside metric)' },
  { name: 'aggregator', detail: 'Metric aggregator (inside metric)' },
  { name: 'apply', detail: 'Aggregate-metric apply mode (inside metric)' },
  { name: 'keep', detail: 'Filter statement (inside filter)' },
  { name: 'remove', detail: 'Filter statement (inside filter)' },
  { name: 'where', detail: 'Filter expression clause (inside filter)' },
  { name: 'elseuntil', detail: 'until-block time-window branch' },
  { name: 'else', detail: 'until-block fallback branch' },
];

export const TYPE_KEYWORDS: KeywordInfo[] = ['integer', 'real', 'string', 'enum', 'set', 'ratio', 'percent', 'aggregate'].map(
  (name) => ({ name, detail: 'HVP type' })
);

export const AGGREGATOR_NAMES: KeywordInfo[] = ['sum', 'average', 'min', 'max', 'uniquesum'].map((name) => ({
  name,
  detail: 'Aggregator',
}));

/** The declared shape of every implicitly imported field. `field: 'statement'`
 * marks a keyword that is written like an assignment but declares nothing
 * (`source`), so the value resolver skips it. */
export interface BuiltinFieldInfo extends KeywordInfo {
  field: 'attribute' | 'annotation' | 'statement';
  type: string;
  default: string;
}

export const BUILTIN_FIELD_DECLARATIONS: BuiltinFieldInfo[] = [
  { name: 'description', field: 'annotation', type: 'string', default: '""', detail: 'Built-in annotation: human-readable description' },
  { name: 'weight', field: 'annotation', type: 'real', default: '1', detail: 'Built-in annotation: score contribution weight (default 1)' },
  { name: 'owner', field: 'attribute', type: 'string', default: '""', detail: 'Built-in attribute: ownership (default "")' },
  { name: 'at_least', field: 'attribute', type: 'integer', default: '0', detail: 'Built-in attribute: minimum coverage threshold (default 0)' },
  { name: 'source', field: 'statement', type: '', default: '', detail: 'Measure data source expression (inside measure)' },
  { name: 'test.expected', field: 'attribute', type: 'integer', default: '0', detail: 'Built-in attribute: expected test count' },
];

/** Grammar/completion view of the table above; order is part of the generated
 * grammars' golden output, so keep it aligned with BUILTIN_FIELD_DECLARATIONS. */
export const BUILTIN_FIELDS: KeywordInfo[] = BUILTIN_FIELD_DECLARATIONS.map(({ name, detail }) => ({ name, detail }));

/** Table 2 "Metric Types and Aggregators": the aggregators each metric type
 * accepts. `aggregate` accepts none of its own — it aggregates every sub-metric
 * with that sub-metric's aggregator. */
const EVERY_AGGREGATOR: readonly string[] = AGGREGATOR_NAMES.map(a => a.name);

export const METRIC_TYPE_AGGREGATORS: Record<string, readonly string[]> = {
  ratio: ['average'],
  percent: ['average'],
  integer: EVERY_AGGREGATOR,
  real: EVERY_AGGREGATOR,
  enum: ['sum', 'uniquesum'],
  aggregate: [],
};

/** The six metric types; `string` is an attribute type only. */
export const METRIC_TYPES: readonly string[] = Object.keys(METRIC_TYPE_AGGREGATORS);

/** The declared shape of an implicitly imported metric: Table 1 "Types and
 * Aggregators for Built-in Metrics" plus the derived test metrics. `members`
 * holds enum members, or the sub-metrics of an `aggregate` type. An empty
 * `aggregator` means the documentation states none — the derived test metrics
 * are computed rather than aggregated. */
export interface BuiltinMetricInfo extends KeywordInfo {
  type: string;
  aggregator: string;
  members: readonly string[];
}

const TEST_ENUM_MEMBERS = ['pass', 'fail', 'warn', 'unknown', 'assert'];
const metric = (name: string, type: string, aggregator: string, members: readonly string[] = []): BuiltinMetricInfo =>
  ({ name, type, aggregator, members, detail: 'Built-in metric' });

/** Order is part of the generated grammars' golden output (longest-first
 * alternation is applied downstream); keep new entries in documentation order. */
export const BUILTIN_METRIC_DECLARATIONS: BuiltinMetricInfo[] = [
  metric('Line', 'ratio', 'average'),
  metric('Cond', 'ratio', 'average'),
  metric('FSM', 'ratio', 'average'),
  metric('Toggle', 'ratio', 'average'),
  metric('Branch', 'ratio', 'average'),
  metric('Assert', 'ratio', 'average'),
  metric('Group', 'percent', 'average'),
  metric('Group.grp_count', 'integer', 'sum'),
  metric('Group.cvp_count', 'integer', 'sum'),
  metric('Group.bin_count', 'integer', 'sum'),
  metric('SnpsAvg', 'aggregate', '', ['Line', 'Cond', 'FSM', 'Toggle', 'Branch', 'Assert', 'Group']),
  metric('test', 'enum', 'sum', TEST_ENUM_MEMBERS),
  metric('AssertResult', 'enum', 'sum', ['successes', 'failures']),
  // Derived sub-metrics of `test`: integer counts per enum member, then the
  // percentages of those counts and the ratio against `test.expected`.
  ...TEST_ENUM_MEMBERS.map(member => metric(`test.${member}`, 'integer', 'sum')),
  metric('test.completion', 'percent', ''),
  ...TEST_ENUM_MEMBERS.map(member => metric(`test.percent.${member}`, 'percent', '')),
];

/** Grammar/completion view of the table above; order is part of the generated
 * grammars' golden output, so keep it aligned with BUILTIN_METRIC_DECLARATIONS. */
export const BUILTIN_METRICS: KeywordInfo[] = BUILTIN_METRIC_DECLARATIONS.map(({ name, detail }) => ({ name, detail }));

/** Tabstop-bearing snippet bodies, inserted directly as the `textEdit`/
 * `insertText` of each block-opener completion item (see
 * `completion.ts`'s `insertTextFormat: InsertTextFormat.Snippet`). Moved
 * server-side in Phase 2 — no more hand-copying into a client-side
 * `snippets/hvp.json`. */
export const BLOCK_SNIPPET_BODY: Record<PairKind, string> = {
  plan: 'plan ${1:PlanName};\n\t$0\nendplan',
  feature: 'feature ${1:FeatureName};\n\t$0\nendfeature',
  metric: 'metric ${1:MetricType} ${2:MetricName};\n\tgoal = ${3:expression};\n\taggregator = ${4:sum};\nendmetric',
  measure: 'measure ${1:MetricType} ${2:MeasureName};\n\tsource = ${3:"..."};\n\t$0\nendmeasure',
  override: 'override ${1:OverrideName};\n\t$0\nendoverride',
  filter: 'filter ${1:FilterName};\n\t${2|keep,remove|} feature where ${3:expression};\nendfilter',
  until: 'until ${1:MM-DD-YYYY};\n\t$0\nenduntil',
};

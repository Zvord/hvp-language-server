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

/** Table 4 "Source Formats for Built-In Metrics": the keyword prefix a
 * `source = "..."` string may open with, and the built-in metrics the chapter
 * lists it for. `mask: true` marks the two `property` forms that carry a
 * `'h###` category/severity mask. */
export interface SourceKeywordInfo extends KeywordInfo {
  /** Canonical, space-normalised spelling: `group instance bin`, `property categoryMask`, … */
  name: string;
  /** Built-in metrics Table 4 lists this keyword for. */
  metrics: readonly string[];
  mask?: boolean;
}

/** `SnpsAvg`'s own entry already states what it aggregates, so the chapter's
 * "you can use any source format listed in Table 4 for `SnpsAvg`" rule is a
 * membership test against that list rather than a name hand-added to every row. */
const SNPS_AVG = BUILTIN_METRIC_DECLARATIONS.find(m => m.name === 'SnpsAvg')!;

/**
 * A Table 4 row's metrics, resolved through `BUILTIN_METRIC_DECLARATIONS`.
 *
 * The resolution is the point: Table 4's rows and the built-in metric table
 * used to be two hand-written spellings of the same names with no link between
 * them, and a typo or a renamed built-in would drop the name out of
 * `TABLE_4_METRICS` — which makes the compatibility check quietly stop firing
 * rather than fail. Here an unknown name is a load-time error instead, and
 * `test/sourceExpressions.test.ts` pins the derivation. Table 4's own column
 * order is kept, since the diagnostic reads it back.
 */
const table4Row = (...names: string[]): readonly string[] => {
  const metrics = names.map(name => {
    const found = BUILTIN_METRIC_DECLARATIONS.find(m => m.name === name);
    if (!found) throw new Error(`Table 4 names '${name}', which is not a built-in metric.`);
    return found.name;
  });
  return metrics.some(name => SNPS_AVG.members.includes(name)) ? [...metrics, SNPS_AVG.name] : metrics;
};

/** Code coverage metrics, as Table 4 groups them, plus `Assert`. */
const CODE_COVERAGE_METRICS = table4Row('Assert', 'Line', 'Cond', 'Toggle', 'FSM', 'Branch');
const GROUP_METRICS = table4Row('Group');

export const SOURCE_KEYWORDS: SourceKeywordInfo[] = [
  { name: 'module', metrics: CODE_COVERAGE_METRICS, detail: 'Source region: module name' },
  { name: 'instance', metrics: CODE_COVERAGE_METRICS,
    detail: 'Source region: DUT instance hierarchy, the matched instance only' },
  { name: 'tree', metrics: CODE_COVERAGE_METRICS,
    detail: 'Source region: DUT instance hierarchy, including the sub-hierarchy' },
  { name: 'property', metrics: table4Row('Assert', 'AssertResult'),
    detail: 'Source region: instance hierarchy ending in an assertion or property name' },
  { name: 'property categoryMask', metrics: table4Row('Assert'), mask: true,
    detail: "Source region: property, filtered by a 'h### category mask" },
  { name: 'property severityMask', metrics: table4Row('Assert'), mask: true,
    detail: "Source region: property, filtered by a 'h### severity mask" },
  { name: 'group', metrics: GROUP_METRICS, detail: 'Source region: covergroup or covergroup.coverpoint' },
  { name: 'group bin', metrics: GROUP_METRICS,
    detail: 'Source region: covergroup.coverpoint.bin, or .bin1-bin2 for a cross bin' },
  { name: 'group instance', metrics: GROUP_METRICS,
    detail: 'Source region: covergroup.instance or covergroup.instance.coverpoint' },
  { name: 'group instance bin', metrics: GROUP_METRICS,
    detail: 'Source region: covergroup.instance.coverpoint.bin' },
];

/** The spellings `property` accepts before its `'h###` mask — the last word of
 * each mask-bearing keyword, derived rather than restated (as `BUILTIN_METRICS`,
 * `METRIC_TYPES` and `TABLE_4_METRICS` all are). */
export const SOURCE_MASK_WORDS: readonly string[] =
  SOURCE_KEYWORDS.filter(k => k.mask).map(k => k.name.slice(k.name.lastIndexOf(' ') + 1));

/** Every metric Table 4 describes a source format for. A measure naming
 * anything else — a declared metric, `test`, `Group.bin_count` — is outside the
 * table, so its keyword is not held to it. */
export const TABLE_4_METRICS: ReadonlySet<string> = new Set(SOURCE_KEYWORDS.flatMap(k => k.metrics));

/** The `` `r` ``/`` `n` ``/`` `-` `` tags and the wildcards, spelled once here:
 * the grammar generator (WS8b) scopes them and `sourceExpressions.ts` derives
 * its own tag and wildcard tables from these, so the pattern reader and the
 * highlighter can never disagree about which tags exist. What each tag *means*
 * is `sourceExpressions.ts`'s reading of the chapter, not data. */
export const SOURCE_TAGS: readonly string[] = ['`r`', '`n`', '`-`'];
export const SOURCE_WILDCARDS: readonly string[] = ['**', '*', '?'];

/** The one variable a `source` string's `${...}` may name that no plan declares:
 * the full path of the measure hierarchy (`plan.feature.measure`). Spelled here
 * next to `SOURCE_KEYWORDS` rather than as a bare literal in each module that
 * tests for it. */
export const OBJPATH = 'objpath';

/**
 * The words a declaration may not take as its name, and the rule for a legal
 * one. Derived from the keyword tables above, so a keyword added there cannot
 * stay renameable-onto by accident.
 *
 * `structuralDiagnostics` reports a declaration that breaks this, and rename
 * refuses a new name that would: both need the same answer, and a rename onto
 * `plan` would otherwise write a file that no longer parses.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  ...Object.values(BLOCK_OPEN_KEYWORD), ...Object.values(BLOCK_CLOSE_KEYWORD),
  ...NON_PAIRED_KEYWORDS.map((k) => k.name), ...TYPE_KEYWORDS.map((k) => k.name),
  ...AGGREGATOR_NAMES.map((k) => k.name), 'source', 'inside', 'match',
]);

const IDENTIFIER_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const isValidIdentifier = (name: string): boolean =>
  IDENTIFIER_SHAPE.test(name) && !RESERVED_WORDS.has(name);

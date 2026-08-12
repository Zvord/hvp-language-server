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

export const BUILTIN_FIELDS: KeywordInfo[] = [
  { name: 'description', detail: 'Built-in annotation: human-readable description' },
  { name: 'weight', detail: 'Built-in annotation: score contribution weight (default 1)' },
  { name: 'owner', detail: 'Built-in attribute: ownership (default "")' },
  { name: 'at_least', detail: 'Built-in attribute: minimum coverage threshold (default 0)' },
  { name: 'source', detail: 'Measure data source expression (inside measure)' },
  { name: 'phase', detail: 'Built-in field' },
  { name: 'test.expected', detail: 'Built-in attribute: expected test count' },
];

export const BUILTIN_METRICS: KeywordInfo[] = [
  'Line',
  'Cond',
  'FSM',
  'Toggle',
  'Branch',
  'Assert',
  'Group',
  'Group.grp_count',
  'Group.cvp_count',
  'Group.bin_count',
  'SnpsAvg',
  'test',
  'AssertResult',
  'test.pass',
  'test.fail',
  'test.warn',
  'test.unknown',
  'test.assert',
  'test.completion',
  'test.percent.pass',
  'test.percent.fail',
  'test.percent.warn',
  'test.percent.unknown',
  'test.percent.assert',
].map((name) => ({ name, detail: 'Built-in metric' }));

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

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';
import { reporter } from './diagnostics';
import { AGGREGATOR_NAMES, BLOCK_CLOSE_KEYWORD, BLOCK_OPEN_KEYWORD, BUILTIN_FIELD_DECLARATIONS, BUILTIN_METRICS, NON_PAIRED_KEYWORDS, TYPE_KEYWORDS } from './keywords';
import { PlanDocument, PlanNode, nameToken } from './planModel';

const reserved = new Set([
  ...Object.values(BLOCK_OPEN_KEYWORD), ...Object.values(BLOCK_CLOSE_KEYWORD),
  ...NON_PAIRED_KEYWORDS.map(k => k.name), ...TYPE_KEYWORDS.map(k => k.name),
  ...AGGREGATOR_NAMES.map(k => k.name), 'source', 'inside', 'match',
]);
const builtins = new Set([
  ...BUILTIN_FIELD_DECLARATIONS.filter(f => f.field !== 'statement').map(f => f.name),
  ...BUILTIN_METRICS.map(k => k.name),
]);
const placement: Partial<Record<PlanNode['kind'], PlanNode['kind']>> = {
  attribute: 'plan', annotation: 'plan', metric: 'plan', measure: 'feature',
  goal: 'metric', aggregator: 'metric', apply: 'metric', keep: 'filter', remove: 'filter',
};

/** Checks local syntax structure only; anything that needs a second file is
 * `workspaceDiagnostics`. The `unreferenced-plan` rule below is the one the two
 * share: this reads it within the document, and the workspace pass drops the
 * report when another file instantiates the plan. */
export function structuralDiagnostics(model: PlanDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = reporter(diagnostics);
  const declarations = new Map<string, PlanNode>();
  for (const node of model.nodes) {
    const parent = model.parent(node);
    const required = placement[node.kind];
    if (required && parent?.kind !== required) {
      report(node.header.range, 'invalid-placement', `'${node.kind}' is only allowed directly inside a ${required}.`);
    }
    if (!('name' in node)) continue;
    const name = nameToken(node);
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.text) || reserved.has(name.text)) {
      report(name?.range ?? node.header.range, 'invalid-identifier',
        name ? `Invalid identifier '${name.text}': expected [A-Za-z_][A-Za-z0-9_]* and no reserved word.` : `Missing ${node.kind} identifier.`);
    }
    if (!name) continue;
    if (['attribute', 'annotation', 'metric'].includes(node.kind)) {
      if (builtins.has(name.text)) {
        report(name.range, 'builtin-redeclaration', `Declaration '${name.text}' redeclares a built-in.`, DiagnosticSeverity.Warning);
      }
      const plan = model.enclosingPlan(node.start);
      // Attributes, annotations and metrics share assignment-name lookup.
      const key = `declaration:${plan?.id ?? 'root'}:${name.text}`;
      if (declarations.has(key)) report(name.range, 'duplicate-declaration', `Duplicate declaration '${name.text}' in this plan.`);
      else declarations.set(key, node);
    } else if (node.kind === 'feature' || node.kind === 'measure') {
      const key = `${node.kind}:${parent?.id ?? 'root'}:${name.text}`;
      if (declarations.has(key)) report(name.range, 'duplicate-declaration', `Duplicate ${node.kind} name '${name.text}' in this scope.`);
      else declarations.set(key, node);
    }
  }
  const references = new Set(model.nodes.filter(n => n.kind === 'subplan').map(n => n.name?.text));
  for (const plan of model.plans.slice(0, -1)) {
    const name = nameToken(plan);
    if (name && !references.has(name.text)) {
      report(name.range, 'unreferenced-plan',
        `Plan '${name.text}' must be referenced by a subplan statement; only the last plan may be top level.`,
        undefined, { plan: name.text });
    }
  }
  return diagnostics;
}

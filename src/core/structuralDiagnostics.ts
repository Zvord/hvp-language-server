import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { AGGREGATOR_NAMES, BLOCK_CLOSE_KEYWORD, BLOCK_OPEN_KEYWORD, BUILTIN_METRICS, NON_PAIRED_KEYWORDS, TYPE_KEYWORDS } from './keywords';
import { PlanDocument, PlanNode } from './planModel';

const reserved = new Set([
  ...Object.values(BLOCK_OPEN_KEYWORD), ...Object.values(BLOCK_CLOSE_KEYWORD),
  ...NON_PAIRED_KEYWORDS.map(k => k.name), ...TYPE_KEYWORDS.map(k => k.name),
  ...AGGREGATOR_NAMES.map(k => k.name), 'source', 'inside', 'match',
]);
const builtins = new Set(['owner', 'at_least', 'weight', 'description', ...BUILTIN_METRICS.map(k => k.name)]);
const placement: Partial<Record<PlanNode['kind'], PlanNode['kind']>> = {
  attribute: 'plan', annotation: 'plan', metric: 'plan', measure: 'feature',
  goal: 'metric', aggregator: 'metric', apply: 'metric', keep: 'filter', remove: 'filter',
};

/** Checks local syntax structure only; workspace resolution belongs to WS5. */
export function structuralDiagnostics(model: PlanDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (range: Range, code: string, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) => {
    diagnostics.push({ range, code, message, severity, source: 'hvp' });
  };
  const declarations = new Map<string, PlanNode>();
  for (const node of model.nodes) {
    const parent = model.parent(node);
    const required = placement[node.kind];
    if (required && parent?.kind !== required) {
      report(node.header.range, 'invalid-placement', `'${node.kind}' is only allowed directly inside a ${required}.`);
    }
    if (!('name' in node)) continue;
    const name = node.name;
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
    if ('name' in plan && plan.name && !references.has(plan.name.text)) {
      report(plan.name.range, 'unreferenced-plan', `Plan '${plan.name.text}' must be referenced by a subplan statement; only the last plan may be top level.`);
    }
  }
  return diagnostics;
}

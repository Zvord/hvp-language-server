import { Diagnostic } from 'vscode-languageserver-types';
import { Declaration, declarationFromNode, scopeOf } from './declarations';
import { reporter } from './diagnostics';
import { PlanDocument, PlanNode, TokenRun, runText, valueSpan } from './planModel';
import { checkValue } from './values';

/**
 * Value-level checks over the declaration table: declaration defaults and
 * assignments typed against their declaration, and assignments to names no
 * plan declares.
 *
 * A left-hand side that resolves to a metric is a feature-level goal override
 * (`Group = Group >= 0.8;`), not an attribute assignment; `metricDiagnostics`
 * checks those against the metric's own goal grammar instead.
 */
export function semanticDiagnostics(model: PlanDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = reporter(diagnostics);
  const checkAgainst = (declaration: Declaration, value: TokenRun, header: PlanNode['header']) => {
    const message = checkValue(declaration, value);
    if (message) report(valueSpan(value, header).range, 'invalid-value', message);
  };
  for (const node of model.nodes) {
    if (node.kind === 'attribute' || node.kind === 'annotation') {
      // A statement the parser had to recover from already carries a syntax
      // diagnostic; its value run is unreliable, so no semantic error is stacked
      // on top of it.
      if (node.incomplete || !node.name) continue;
      checkAgainst(declarationFromNode(node), node.value, node.header);
      continue;
    }
    // `checkable` is the shared exemption: a recovered statement, and a modifier
    // block whose assignments address the instantiated hierarchy (WS7's).
    if (node.kind !== 'assignment' || !model.checkable(node)) continue;
    const name = runText(node.target);
    const declaration = scopeOf(model, node).declarations.get(name);
    if (!declaration) {
      // An assignment outside any plan belongs to a modifier file, which names
      // attributes the modified plan declares. WS5 resolves those across files;
      // until then there is nothing here to check the name against.
      if (model.enclosingOf(node, 'plan')) {
        report(node.target.range, 'unknown-assignment-target',
          `'${name}' is not a declared attribute, annotation or metric in this plan.`);
      }
      continue;
    }
    if (declaration.kind === 'metric') continue; // A goal override; see metricDiagnostics.
    checkAgainst(declaration, node.value, node.header);
  }
  return diagnostics;
}

import { Diagnostic } from 'vscode-languageserver-types';
import { reporter } from './diagnostics';
import { PlanDocument, nameToken, runText, valueSpan } from './planModel';
import { checkValue } from './values';
import {
  PlanEntry,
  SubplanNode,
  WorkspaceIndex,
  cyclicSubplans,
  parameterTarget,
  referencedPlanNames,
} from './workspace';

/**
 * The checks that need more than one file: `subplan` resolution, `#(...)`
 * parameters, cycles, and the top-level plan rule across the plan set.
 *
 * Not run from `parseDocument`. Every other pass is, because it needs nothing
 * but the document; this one needs the index, which the server refreshes on a
 * different clock than the per-version parse. Keeping it out of the parser is
 * also what keeps the workspace scan off the hot path: a keystroke reparses one
 * document, and the index it is checked against is whatever was last built.
 *
 * The return value is the document's *complete* diagnostic list — the parse's
 * own, minus the ones the workspace answers differently, plus the cross-file
 * ones — so the server has one call and one array to publish.
 */
export function workspaceDiagnostics(model: PlanDocument, uri: string, index: WorkspaceIndex): Diagnostic[] {
  // An index that has not reached this document yet knows nothing about the
  // plan set it belongs to; every check below would fire on every name.
  if (!index.document(uri)) return model.diagnostics;
  return [...kept(model, index), ...added(model, index)];
}

/**
 * The top-level plan rule, extended across files.
 *
 * WS1 reads the rule within one document: every plan but the last must be used
 * as a subplan. Across a set of files there is no "last plan" — the tool is
 * handed the files in a `-plan` argument order the editor cannot see — so the
 * only part of the rule that survives is the part that suppresses: a plan some
 * other file instantiates is used as a subplan, and WS1's diagnostic on it was
 * a false positive. The reverse direction is deliberately *not* added. Several
 * unreferenced plans across a workspace is the error the chapter describes, but
 * a workspace routinely holds several unrelated plan sets, each with its own
 * top-level plan, and reporting those would be the worst kind of false positive:
 * one on a file that is entirely correct.
 */
function kept(model: PlanDocument, index: WorkspaceIndex): Diagnostic[] {
  const referenced = referencedPlanNames(index);
  // The plan name rides on the diagnostic (`structuralDiagnostics` puts it
  // there), so this reads the name off the diagnostic rather than pairing it
  // back to a plan node by position.
  return model.diagnostics.filter(diagnostic => diagnostic.code !== 'unreferenced-plan' ||
    !referenced.has((diagnostic.data as { plan?: string } | undefined)?.plan ?? ''));
}

function added(model: PlanDocument, index: WorkspaceIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = reporter(diagnostics);
  const cyclic = cyclicSubplans(index);
  for (const node of model.nodes) {
    if (node.kind !== 'subplan' || !model.checkable(node)) continue;
    const name = nameToken(node);
    // A nameless subplan already carries WS1's `invalid-identifier`.
    if (!name) continue;
    const targets = index.plans(name.text);
    if (!targets.length) {
      report(name.range, 'unknown-plan',
        `Unknown plan '${name.text}': no .hvp file in this workspace declares it.`);
      continue;
    }
    if (cyclic.has(node)) {
      report(name.range, 'subplan-cycle',
        `Subplan cycle: '${name.text}' already contains the plan this statement is written in.`);
    }
    checkParameters(node, targets, report);
  }
  return diagnostics;
}

/**
 * Each `name=value` against the target plan's own declarations.
 *
 * A name the workspace declares twice is checked against every candidate and
 * reported only when none of them accepts it, and typed only when there is a
 * single candidate — two plans of the same name may declare the same attribute
 * with different types, and there is no way to know which one the tool loaded.
 */
function checkParameters(node: SubplanNode, targets: readonly PlanEntry[],
                         report: ReturnType<typeof reporter>): void {
  for (const parameter of node.parameters) {
    const name = runText(parameter.name);
    if (!name) continue;
    const declarations = targets.map(target => parameterTarget(target, name));
    if (declarations.every(declaration => declaration?.kind !== 'attribute')) {
      const declared = declarations.find(declaration => declaration);
      report(parameter.name.range, 'unknown-parameter', declared
        ? `'${name}' is ${declared.kind === 'annotation' ? 'an annotation' : 'a metric'} in plan '${targets[0].name}', and a subplan parameter may only set an attribute.`
        : `'${name}' is not an attribute declared in plan '${targets[0].name}'.`);
      continue;
    }
    if (declarations.length !== 1 || declarations[0]!.kind !== 'attribute') continue;
    const message = checkValue(declarations[0]!, parameter.value);
    if (message) report(valueSpan(parameter.value, parameter).range, 'invalid-parameter-value', message);
  }
}

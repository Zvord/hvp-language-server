import { Position } from 'vscode-languageserver-types';
import { PlanDocument } from './planModel';
import { objectPath } from './resolver';
import { WorkspaceIndex, instanceViewAt } from './workspace';

export interface ObjectPathOptions {
  uri?: string;
  index?: WorkspaceIndex;
}

export interface ObjectPathResult {
  /** The dotted hierarchy path of the plan/feature/measure under the cursor —
   * the same string `${objpath}` would expand to there. */
  path: string;
  /** How many instances of the enclosing plan the workspace knows about.
   * `path` is prefixed with the instance's own path only when this is exactly
   * 1 — `instanceViewAt`'s fallback for 0 (no index, or the plan is never
   * instantiated) or several (no one instance under the cursor) is the same
   * one `hover.ts`'s value table uses: the path within this file as written. */
  instances: number;
}

/**
 * The full hierarchy path under the cursor, for a "copy path" command — a
 * thin position lookup in front of `resolver.ts`'s `objectPath`, resolved
 * through whichever single instance `instanceViewAt` finds for this file.
 *
 * A comment or a plain string literal is text the model has no structure for,
 * matching every other position-based provider's guard; a `source` string is
 * not (WS4 models its contents), so it is left to resolve a path like any
 * other node inside a measure.
 */
export function provideObjectPath(model: PlanDocument, position: Position,
                                  options: ObjectPathOptions = {}): ObjectPathResult | undefined {
  const offset = model.source.offsetAt(position);
  const node = model.nodeAt(offset);
  if (!node) return undefined;
  const mask = model.maskAt(offset);
  if (mask === 'comment' || mask === 'string') return undefined;
  const view = instanceViewAt(options.index, options.uri, model, node);
  const path = objectPath(model, node, view.context);
  if (!path) return undefined;
  return { path, instances: view.instances.length };
}

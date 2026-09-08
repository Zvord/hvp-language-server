import { Declaration, lookup, scopeOf } from './declarations';
import { NamedNode, PlanDocument, PlanNode, nameToken, runText } from './planModel';
import { ResolutionContext, featurePath } from './resolver';

/** The two node kinds this module holds by name, so callers can pass one around
 * without re-testing `kind`. */
export type SubplanNode = Extract<PlanNode, { kind: 'subplan' }>;
/** Not `Extract<PlanNode, { kind: 'plan' }>`: the model spells `plan`, `feature`,
 * `override` and `filter` as one union member with a four-way `kind`, and
 * `Extract` over that yields `never`. */
export type PlanBlock = NamedNode & { kind: 'plan' };

/** One `.hvp` file the index knows about, already parsed.
 *
 * The index never reads a file: `src/workspaceFiles.ts` (server-owned) does the
 * disk access and hands the models in, and a test hands in models built from
 * strings. Core stays free of `node:fs` for the same reason it stays free of
 * `vscode`. */
export interface IndexedDocument {
  uri: string;
  model: PlanDocument;
}

/** A `plan ... endplan` block somewhere in the workspace. */
export interface PlanEntry {
  name: string;
  uri: string;
  model: PlanDocument;
  node: PlanBlock;
}

/** Where a `subplan` statement was written. */
export interface SubplanSite {
  uri: string;
  model: PlanDocument;
  node: SubplanNode;
}

/**
 * One instantiation of a plan.
 *
 * The same plan instantiated four times is four of these, each with its own
 * `parameters` and its own `path`. A top-level plan has one instance with an
 * empty path, no parameters and no `origin`.
 */
export interface PlanInstance {
  plan: PlanEntry;
  /** Hierarchy path this instance hangs under, outermost first, excluding the
   * plan's own name — `objectPath` adds that. Empty for a top-level plan. */
  path: readonly string[];
  /** `#(name=value)` values this instance received, by attribute name. */
  parameters: ReadonlyMap<string, string>;
  /** The `subplan` statement that created it; absent for a top-level plan. */
  origin?: SubplanSite;
  parent?: PlanInstance;
}

/**
 * Plan names to the files declaring them, plus the instantiated hierarchy.
 *
 * The chapter describes a *set* of plan files handed to the tool through
 * `-plan`/`-mod` arguments, with no include directive of any kind: a plan name
 * is global across that set, and nothing ties a name to a file name. The editor
 * approximates the set with the workspace, so every `.hvp` file under it is
 * indexed and `plans(name)` searches all of them.
 *
 * This is the interface WS6 (cross-file definition, references, workspace
 * symbols) and WS7 (modifier files naming plan paths) code against. It is
 * deliberately an interface rather than a class: the only implementation core
 * ships is `buildIndex`, over models a caller already holds.
 */
export interface WorkspaceIndex {
  documents(): readonly IndexedDocument[];
  document(uri: string): IndexedDocument | undefined;
  /** Every plan declared under `name`, in index order; empty when unknown. */
  plans(name: string): readonly PlanEntry[];
  /** Every plan in the workspace, for name completion and workspace symbols. */
  allPlans(): readonly PlanEntry[];
  /** The instantiated hierarchy, memoized: see `instantiate`. */
  instances(): readonly PlanInstance[];
}

/** Root-level `plan` blocks only. A plan nested inside another block is not a
 * plan definition the tool would load, and `declarations.ts` already puts its
 * declarations in the root scope rather than a scope of its own. */
const planBlocks = (model: PlanDocument): PlanBlock[] =>
  model.plans.filter((node): node is PlanBlock => !!nameToken(node));

/** Every `subplan` statement inside `plan`, in document order. */
export function subplansIn(model: PlanDocument, plan: PlanNode): SubplanNode[] {
  const found: SubplanNode[] = [];
  const visit = (nodes: readonly PlanNode[]) => {
    for (const node of nodes) {
      // `checkable` is the shared exemption again: a modifier block addresses
      // the instantiated hierarchy rather than adding to it, so a `subplan`
      // written inside one instantiates nothing.
      if (node.kind === 'subplan') { if (model.checkable(node)) found.push(node); }
      else visit(node.children);
    }
  };
  visit(plan.children);
  return found;
}

export function buildIndex(documents: Iterable<IndexedDocument>): WorkspaceIndex {
  const files = [...documents];
  const byUri = new Map(files.map(file => [file.uri, file]));
  const byName = new Map<string, PlanEntry[]>();
  const all: PlanEntry[] = [];
  for (const { uri, model } of files) {
    for (const node of planBlocks(model)) {
      const entry: PlanEntry = { name: nameToken(node)!.text, uri, model, node };
      all.push(entry);
      const existing = byName.get(entry.name);
      if (existing) existing.push(entry);
      else byName.set(entry.name, [entry]);
    }
  }
  let instances: readonly PlanInstance[] | undefined;
  const index: WorkspaceIndex = {
    documents: () => files,
    document: uri => byUri.get(uri),
    plans: name => byName.get(name) ?? [],
    allPlans: () => all,
    instances: () => instances ??= instantiate(index),
  };
  return index;
}

/** The plans a `subplan` statement could name. More than one entry means the
 * workspace declares the name twice; the callers below only report what holds
 * for every candidate, so a duplicate never turns into a false positive. */
export function subplanTargets(index: WorkspaceIndex, node: SubplanNode): readonly PlanEntry[] {
  const name = nameToken(node)?.text;
  return name ? index.plans(name) : [];
}

/** The `#(name=value)` values a `subplan` statement passes, by name. Later
 * duplicates of the same name lose to the first, matching the assignment rule
 * nowhere and nothing else — the parameter list is written once. */
export function parametersOf(node: SubplanNode): Map<string, string> {
  const parameters = new Map<string, string>();
  for (const parameter of node.parameters) {
    const name = runText(parameter.name);
    // A parameter written without a value passes nothing; the diagnostics pass
    // reports it, and inventing an empty value here would hide it from hover.
    if (name && parameter.value.tokens.length && !parameters.has(name)) parameters.set(name, runText(parameter.value));
  }
  return parameters;
}

/** Every plan name any `subplan` statement in the workspace references. */
export function referencedPlanNames(index: WorkspaceIndex): Set<string> {
  const names = new Set<string>();
  for (const { model } of index.documents()) {
    for (const node of model.nodes) {
      if (node.kind === 'subplan' && node.name && model.checkable(node)) names.add(node.name.text);
    }
  }
  return names;
}

/** Plans nothing instantiates: the top-level plan of each plan set in the
 * workspace, and the roots the instance walk starts from. */
export function topLevelPlans(index: WorkspaceIndex): PlanEntry[] {
  const referenced = referencedPlanNames(index);
  return index.allPlans().filter(entry => !referenced.has(entry.name));
}

/** The hierarchy is a tree, and a tree of plan instantiations can be wide as
 * well as deep — a plan instantiated ten times, each of whose instances
 * instantiates ten more. The cap is what keeps a pathological workspace from
 * turning a hover into an out-of-memory. */
const MAX_INSTANCES = 20000;

/**
 * The instantiated hierarchy: every plan instance in the workspace.
 *
 * The walk starts at the plans nothing references and follows `subplan`
 * statements down. An instance's path is its parent's path, the parent plan's
 * own name and the feature path of the `subplan` statement — exactly the prefix
 * `objectPath` would have produced for that statement, so a measure inside the
 * instance reports the path the tool would give it.
 *
 * The edge that would put a plan inside itself is not followed — by the
 * ancestor stack, not by `cyclicSubplans`, so a hierarchy that *reaches* a
 * cycle is still built down to the point where it closes.
 */
export function instantiate(index: WorkspaceIndex): PlanInstance[] {
  const instances: PlanInstance[] = [];
  const walk = (instance: PlanInstance, ancestors: readonly string[]): void => {
    instances.push(instance);
    if (instances.length >= MAX_INSTANCES) return;
    const { model, node: plan } = instance.plan;
    const stack = [...ancestors, instance.plan.name];
    for (const node of subplansIn(model, plan)) {
      // The edge that would put a plan inside itself is the one not followed —
      // the ancestor stack rather than `cyclicSubplans`, so a hierarchy that
      // reaches a cycle is still built down to the point where it closes.
      if (stack.includes(nameToken(node)?.text ?? '')) continue;
      const targets = subplanTargets(index, node);
      // An ambiguous name would instantiate two different hierarchies under one
      // path; take the first so the walk stays a tree, and say nothing.
      const target = targets[0];
      if (!target) continue;
      const feature = model.enclosingOf(node, 'feature');
      walk({
        plan: target,
        path: [...instance.path, instance.plan.name,
          ...(feature ? featurePath(model, feature).split('.') : [])].filter(Boolean),
        parameters: parametersOf(node),
        origin: { uri: instance.plan.uri, model, node },
        parent: instance,
      }, stack);
    }
  };
  for (const entry of topLevelPlans(index)) {
    walk({ plan: entry, path: [], parameters: new Map() }, []);
    if (instances.length >= MAX_INSTANCES) break;
  }
  return instances;
}

/**
 * The `subplan` statements that close a cycle.
 *
 * Reachability over the plan-name graph rather than a walk of the hierarchy,
 * because a cycle need not be reachable from any top-level plan: two plans that
 * only instantiate each other are a cycle with no root above them, and the
 * hierarchy walk would never reach either. Every statement *on* a cycle — one
 * whose target can reach the plan it was written in — is reported, since any
 * one of them could be the one to change; a statement that merely reaches a
 * cycle from outside it is not.
 */
export function cyclicSubplans(index: WorkspaceIndex): Set<SubplanNode> {
  const edges = new Map<string, Set<string>>();
  const sites: { from: string; to: string; node: SubplanNode }[] = [];
  for (const entry of index.allPlans()) {
    const targets = edges.get(entry.name) ?? new Set<string>();
    edges.set(entry.name, targets);
    for (const node of subplansIn(entry.model, entry.node)) {
      const to = nameToken(node)?.text;
      if (!to) continue;
      targets.add(to);
      sites.push({ from: entry.name, to, node });
    }
  }
  const memo = new Map<string, Set<string>>();
  const reachable = (from: string): Set<string> => {
    const cached = memo.get(from);
    if (cached) return cached;
    const result = new Set<string>();
    const queue = [...edges.get(from) ?? []];
    while (queue.length) {
      const next = queue.pop()!;
      if (result.has(next)) continue;
      result.add(next);
      queue.push(...edges.get(next) ?? []);
    }
    memo.set(from, result);
    return result;
  };
  const cyclic = new Set<SubplanNode>();
  for (const site of sites) {
    if (site.to === site.from || reachable(site.to).has(site.from)) cyclic.add(site.node);
  }
  return cyclic;
}

/** What the resolver needs to report this instance's values: WS2 built the seam
 * (`instancePath`/`parameters`), this fills it in. */
export const contextOf = (instance: PlanInstance): ResolutionContext =>
  ({ instancePath: instance.path, parameters: instance.parameters });

/** Every instance of one plan block. Matched by URI and node id rather than by
 * object identity, so an index holding a model one version behind the one the
 * request is being served from still answers. */
export function instancesOfPlan(index: WorkspaceIndex, uri: string | undefined,
                                model: PlanDocument, plan: PlanNode): readonly PlanInstance[] {
  const id = plan.id;
  return index.instances().filter(instance => uri === undefined
    ? instance.plan.model === model && instance.plan.node.id === id
    : instance.plan.uri === uri && instance.plan.node.id === id);
}

/**
 * The instances a position in `model` belongs to, and the context to resolve
 * values with.
 *
 * A plan instantiated once has one instance, and its parameters are the values
 * the cursor's feature actually sees. A plan instantiated four times has four,
 * and there is no "the instance under the cursor" — the file is written once
 * and read four ways — so the context stays empty and the caller says how many
 * instead of picking one arbitrarily.
 */
export interface InstanceView {
  instances: readonly PlanInstance[];
  context: ResolutionContext;
}

export function instanceViewAt(index: WorkspaceIndex | undefined, uri: string | undefined,
                               model: PlanDocument, node: PlanNode | undefined): InstanceView {
  const plan = model.enclosingOf(node, 'plan');
  if (!index || !plan) return { instances: [], context: {} };
  const instances = instancesOfPlan(index, uri, model, plan);
  return { instances, context: instances.length === 1 ? contextOf(instances[0]) : {} };
}

/** The instance a `subplan` statement creates, when the plan holding it has one
 * unambiguous instance of its own. */
export function instanceOfSubplan(index: WorkspaceIndex | undefined, uri: string | undefined,
                                  model: PlanDocument, node: SubplanNode): PlanInstance | undefined {
  if (!index) return undefined;
  return index.instances().find(instance => instance.origin
    && (uri === undefined ? instance.origin.model === model : instance.origin.uri === uri)
    && instance.origin.node.id === node.id);
}

/** The attribute `name` names in `entry`'s plan, or the declaration that shadows
 * it. A `#(...)` parameter may only name an attribute: the BNF spells the left
 * side `attribute-identifier`, and an annotation is local to the feature that
 * assigns it, so passing one in would have nothing to apply to. */
export function parameterTarget(entry: PlanEntry, name: string): Declaration | undefined {
  return lookup(scopeOf(entry.model, entry.node), name);
}

/**
 * WS7: the `override`, `filter` and `until` modifiers.
 *
 * Three languages sit in the modifier chapter and this module reads all three,
 * because they only mean anything together: an `override` statement addresses
 * the *instantiated* hierarchy by path, a `filter` statement decides which
 * features survive, and an `until` block says which of the two is live today.
 *
 * The one idea underneath it: a modifier statement is resolved to the set of
 * hierarchy scopes it names, once, against `workspace.ts`'s `instances()` — and
 * every consumer (the diagnostics, the hover preview, the resolver's
 * `overrides` seam) reads that resolution instead of re-matching paths. A path
 * that resolves to nothing is a diagnostic; a path that resolves to several
 * scopes is normal, since that is what a wildcard is for.
 *
 * Editor-agnostic like the rest of `src/core`: no `vscode`, no disk, and no
 * clock of its own — the evaluation date is handed in, so a test pins it and
 * `server.ts` supplies today's.
 */
import { Declaration, Scope, lookup, scopeOf } from './declarations';
import { GoalNode, ParsedGoal, parseGoal } from './goals';
import { PlanDocument, PlanNode, Reference, TokenRun, nameToken, runText, valueSpan } from './planModel';
import { AssignmentNode, featurePath } from './resolver';
import type { PlanInstance, WorkspaceIndex } from './workspace';

// ---------------------------------------------------------------------------
// Table 5: wildcards in a path
// ---------------------------------------------------------------------------

/** `**` before `*`, so the two-character wildcard is never read as two of the
 * one-character one — the same longest-first rule `gen-grammars.ts` states. */
const WILDCARD_PART = /\*\*|[*?]|[^*?]+/g;
export const WILDCARD = /[*?]/;
export const hasWildcard = (text: string): boolean => WILDCARD.test(text);

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Table 5 as a regular expression over a dotted path.
 *
 * `?` is one character, `*` is zero or more within one hierarchy segment, and
 * `**` is zero or more regardless of hierarchy — so only `**` may cross a `.`.
 * Read literally, which is what makes `top.**.weight` name the descendants of
 * `top` and not `top` itself: `**` standing for nothing still leaves the two
 * dots around it, and `top..weight` is no path.
 */
const patternSource = (segments: readonly string[]): string =>
  segments.map(segment => segment.replace(WILDCARD_PART, part =>
    part === '**' ? '[^]*' : part === '*' ? '[^.]*' : part === '?' ? '[^.]' : escapeRegex(part))).join('\\.');

/** A compiled path pattern. `matches` is the whole path; `covers` is the path
 * or any ancestor of it, which is how an attribute override reaches the leaves
 * below the scope it names. */
export interface PathMatcher {
  readonly text: string;
  readonly wildcarded: boolean;
  matches(path: string): boolean;
  covers(path: string): boolean;
}

export function pathMatcher(segments: readonly string[]): PathMatcher {
  const source = patternSource(segments);
  const exact = new RegExp(`^${source}$`);
  const prefix = new RegExp(`^${source}(?:\\.|$)`);
  return {
    text: segments.join('.'),
    wildcarded: segments.some(hasWildcard),
    matches: path => exact.test(path),
    covers: path => prefix.test(path),
  };
}

// ---------------------------------------------------------------------------
// `until` dates
// ---------------------------------------------------------------------------

/** A date the way an `until` branch spells it, plus a comparable number. */
export interface ModifierDate {
  month: number;
  day: number;
  year: number;
  /** `YYYYMMDD`, so two dates compare with `<`. */
  value: number;
}

/** Why a date text is not one. `format` is a spelling the BNF does not allow,
 * `range` is three integers that name no day. */
export type DateProblem = 'format' | 'range';

export const isDateProblem = (date: ModifierDate | DateProblem): date is DateProblem => typeof date === 'string';

const DATE = /^(\d{1,2})-(\d{1,2})-(\d{1,4})$/;
const daysInMonth = (month: number, year: number): number =>
  [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/**
 * `MM-DD-YYYY`, which the BNF does not say and the worked example does.
 *
 * The BNF is only `INT "-" INT "-" INT`. The chapter's own example settles the
 * order: `until 1-31-2014;` could be read either way, but the `elseuntil
 * 04-30-2014;` under it cannot — there is no thirtieth month. One- and
 * two-digit months and days are accepted, since the example writes both.
 *
 * An out-of-range value is *not* silently re-read as `DD-MM-YYYY`. The two
 * orders disagree on exactly the dates a typo produces, and a modifier that
 * quietly applied on a different day than it was written for is worse than one
 * that is reported: `range` is returned and the branch matches nothing.
 */
export function parseDate(text: string): ModifierDate | DateProblem {
  const match = DATE.exec(text.replace(/\s+/g, ''));
  if (!match) return 'format';
  const [month, day, year] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) return 'range';
  return { month, day, year, value: year * 10000 + month * 100 + day };
}

/** Today, in the same `YYYYMMDD` shape a parsed date compares in. Local time:
 * an `until` date is a calendar day in the reader's own calendar. */
export const dateValueOf = (date: Date): number =>
  date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();

/** One branch of an `until` block, with its date already read. */
export interface UntilBranch {
  node: PlanNode & { kind: 'branch' };
  kind: 'until' | 'elseuntil' | 'else';
  /** Absent for `else`, which carries no date. */
  date?: ModifierDate | DateProblem;
}

export interface UntilBlock {
  node: PlanNode;
  branches: UntilBranch[];
}

/** Every `until` block in a document, with its branches in written order. */
export function untilBlocks(model: PlanDocument): UntilBlock[] {
  const blocks: UntilBlock[] = [];
  for (const node of model.nodes) {
    if (node.kind !== 'until') continue;
    blocks.push({
      node,
      branches: node.children.filter((child): child is PlanNode & { kind: 'branch' } => child.kind === 'branch')
        .map(child => ({
          node: child,
          kind: child.branchKind,
          date: child.branchKind === 'else' ? undefined : parseDate(runText(child.date)),
        })),
    });
  }
  return blocks;
}

/**
 * The branch of `block` that applies on `today`, or undefined when none does.
 *
 * A dated branch is live while the date has not passed — the chapter's example
 * reads `until 1-31-2014;` as "applied before 1/31/2014" and the branch under
 * it as "applied between 2/1/2014 - 4/30/2014", so the named day itself still
 * belongs to the branch that names it. The first live branch wins, the `else`
 * catches what is left, and a branch whose date could not be read is skipped
 * rather than guessed at.
 */
export function liveBranch(block: UntilBlock, today: number): UntilBranch | undefined {
  for (const branch of block.branches) {
    if (branch.kind === 'else') return branch;
    if (branch.date && !isDateProblem(branch.date) && today <= branch.date.value) return branch;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Modifier statements
// ---------------------------------------------------------------------------

/**
 * One `plan.feature. … .name = value;` statement.
 *
 * `scope` is the path in front of the name. It is empty for a statement written
 * inside an `override` block inside a plan (`override o; Priority = 5;
 * endoverride`), which names that plan's own declaration and applies to every
 * instance of it — the one shape the BNF does not spell but WS0 accepts,
 * because the chapter puts modifier blocks in their own file and the fixtures
 * nest them inside `plan`.
 */
export interface OverrideStatement {
  node: AssignmentNode;
  /** The `override o;` block this was written in; '' at file top level. */
  label: string;
  path?: Reference;
  scope: readonly string[];
  /** The plan the statement is written inside, when `scope` is empty. */
  plan?: string;
  name: string;
  nameRun: TokenRun;
  value: TokenRun;
  /** The `until` branch this statement is conditional on, if any. */
  branch?: PlanNode;
}

export interface FilterStatement {
  node: PlanNode & { kind: 'keep' | 'remove' };
  label: string;
  /** `keep` narrows the selection to the features the expression accepts;
   * `remove` drops the ones it accepts. */
  keep: boolean;
  condition: TokenRun;
  goal: ParsedGoal;
  branch?: PlanNode;
}

export interface ModifierStatements {
  overrides: OverrideStatement[];
  filters: FilterStatement[];
}

/** The `until` branch a statement sits in, or undefined. A branch is the only
 * thing between a modifier statement and its block that changes whether it
 * applies at all. */
function enclosingBranch(model: PlanDocument, node: PlanNode): PlanNode | undefined {
  for (let parent = model.parent(node); parent; parent = model.parent(parent)) {
    if (parent.kind === 'branch') return parent;
    if (parent.kind === 'plan' || parent.kind === 'feature') return undefined;
  }
  return undefined;
}

const blockLabel = (model: PlanDocument, node: PlanNode, kind: 'override' | 'filter'): string =>
  nameToken(model.enclosingOf(node, kind))?.text ?? '';

/**
 * Every modifier statement in a document, in the order they execute.
 *
 * `model.nodes` is already in document order, so one pass over it gives the
 * sequence the chapter says Verification Planner runs ("execute each statement
 * sequentially") without a second sort.
 */
export function modifierStatements(model: PlanDocument): ModifierStatements {
  const overrides: OverrideStatement[] = [];
  const filters: FilterStatement[] = [];
  for (const node of model.nodes) {
    if (node.kind === 'keep' || node.kind === 'remove') {
      filters.push({
        node, label: blockLabel(model, node, 'filter'), keep: node.kind === 'keep', condition: node.condition,
        goal: parseGoal(model.source, node.condition.tokens, valueSpan(node.condition, node.header)),
        branch: enclosingBranch(model, node),
      });
      continue;
    }
    if (node.kind !== 'assignment') continue;
    const path = model.overridePath(node);
    const block = model.enclosingOf(node, 'override');
    if (!path && !block) continue;
    const segments = node.target.segments;
    const nameRun = segments[segments.length - 1];
    overrides.push({
      node,
      label: nameToken(block)?.text ?? '',
      path,
      scope: path ? segments.slice(0, -1).map(runText) : [],
      plan: path ? undefined : nameToken(model.enclosingOf(node, 'plan'))?.text,
      name: runText(nameRun),
      nameRun,
      value: node.value,
      branch: enclosingBranch(model, node),
    });
  }
  return { overrides, filters };
}

// ---------------------------------------------------------------------------
// The hierarchy a path resolves against
// ---------------------------------------------------------------------------

/** One addressable scope: a plan instance, or a feature inside one. */
export interface ScopePath {
  /** Dotted path, exactly what `objectPath` would produce for this scope. */
  path: string;
  instance: PlanInstance;
  /** Absent for the plan instance itself. */
  feature?: PlanNode;
}

/** The cap is the same kind of guard `instantiate` carries: a wide hierarchy
 * times a deep feature tree must not turn a lint into an out-of-memory. */
const MAX_SCOPES = 200000;

const universes = new WeakMap<WorkspaceIndex, readonly ScopePath[]>();

/**
 * Every scope an override path can name, memoized per index.
 *
 * Memoized rather than rebuilt: the index object is replaced whenever the
 * workspace changes (`WorkspaceFiles.invalidate`), so a `WeakMap` keyed by it
 * expires on its own and never has to be told to. That is what keeps the
 * feature walk off the lint path for the second and every later document.
 */
export function scopeUniverse(index: WorkspaceIndex): readonly ScopePath[] {
  const cached = universes.get(index);
  if (cached) return cached;
  const scopes: ScopePath[] = [];
  for (const instance of index.instances()) {
    const base = [...instance.path, instance.plan.name].join('.');
    scopes.push({ path: base, instance });
    if (scopes.length >= MAX_SCOPES) break;
    const visit = (nodes: readonly PlanNode[]): void => {
      for (const node of nodes) {
        if (node.kind !== 'feature') continue;
        if (scopes.length >= MAX_SCOPES) return;
        scopes.push({ path: `${base}.${featurePath(instance.plan.model, node)}`, instance, feature: node });
        visit(node.children);
      }
    };
    visit(instance.plan.node.children);
    if (scopes.length >= MAX_SCOPES) break;
  }
  universes.set(index, scopes);
  return scopes;
}

/** How a path failed to name anything, for the diagnostic that says so. */
export type PathProblem =
  | { kind: 'wildcard-name' }
  | { kind: 'unknown-plan'; plan: string }
  | { kind: 'unresolved' }
  | { kind: 'unknown-target'; plans: readonly string[] };

export interface ResolvedOverride {
  statement: OverrideStatement;
  /** Scopes the path names, in hierarchy order. Empty when it names none. */
  scopes: readonly ScopePath[];
  /** The declaration the last segment names. A path with a wildcard in it can
   * reach several plans; a name one of them *declares* wins over the built-in
   * of the same name another only inherits, since the declaration is the one
   * that says something the built-in table does not. */
  declaration?: Declaration;
  /** The scope `declaration` was read at, for the hover that names its plan. */
  declaredAt?: ScopePath;
  problem?: PathProblem;
}

/** The plan a scope's declarations are read from: the plan block the scope's
 * instance came from. */
const scopeOfPath = (scope: ScopePath): Scope =>
  scopeOf(scope.instance.plan.model, scope.feature ?? scope.instance.plan.node);

/**
 * A statement's path against the hierarchy.
 *
 * Everything the diagnostics and the preview need about one statement, decided
 * once. A statement with no path (`override o; Priority = 5; endoverride`
 * inside `plan P`) resolves to every instance of `P`, since the file is written
 * once and instantiated as many times as it is used.
 */
export function resolveOverride(index: WorkspaceIndex, statement: OverrideStatement): ResolvedOverride {
  const universe = scopeUniverse(index);
  if (hasWildcard(statement.name)) return { statement, scopes: [], problem: { kind: 'wildcard-name' } };
  const matcher = statement.scope.length ? pathMatcher(statement.scope) : undefined;
  const scopes = matcher
    ? universe.filter(scope => matcher.matches(scope.path))
    : universe.filter(scope => !scope.feature && scope.instance.plan.name === statement.plan);
  if (!scopes.length) {
    // Nothing in the workspace instantiates it, or the path names a scope that
    // is not there. The first segment is the only part the BNF guarantees is a
    // plan name, so saying which of the two it is costs one lookup.
    const first = statement.scope[0] ?? statement.plan ?? '';
    const problem: PathProblem = first && !hasWildcard(first) && !index.plans(first).length
      ? { kind: 'unknown-plan', plan: first } : { kind: 'unresolved' };
    return { statement, scopes, problem };
  }
  const found = scopes.map(scope => ({ scope, declaration: lookup(scopeOfPath(scope), statement.name) }))
    .filter((entry): entry is { scope: ScopePath; declaration: Declaration } => !!entry.declaration);
  const best = found.find(entry => !entry.declaration.builtin) ?? found[0];
  if (!best) {
    const plans = [...new Set(scopes.map(scope => scope.instance.plan.name))];
    return { statement, scopes, problem: { kind: 'unknown-target', plans } };
  }
  return { statement, scopes, declaration: best.declaration, declaredAt: best.scope };
}

// ---------------------------------------------------------------------------
// Applying the modifiers
// ---------------------------------------------------------------------------

/** What `ResolutionContext.overrides` takes: the resolver applies these last,
 * in order, so the final one for a name is the one in force. */
export interface OverrideValue {
  name: string;
  text: string;
  label: string;
}

export interface FilterRemoval {
  /** The `filter my_view;` block that removed the feature. */
  label: string;
  statement: FilterStatement;
}

/**
 * The modifiers a preview applies, already resolved.
 *
 * Built once per index and configuration and held by the server, never on a
 * hover or completion request: resolving a path walks every scope in the
 * workspace, and the answers below are lookups over what that walk produced.
 */
export interface ModifierEvaluation {
  /** The documents whose modifiers are applied. */
  readonly files: readonly string[];
  /** The evaluation date, `YYYYMMDD`. */
  readonly today: number;
  readonly resolved: readonly ResolvedOverride[];
  /** Overrides in force at a hierarchy path, in application order. */
  overridesAt(path: string, scope: Scope): OverrideValue[];
  /**
   * The filter statement that dropped a feature with these values, or
   * undefined.
   *
   * Values rather than a path, because a filter selects on what a feature *is*
   * and not on where it sits: `remove feature where phase > 2;` names no scope,
   * and the chapter gives it none — it applies to every feature in the view.
   */
  removalOf(values: (name: string) => string | undefined): FilterRemoval | undefined;
  /** Whether an `until` branch is the live one. Unknown branches — a document
   * outside the evaluated set — stay live, which is the pre-WS7 behaviour. */
  branchIsLive(branch: PlanNode): boolean;
}

export interface ModifierSettings {
  /** URIs of the modifier files to apply. Empty means the preview is off. */
  files?: readonly string[];
  /** Evaluation date, `MM-DD-YYYY`; today when omitted or unreadable. */
  date?: string;
  /** Today, for the default above. Injected so nothing in core reads a clock. */
  /** The day branch liveness is read against. Required for the same reason
   * `ModifierWorkspaceOptions.now` is: core owns no clock. */
  now: Date;
}

/**
 * Resolves the configured modifier files against the workspace.
 *
 * Returns undefined when no file is configured — the preview is off by default,
 * and an evaluation nothing asked for would silently change what every hover
 * says.
 */
export function evaluateModifiers(index: WorkspaceIndex, settings: ModifierSettings): ModifierEvaluation | undefined {
  const files = (settings.files ?? []).filter(uri => index.document(uri));
  if (!files.length) return undefined;
  const configured = settings.date ? parseDate(settings.date) : undefined;
  const today = configured && !isDateProblem(configured)
    ? configured.value : dateValueOf(settings.now);

  // Branch liveness is read across the *whole* workspace, not just the modifier
  // files: an `until` inside a plan decides which of its assignments applies,
  // and that plan is not a modifier file (see `resolver.ts`, which looked
  // through every branch until this date existed).
  const live = new Map<PlanNode, boolean>();
  for (const { model } of index.documents()) {
    for (const block of untilBlocks(model)) {
      const winner = liveBranch(block, today);
      for (const branch of block.branches) live.set(branch.node, branch === winner);
    }
  }
  const branchIsLive = (branch: PlanNode): boolean => live.get(branch) ?? true;

  const resolved: ResolvedOverride[] = [];
  const filters: FilterStatement[] = [];
  for (const uri of files) {
    const { model } = index.document(uri)!;
    const statements = modifierStatements(model);
    for (const statement of statements.overrides) {
      if (statement.branch && !branchIsLive(statement.branch)) continue;
      resolved.push(resolveOverride(index, statement));
    }
    for (const filter of statements.filters) {
      if (!filter.branch || branchIsLive(filter.branch)) filters.push(filter);
    }
  }

  const applicable = resolved.filter(entry => entry.scopes.length && entry.declaration);
  return {
    files,
    today,
    resolved,
    branchIsLive,
    overridesAt(path, scope) {
      const values: OverrideValue[] = [];
      for (const entry of applicable) {
        // An annotation value is not passed down the hierarchy — the chapter
        // states that as the one exception to propagation — so it applies only
        // where the path lands. An attribute or a metric goal reaches every
        // scope below it, which is what makes a later ancestor override
        // supersede an earlier descendant one.
        const kind = lookup(scope, entry.statement.name)?.kind ?? entry.declaration!.kind;
        const local = kind === 'annotation';
        const hit = entry.scopes.some(candidate => local ? candidate.path === path : covers(candidate.path, path));
        if (hit) values.push({ name: entry.statement.name, text: overrideText(entry), label: overrideLabel(entry) });
      }
      return values;
    },
    removalOf(values) {
      let removed: FilterRemoval | undefined;
      for (const filter of filters) {
        const verdict = evaluateFilter(filter, values);
        if (verdict === undefined) continue; // Not modelled: the feature stays.
        if (filter.keep ? !verdict : verdict) removed ??= { label: filter.label, statement: filter };
      }
      return removed;
    },
  };
}

const covers = (scope: string, path: string): boolean => path === scope || path.startsWith(`${scope}.`);

/** A goal override keeps its raw source slice so the expression reads back as
 * written; every other value joins its tokens. The same rule `resolver.ts`
 * applies to an assignment, stated once more because the value here never went
 * through `resolveDeclaration`. */
const overrideText = (entry: ResolvedOverride): string =>
  entry.declaration?.kind === 'metric' ? entry.statement.value.text : runText(entry.statement.value);

const overrideLabel = (entry: ResolvedOverride): string =>
  entry.statement.label ? `override ${entry.statement.label}` : 'override';

// ---------------------------------------------------------------------------
// Filter expressions
// ---------------------------------------------------------------------------

/** What a filter expression evaluates to. `undefined` is "this expression is
 * not modelled here", and every caller reads it as "change nothing". */
export type FilterValue = number | string | boolean | undefined;

/** An attribute value as the filter compares it: a quoted string contributes
 * its contents, a number its value, an enum member its own name. */
export function filterValue(text: string): FilterValue {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return trimmed.slice(1, -1);
  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1));
    return Number.isFinite(percent) ? percent / 100 : undefined;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : trimmed;
}

/** Whether the statement's expression accepts a feature with these values, or
 * undefined when the expression names something the model cannot supply. */
export function evaluateFilter(filter: FilterStatement,
                               values: (name: string) => string | undefined): boolean | undefined {
  if (filter.goal.problems.length) return undefined;
  const result = evaluateNode(filter.goal.expression, values);
  return typeof result === 'boolean' ? result : undefined;
}

function evaluateNode(node: GoalNode, values: (name: string) => string | undefined): FilterValue {
  switch (node.kind) {
    case 'literal': return filterValue(node.text);
    case 'name': {
      const text = values(node.text);
      return text === undefined ? undefined : filterValue(text);
    }
    case 'unary': {
      const operand = evaluateNode(node.operand, values);
      if (node.op === '!') return typeof operand === 'boolean' ? !operand : undefined;
      if (typeof operand !== 'number') return undefined;
      return node.op === '-' ? -operand : operand;
    }
    case 'binary': return evaluateBinary(node.op, evaluateNode(node.left, values), evaluateNode(node.right, values));
    // `match(...)`, `inside {...}` and anything the parser recovered from are
    // documented as unsupported; the statement they appear in changes nothing.
    default: return undefined;
  }
}

function evaluateBinary(op: string, left: FilterValue, right: FilterValue): FilterValue {
  if (left === undefined || right === undefined) return undefined;
  if (op === '||' || op === '&&') {
    if (typeof left !== 'boolean' || typeof right !== 'boolean') return undefined;
    return op === '||' ? left || right : left && right;
  }
  if (op === '==' || op === '!=') {
    const equal = String(left) === String(right);
    return op === '==' ? equal : !equal;
  }
  if (typeof left !== 'number' || typeof right !== 'number') return undefined;
  switch (op) {
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right === 0 ? undefined : left / right;
    default: return undefined;
  }
}

/**
 * The scope a filter expression's names are read in.
 *
 * A filter block written inside a plan names that plan's attributes and
 * annotations. One written in a modifier file names the attributes of whatever
 * plan the file modifies, which nothing in the file says — so there is no scope
 * and, per the workstream's rule, no diagnostic either.
 */
export function filterScope(model: PlanDocument, node: PlanNode): Scope | undefined {
  return model.enclosingOf(node, 'plan') ? scopeOf(model, node) : undefined;
}

/** Whether a name in a filter expression is one the chapter says is
 * interpreted: "any identifier other than an attribute or annotation name is
 * not interpreted". */
export const filterIdentifier = (scope: Scope, name: string): Declaration | undefined => {
  const declaration = lookup(scope, name);
  return declaration && declaration.kind !== 'metric' ? declaration : undefined;
};

/** The literal type of an operand, for the filter's own operand checks. Only
 * what `values.ts` classifies confidently; everything else is `undefined` and
 * silences the check. */
export function filterOperandType(node: GoalNode, scope: Scope | undefined): 'number' | 'string' | undefined {
  if (node.kind === 'literal') {
    return node.type === 'string' ? 'string' : ['integer', 'real', 'percent'].includes(node.type) ? 'number' : undefined;
  }
  if (node.kind !== 'name' || !scope) return undefined;
  const declaration = filterIdentifier(scope, node.text);
  if (!declaration) return undefined;
  if (declaration.type === 'string') return 'string';
  return ['integer', 'real', 'percent', 'ratio'].includes(declaration.type) ? 'number' : undefined;
}

// ---------------------------------------------------------------------------
// Completing a path
// ---------------------------------------------------------------------------

/** What can follow the segments already typed in an override path. */
export interface PathCompletions {
  /** Plan and feature names that continue the path. */
  segments: string[];
  /** Declarations the path could end on, from the plans it already reaches. */
  declarations: Declaration[];
}

/**
 * The next segment of an override path, from the instantiated hierarchy.
 *
 * `typed` is the segments before the cursor, wildcards and all — matched with
 * the same `pathMatcher` the resolution uses, so a half-written `top.**.` is
 * offered the names a finished `top.**.x` would resolve against rather than a
 * second, looser rule. With nothing typed yet the answer is the plan names the
 * hierarchy starts at, which is the only thing the BNF allows there.
 */
export function pathCompletions(index: WorkspaceIndex, typed: readonly string[]): PathCompletions {
  const universe = scopeUniverse(index);
  const segments = new Set<string>();
  const declarations = new Map<string, Declaration>();
  const matcher = typed.length ? pathMatcher(typed) : undefined;
  for (const scope of universe) {
    const parts = scope.path.split('.');
    if (!matcher) {
      if (!scope.feature) segments.add(parts[0]);
      continue;
    }
    // The next name: every scope the typed prefix covers contributes the
    // segment that follows it.
    if (parts.length > typed.length && matcher.matches(parts.slice(0, typed.length).join('.'))) {
      segments.add(parts[typed.length]);
    }
    // The last segment is a declaration of whatever plan the path landed on.
    if (matcher.matches(scope.path)) {
      for (const declaration of scopeOfPath(scope).declarations.values()) {
        if (!declarations.has(declaration.name)) declarations.set(declaration.name, declaration);
      }
    }
  }
  return { segments: [...segments].sort(), declarations: [...declarations.values()] };
}

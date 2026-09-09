/**
 * WS6: definition, references and rename over the plan model.
 *
 * Everything here is built on one idea: a position resolves to a *target* — a
 * declaration, a plan, or an enum member — and a target resolves to the set of
 * document ranges that mean it. Definition takes the declaring ranges out of
 * that set, references takes all of them, and rename rewrites them. Three
 * providers, one search, so they cannot disagree about what an occurrence is.
 *
 * The search is deliberately closed rather than textual. A name declared in
 * plan `P` means something only inside `P`'s own blocks, in a `#(name=...)`
 * parameter list on a `subplan P` statement, and at the end of an override path
 * whose plan resolves to `P`. Anything else spelled the same way is a different
 * declaration in a different plan, and a rename that touched it would corrupt a
 * file — so the walk asks which plan every candidate belongs to instead of
 * matching text.
 *
 * Editor-agnostic like the rest of `src/core`: no `vscode`, no disk, and the
 * cross-file half comes from the injected `WorkspaceIndex`.
 */
import { Location, Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver-types';
import { Declaration, DeclarationKind, Scope, lookup, metricIn, scopeOf } from './declarations';
import { parseGoal, walkGoal } from './goals';
import { OBJPATH, isValidIdentifier } from './keywords';
import { PlanDocument, PlanNode, TokenRun, nameToken, runText } from './planModel';
import { isTerminated, parseSourceExpression, sourceLiterals, sourceStringAt } from './sourceExpressions';
import { Span, covers } from './tokenizer';
import { IndexedDocument, WorkspaceIndex, subplanTargets } from './workspace';
import { literal } from './values';

/** The two optional halves every navigation provider takes. `uri` names the
 * document the request was made on — without one, core still answers, but the
 * locations it returns carry an empty URI, so a caller that wants links passes
 * it. `index` is the workspace; without one, only this document is searched. */
export interface NavigationOptions {
  uri?: string;
  index?: WorkspaceIndex;
}

export interface DeclarationTarget {
  kind: 'declaration';
  name: string;
  declarationKind: DeclarationKind;
  declaration: Declaration;
  /** Plan the name belongs to. Undefined for a declaration written outside any
   * plan, which no other file can address. */
  planName?: string;
  /** Range of the token the cursor was on. */
  range: Range;
}
export interface PlanTarget { kind: 'plan'; name: string; range: Range }
/** A member of an `enum {...}` declaration, which is a name in its own right:
 * it appears in the member list and in every value that selects it. */
export interface EnumMemberTarget {
  kind: 'enum-member';
  name: string;
  owner: DeclarationTarget;
  range: Range;
}
export type NavigationTarget = DeclarationTarget | PlanTarget | EnumMemberTarget;

/** One place a target is written. `declaration` marks the defining occurrence,
 * which is what Go to Definition returns and what references may exclude. */
export interface Occurrence {
  uri: string;
  range: Range;
  declaration: boolean;
}

/**
 * The occurrences of a target, and what a rename would have to touch but the
 * model cannot vouch for.
 *
 * The problems are collected during the same walk that finds the occurrences,
 * and are fatal to a rename rather than merely reported: a partial rename
 * silently changes what a file means, which is worse than refusing.
 */
export interface OccurrenceSet {
  occurrences: Occurrence[];
  problems: string[];
}

const WILDCARD = /[*?]/;


const planNameOf = (model: PlanDocument, node: PlanNode): string | undefined =>
  nameToken(model.enclosingOf(node, 'plan'))?.text;

const declarationTarget = (declaration: Declaration, planName: string | undefined,
                           range: Range): DeclarationTarget =>
  ({ kind: 'declaration', name: declaration.name, declarationKind: declaration.kind, declaration, planName, range });

// ---------------------------------------------------------------------------
// What is under the cursor
// ---------------------------------------------------------------------------

/**
 * The target at `offset`, or undefined when the position names nothing.
 *
 * The mask kind is asked first and dispatched on, the way `hover` and
 * `completion` do: a comment and a plain string literal are holes, and a
 * `source` string is not — WS4 models `${name}` inside it with real ranges, so
 * an interpolation is a first-class occurrence rather than a text match.
 */
export function targetAt(model: PlanDocument, offset: number,
                         options: NavigationOptions = {}): NavigationTarget | undefined {
  const mask = model.maskAt(offset);
  if (mask === 'comment' || mask === 'string') return undefined;
  if (mask === 'source-string') return interpolationTarget(model, offset);
  const node = model.nodeAt(offset);
  if (!node) return undefined;
  const name = nameToken(node);
  const named = (): DeclarationTarget | undefined => {
    const declaration = name && lookup(scopeOf(model, node), name.text);
    return declaration ? declarationTarget(declaration, planNameOf(model, node), name!.range) : undefined;
  };
  switch (node.kind) {
    case 'plan':
      return name && covers(name, offset) ? { kind: 'plan', name: name.text, range: name.range } : undefined;
    case 'subplan':
      if (name && covers(name, offset)) return { kind: 'plan', name: name.text, range: name.range };
      return subplanParameterTarget(node, offset, options);
    case 'attribute': case 'annotation': {
      if (name && covers(name, offset)) return named();
      const owner = enumOwner(model, node);
      if (!owner) return undefined;
      const member = node.type.members.find(m => covers(m.name, offset));
      if (member) return { kind: 'enum-member', name: runText(member.name), owner, range: member.name.range };
      return memberValueTarget(owner, node.value, offset);
    }
    case 'metric': {
      if (name && covers(name, offset)) return named();
      // An `aggregate {...}` member names another metric; an `enum` metric's
      // members are counted values, which only a goal expression can name.
      const member = node.type.members.find(m => covers(m.name, offset));
      const declaration = member && metricIn(scopeOf(model, node), runText(member.name));
      return declaration ? declarationTarget(declaration, planNameOf(model, node), member!.name.range) : undefined;
    }
    case 'measure': {
      const reference = node.metrics.find(run => covers(run, offset));
      const declaration = reference && metricIn(scopeOf(model, node), runText(reference));
      return declaration ? declarationTarget(declaration, planNameOf(model, node), reference!.range) : undefined;
    }
    case 'goal': {
      const metric = model.enclosingOf(node, 'metric');
      const token = metric && nameToken(metric);
      const declaration = token && lookup(scopeOf(model, node), token.text);
      if (declaration?.kind !== 'metric') return undefined;
      return goalTarget(model, node.value, node.header, offset, declaration,
        scopeOf(model, node), planNameOf(model, node));
    }
    case 'assignment':
      return assignmentTarget(model, node, offset, options);
    default:
      return undefined;
  }
}

/** A `${name}` inside a `source` string. WS4 already gives the name its own
 * document span, so this never re-scans the literal. */
function interpolationTarget(model: PlanDocument, offset: number): NavigationTarget | undefined {
  const found = sourceStringAt(model, offset);
  if (!found) return undefined;
  const interpolation = found.expression.interpolations.find(part => covers(part.nameSpan, offset));
  if (!interpolation?.name || interpolation.name === OBJPATH) return undefined;
  const declaration = lookup(scopeOf(model, found.statement), interpolation.name);
  // A metric is never substitutable (resolver.ts states that rule once), so
  // `${Line}` names nothing even though `Line` is declared.
  if (!declaration || declaration.kind === 'metric') return undefined;
  return declarationTarget(declaration, planNameOf(model, found.statement), interpolation.nameSpan.range);
}

/** The declaration target for an `enum` attribute or annotation, so its member
 * list and its values can point back at it. */
function enumOwner(model: PlanDocument,
                   node: PlanNode & { kind: 'attribute' | 'annotation' }): DeclarationTarget | undefined {
  const name = nameToken(node);
  if (node.type.name?.text !== 'enum' || !name) return undefined;
  const declaration = lookup(scopeOf(model, node), name.text);
  // Only the declaration that actually won the name: a duplicate declares the
  // same members over again but is not what the rest of the plan resolves to.
  return declaration?.node === node ? declarationTarget(declaration, planNameOf(model, node), name.range) : undefined;
}

/** An identifier value that selects one of `owner`'s enum members. */
function memberValueTarget(owner: DeclarationTarget, value: TokenRun, offset: number): EnumMemberTarget | undefined {
  if (!covers(value, offset)) return undefined;
  const text = literal(value);
  if (text.kind !== 'identifier' || !owner.declaration.members.includes(text.text)) return undefined;
  return { kind: 'enum-member', name: text.text, owner, range: value.range };
}

function subplanParameterTarget(node: PlanNode & { kind: 'subplan' }, offset: number,
                                options: NavigationOptions): NavigationTarget | undefined {
  const parameter = node.parameters.find(p => covers(p, offset));
  const entry = options.index ? subplanTargets(options.index, node)[0] : undefined;
  if (!parameter || !entry) return undefined;
  const declaration = lookup(scopeOf(entry.model, entry.node), runText(parameter.name));
  if (!declaration) return undefined;
  const owner = declarationTarget(declaration, entry.name, parameter.name.range);
  if (covers(parameter.name, offset)) return owner;
  return memberValueTarget(owner, parameter.value, offset);
}

function assignmentTarget(model: PlanDocument, node: PlanNode & { kind: 'assignment' }, offset: number,
                          options: NavigationOptions): NavigationTarget | undefined {
  if (model.overridePath(node)) return overridePathTarget(model, node, offset, options);
  const scope = scopeOf(model, node);
  const declaration = lookup(scope, runText(node.target));
  if (!declaration) return undefined;
  const planName = planNameOf(model, node);
  if (covers(node.target, offset)) return declarationTarget(declaration, planName, node.target.range);
  if (declaration.kind === 'metric') {
    return goalTarget(model, node.value, node.header, offset, declaration, scope, planName);
  }
  return memberValueTarget(declarationTarget(declaration, planName, node.target.range), node.value, offset);
}

/**
 * An `override`/`filter` path: `plan.feature. … .name = value`.
 *
 * The chapter's BNF makes the first segment a plan and the last an attribute,
 * annotation or metric; the segments between are plans or features and may
 * carry Table 5's wildcards. Only the two ends are resolved here — a middle
 * segment names a feature of a plan the path has not finished identifying, and
 * a wildcard names several — which is the whole of what WS6's deliverable asks
 * for ("plans, from `subplan` statements and override paths").
 */
function overridePathTarget(model: PlanDocument, node: PlanNode & { kind: 'assignment' }, offset: number,
                            options: NavigationOptions): NavigationTarget | undefined {
  const { segments } = node.target;
  const first = segments[0], last = segments[segments.length - 1];
  if (covers(first, offset)) {
    const text = runText(first);
    return WILDCARD.test(text) ? undefined : { kind: 'plan', name: text, range: first.range };
  }
  const planName = pathPlanName(options.index, segments.slice(0, -1).map(runText));
  const entry = planName && options.index ? options.index.plans(planName)[0] : undefined;
  if (!entry) return undefined;
  const scope = scopeOf(entry.model, entry.node);
  const declaration = lookup(scope, runText(last));
  if (!declaration) return undefined;
  if (covers(last, offset)) return declarationTarget(declaration, planName, last.range);
  if (declaration.kind === 'metric') {
    return goalTarget(model, node.value, node.header, offset, declaration, scope, planName);
  }
  return memberValueTarget(declarationTarget(declaration, planName, last.range), node.value, offset);
}

/**
 * The plan an override path addresses.
 *
 * The path is matched against the instantiated hierarchy, longest prefix
 * winning, so `topplan.subplan1.mem.owner` lands in whatever plan `subplan1`
 * instantiates rather than in `topplan`. With nothing matching — a plan
 * addressed before anything instantiates it — the first segment is the answer,
 * which is the only part of the path the BNF guarantees is a plan name.
 *
 * Exported for WS8c: a semantic token on the last segment of an override path
 * asserts which declaration it names, and that must be the same answer
 * definition gives — one rule, not a colour and a jump that disagree.
 */
export function pathPlanName(index: WorkspaceIndex | undefined, names: readonly string[]): string | undefined {
  if (!names.length || WILDCARD.test(names[0])) return undefined;
  let best = names[0], matched = 1;
  if (index) {
    for (const instance of index.instances()) {
      const full = [...instance.path, instance.plan.name];
      if (full.length <= matched || full.length > names.length) continue;
      if (full.every((segment, i) => segment === names[i])) { matched = full.length; best = instance.plan.name; }
    }
  }
  return best;
}

/**
 * An identifier inside a goal expression.
 *
 * A goal may name the metric it belongs to, another metric, or one of that
 * metric's members — bare or as `metric.member` (`metrics.ts` states the rule).
 * Only the two spellings whose text can be located exactly in the source are
 * answered: the leading identifier and a trailing `.member`, each verified
 * against the document text before a range is produced, since `parseGoal` joins
 * a dotted name and the whitespace between its parts is not recoverable from
 * the joined string.
 */
function goalTarget(model: PlanDocument, value: TokenRun, header: Span, offset: number, metric: Declaration,
                    scope: Scope, planName: string | undefined): NavigationTarget | undefined {
  for (const goal of goalNames(model, value, header)) {
    if (!(goal.span.start <= offset && offset <= goal.span.end)) continue;
    const headEnd = goal.span.start + goal.head.length;
    if (offset <= headEnd) {
      const range = model.source.span(goal.span.start, headEnd).range;
      const declaration = metricIn(scope, goal.head);
      if (declaration) return declarationTarget(declaration, planName, range);
      return memberTarget(metric, goal.head, planName, range);
    }
    if (!goal.tail) return undefined;
    const tailStart = goal.span.end - goal.tail.length;
    if (offset < tailStart) return undefined;
    const owner = metricIn(scope, goal.head) ?? metric;
    const range = model.source.span(tailStart, goal.span.end).range;
    // An `aggregate` member is a metric of its own; an `enum` member is a value.
    const submetric = owner.type === 'aggregate' ? metricIn(scope, goal.tail) : undefined;
    if (submetric) return declarationTarget(submetric, planName, range);
    return memberTarget(owner, goal.tail, planName, range);
  }
  return undefined;
}

function memberTarget(metric: Declaration, member: string, planName: string | undefined,
                      range: Range): NavigationTarget | undefined {
  if (metric.type !== 'enum' || !metric.members.includes(member)) return undefined;
  return { kind: 'enum-member', name: member, owner: declarationTarget(metric, planName, range), range };
}

export interface GoalName { span: Span; head: string; tail?: string }

/** Every identifier a goal expression names, with the leading and trailing
 * segment of a dotted one, verified against the document text so a range is
 * produced only where the spelling is unambiguous.
 *
 * Exported for WS8c, which colours the same identifiers: which spellings are
 * locatable at all is a judgement about `parseGoal`'s joined text, and stating
 * it twice would let a rename and a colour land on different characters. */
export function goalNames(model: PlanDocument, value: TokenRun, header: Span): GoalName[] {
  if (!value.tokens.length) return [];
  const found: GoalName[] = [];
  for (const goal of walkGoal(parseGoal(model.source, value.tokens, header).expression)) {
    if (goal.kind !== 'name') continue;
    const parts = goal.text.split('.');
    const head = parts[0];
    const tail = parts.length > 1 ? parts[parts.length - 1] : undefined;
    if (model.source.text.slice(goal.span.start, goal.span.start + head.length) !== head) continue;
    found.push({
      span: goal.span,
      head,
      tail: tail && model.source.text.slice(goal.span.end - tail.length, goal.span.end) === tail ? tail : undefined,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Where a target is written
// ---------------------------------------------------------------------------

/** The documents a search runs over: the workspace when there is an index, and
 * always the caller's own model for its URI, since the index may hold a copy
 * one version behind the request being served. */
function searchSet(model: PlanDocument, options: NavigationOptions): readonly IndexedDocument[] {
  const uri = options.uri ?? '';
  const documents = options.index?.documents();
  if (!documents?.length) return [{ uri, model }];
  if (documents.some(document => document.uri === uri)) {
    return documents.map(document => (document.uri === uri ? { uri, model } : document));
  }
  // A caller that named no URI but whose model the index already holds must not
  // get the same document twice under two names.
  if (documents.some(document => document.model === model)) return documents;
  return [{ uri, model }, ...documents];
}

export function findOccurrences(target: NavigationTarget, model: PlanDocument,
                                options: NavigationOptions = {}): OccurrenceSet {
  const documents = searchSet(model, options);
  if (target.kind === 'plan') return planOccurrences(target, documents);
  if (target.kind === 'enum-member') return memberOccurrences(target, model, documents, options);
  return declarationOccurrences(target, model, documents, options);
}

function collector() {
  const occurrences: Occurrence[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  return {
    problems,
    push(uri: string, range: Range, declaration: boolean, node?: PlanNode) {
      const key = `${uri} ${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (seen.has(key)) return;
      seen.add(key);
      occurrences.push({ uri, range, declaration });
      // A statement the parser recovered from already carries a syntax error and
      // its runs are whatever happened to follow on the line: worth reporting as
      // an occurrence, never safe to rewrite.
      if (node?.incomplete) problems.push(`an unparsed statement at ${where(uri, range.start.line)}`);
    },
    problem(message: string) { problems.push(message); },
    result(): OccurrenceSet {
      occurrences.sort((a, b) => a.uri.localeCompare(b.uri) || a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character);
      return { occurrences, problems };
    },
  };
}

const where = (uri: string, line: number): string => `line ${line + 1}${uri ? ` of ${uri}` : ''}`;

/** A plan is declared by its `plan` block and named by every `subplan`
 * statement and every override path that starts with it. */
function planOccurrences(target: PlanTarget, documents: readonly IndexedDocument[]): OccurrenceSet {
  const set = collector();
  for (const { uri, model } of documents) {
    for (const node of model.nodes) {
      if (node.kind === 'plan') {
        const name = nameToken(node);
        // Root-level blocks only, matching what `workspace.ts` indexes: a plan
        // nested inside another block is not a plan definition the tool loads.
        if (name?.text === target.name && node.parentId === undefined) set.push(uri, name.range, true, node);
      } else if (node.kind === 'subplan') {
        const name = nameToken(node);
        if (name?.text === target.name && model.checkable(node)) set.push(uri, name.range, false, node);
      } else if (node.kind === 'assignment' && model.overridePath(node)) {
        const first = node.target.segments[0];
        if (runText(first) === target.name) set.push(uri, first.range, false, node);
      }
    }
  }
  return set.result();
}

/**
 * Every place an attribute, annotation or metric name is written.
 *
 * Five shapes, and the plan each one belongs to decides whether it counts: the
 * declaration and the statements inside the plan's own blocks, `${name}` inside
 * a `source` string in that plan, a `#(name=...)` parameter on a `subplan`
 * naming the plan, and the last segment of an override path resolving to it.
 */
function declarationOccurrences(target: DeclarationTarget, model: PlanDocument,
                                documents: readonly IndexedDocument[], options: NavigationOptions): OccurrenceSet {
  const set = collector();
  const { name, planName } = target;
  // A declaration outside any plan is addressable from nowhere else, so the
  // search stays inside the document it was written in.
  const local = documents.filter(document => planName !== undefined || document.model === model);
  for (const { uri, model: doc } of local) {
    for (const node of doc.nodes) {
      const home = planNameOf(doc, node) === planName;
      switch (node.kind) {
        case 'attribute': case 'annotation': case 'metric': {
          const token = nameToken(node);
          if (home && token?.text === name && node.kind === target.declarationKind) {
            set.push(uri, token.range, true, node);
          }
          if (home && target.declarationKind === 'metric' && node.kind === 'metric' &&
              node.type.name?.text === 'aggregate') {
            for (const member of node.type.members) {
              if (runText(member.name) === name) set.push(uri, member.name.range, false, node);
            }
          }
          break;
        }
        case 'measure':
          if (home && target.declarationKind === 'metric') {
            for (const reference of node.metrics) {
              if (runText(reference) === name) set.push(uri, reference.range, false, node);
            }
          }
          break;
        case 'goal':
          if (home && target.declarationKind === 'metric') {
            for (const range of goalOccurrences(doc, node.value, node.header, name)) {
              set.push(uri, range, false, node);
            }
          }
          break;
        case 'assignment':
          assignmentOccurrences(doc, node, uri, target, options, set);
          break;
        case 'subplan':
          // A `#(...)` parameter may only set an attribute (workspace.ts states
          // that rule), so nothing else is looked for here.
          if (target.declarationKind !== 'attribute' || nameToken(node)?.text !== planName) break;
          if (!doc.checkable(node)) break;
          for (const parameter of node.parameters) {
            if (runText(parameter.name) === name) set.push(uri, parameter.name.range, false, node);
          }
          break;
        case 'keep': case 'remove':
          // A filter expression names an attribute with no plan in front of it,
          // so nothing says which plan's it is. It is not an occurrence the
          // model resolved, and it is exactly the text a rename must not leave
          // behind — hence a problem rather than an edit.
          if (target.declarationKind !== 'metric' &&
              node.condition.tokens.some(token => token.kind === 'identifier' && token.text === name)) {
            set.problem(`a filter expression at ${where(uri, node.range.start.line)}`);
          }
          break;
      }
    }
    if (target.declarationKind !== 'metric') interpolationOccurrences(doc, uri, target, set);
  }
  return set.result();
}

/** `${name}` inside every `source` string of the plan, plus the two shapes a
 * rename could not see: an unterminated literal, and a plain (non-`source`)
 * string that happens to spell the interpolation. */
function interpolationOccurrences(model: PlanDocument, uri: string, target: DeclarationTarget,
                                  set: ReturnType<typeof collector>): void {
  const needle = '${' + target.name;
  for (const { statement, token } of sourceLiterals(model)) {
    if (planNameOf(model, statement) !== target.planName) continue;
    if (!isTerminated(token)) {
      if (token.text.includes(needle)) {
        set.problem(`an unterminated string at ${where(uri, token.range.start.line)}`);
      }
      continue;
    }
    for (const interpolation of parseSourceExpression(model.source, token).interpolations) {
      if (interpolation.name === target.name) set.push(uri, interpolation.nameSpan.range, false, statement);
    }
  }
  // The linear `nodeAt` scan is behind the text test on purpose: a string that
  // does not spell the interpolation asks the node tree nothing.
  for (const token of model.tokens) {
    if (token.kind !== 'string' || !token.text.includes(needle)) continue;
    const node = model.nodeAt(token.start);
    if (!node || node.kind === 'source' || planNameOf(model, node) !== target.planName) continue;
    set.problem(`a string literal at ${where(uri, token.range.start.line)} `
      + 'that the model does not read as a source expression');
  }
}

function assignmentOccurrences(model: PlanDocument, node: PlanNode & { kind: 'assignment' }, uri: string,
                               target: DeclarationTarget, options: NavigationOptions,
                               set: ReturnType<typeof collector>): void {
  const { segments } = node.target;
  const { name, planName } = target;
  const goals = (): void => {
    if (target.declarationKind !== 'metric') return;
    for (const range of goalOccurrences(model, node.value, node.header, name)) set.push(uri, range, false, node);
  };
  if (!model.overridePath(node)) {
    if (planNameOf(model, node) !== planName || runText(node.target) !== name) return;
    set.push(uri, node.target.range, false, node);
    goals();
    return;
  }
  const last = segments[segments.length - 1];
  if (runText(last) !== name) return;
  const scopes = segments.slice(0, -1).map(runText);
  const wildcarded = scopes.some(segment => WILDCARD.test(segment));
  const resolved = pathPlanName(options.index, scopes);
  if (resolved === planName) {
    set.push(uri, last.range, false, node);
    goals();
    // The path reaches this plan, but a wildcard segment reaches past it too:
    // `top.**.phase` matches a sub-plan's own `phase` as readily as this one's.
    // Harmless while one plan in the workspace declares the name, and not
    // rewritable once two do.
    if (wildcarded && declaringPlans(options.index, name).size > 1) {
      set.problem(`an override path at ${where(uri, node.range.start.line)} whose wildcard can also `
        + `match another plan declaring '${name}'`);
    }
    return;
  }
  // The path spells this name but lands somewhere else — or nowhere the model
  // can pin down. It is a real occurrence only if the plan it *did* resolve to
  // declares the name itself; a wildcard segment (`top_plan.**.MyLine`) can
  // expand into this plan, and a path the walk could not follow to the end
  // resolves to the plan it stopped at rather than to the one that declares
  // the name. Both are refusals, not silent omissions.
  const declared = resolved !== undefined && declaresLocally(options.index, resolved, name);
  if (!declared || wildcarded) {
    set.problem(`an override path at ${where(uri, node.range.start.line)} whose plan could not be resolved`);
  }
}

/** Whether `planName` declares `name` itself, rather than inheriting it from
 * the built-in table every plan shares. */
function declaresLocally(index: WorkspaceIndex | undefined, planName: string, name: string): boolean {
  const entry = index?.plans(planName)[0];
  if (!entry) return false;
  const declaration = lookup(scopeOf(entry.model, entry.node), name);
  return !!declaration && !declaration.builtin;
}

/** Every plan in the workspace that declares `name` itself. One means a
 * wildcard path spelling it can only have meant that plan. */
function declaringPlans(index: WorkspaceIndex | undefined, name: string): Set<string> {
  const names = new Set<string>();
  for (const entry of index?.allPlans() ?? []) {
    if (declaresLocally(index, entry.name, name)) names.add(entry.name);
  }
  return names;
}

/** The metric name inside a goal expression, as its own range: `Line > 85%`
 * mentions `Line`, and `MyAgg.Line` mentions it as the trailing member. */
function goalOccurrences(model: PlanDocument, value: TokenRun, header: Span, name: string): Range[] {
  const ranges: Range[] = [];
  for (const goal of goalNames(model, value, header)) {
    if (goal.head === name) ranges.push(model.source.span(goal.span.start, goal.span.start + name.length).range);
    else if (goal.tail === name) ranges.push(model.source.span(goal.span.end - name.length, goal.span.end).range);
  }
  return ranges;
}

/**
 * An enum member: its entry in the `enum {...}` list, and every value that
 * selects it — the declaration's own default, assignments in the plan, subplan
 * parameters targeting the plan, and override-path values.
 */
function memberOccurrences(target: EnumMemberTarget, model: PlanDocument,
                           documents: readonly IndexedDocument[], options: NavigationOptions): OccurrenceSet {
  const set = collector();
  const owner = target.owner;
  const selects = (run: TokenRun): boolean => {
    const value = literal(run);
    return value.kind === 'identifier' && value.text === target.name;
  };
  const local = documents.filter(document => owner.planName !== undefined || document.model === model);
  for (const { uri, model: doc } of local) {
    for (const node of doc.nodes) {
      const home = planNameOf(doc, node) === owner.planName;
      if (node.kind === 'attribute' || node.kind === 'annotation' || node.kind === 'metric') {
        if (!home || nameToken(node)?.text !== owner.name) continue;
        for (const member of node.type.members) {
          if (runText(member.name) === target.name) set.push(uri, member.name.range, true, node);
        }
        if (node.kind !== 'metric' && selects(node.value)) set.push(uri, node.value.range, false, node);
      } else if (node.kind === 'assignment') {
        const { segments } = node.target;
        const modifier = !!doc.overridePath(node);
        if (runText(segments[segments.length - 1]) !== owner.name || !selects(node.value)) continue;
        if (!modifier) {
          if (home) set.push(uri, node.value.range, false, node);
        } else if (pathPlanName(options.index, segments.slice(0, -1).map(runText)) === owner.planName) {
          set.push(uri, node.value.range, false, node);
        }
      } else if (node.kind === 'subplan' && nameToken(node)?.text === owner.planName && doc.checkable(node)) {
        for (const parameter of node.parameters) {
          if (runText(parameter.name) === owner.name && selects(parameter.value)) {
            set.push(uri, parameter.value.range, false, node);
          }
        }
      }
    }
  }
  return set.result();
}

// ---------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------

const location = (occurrence: Occurrence): Location => Location.create(occurrence.uri, occurrence.range);

/** Where the name under the cursor is declared. A built-in has no declaration
 * site, so the answer is honestly empty rather than the use itself. */
export function provideDefinition(model: PlanDocument, position: Position,
                                  options: NavigationOptions = {}): Location[] {
  const target = targetAt(model, model.source.offsetAt(position), options);
  if (!target) return [];
  return findOccurrences(target, model, options).occurrences.filter(o => o.declaration).map(location);
}

export interface ReferenceOptions extends NavigationOptions {
  /** LSP's `context.includeDeclaration`; default true. */
  includeDeclaration?: boolean;
}

export function provideReferences(model: PlanDocument, position: Position,
                                  options: ReferenceOptions = {}): Location[] {
  const target = targetAt(model, model.source.offsetAt(position), options);
  if (!target) return [];
  const include = options.includeDeclaration !== false;
  return findOccurrences(target, model, options).occurrences
    .filter(occurrence => include || !occurrence.declaration).map(location);
}

/** A refusal carries the sentence the editor shows. Core has no LSP error type
 * to throw — `server.ts` turns this into a `ResponseError`. */
export interface RenameRefusal { error: string }
export interface RenamePreparation { range: Range; placeholder: string }
export type PrepareRenameResult = RenamePreparation | RenameRefusal | undefined;
export type RenameResult = { edit: WorkspaceEdit } | RenameRefusal;

const refusal = (error: string): RenameRefusal => ({ error });
export const isRefusal = (value: unknown): value is RenameRefusal =>
  !!value && typeof (value as RenameRefusal).error === 'string';


/**
 * Whether the position can be renamed at all, and the range the editor should
 * pre-fill.
 *
 * `undefined` means "nothing to rename here" and the editor says so in its own
 * words; a refusal means the position *is* a name but this rename would not be
 * safe, and the sentence says which. Doing the checking half here as well as in
 * `provideRenameEdits` is deliberate: an editor that supports `prepareRename`
 * rejects the position before the user types a new name, and finding out
 * afterwards is worse.
 */
export function prepareRename(model: PlanDocument, position: Position,
                              options: NavigationOptions = {}): PrepareRenameResult {
  const target = targetAt(model, model.source.offsetAt(position), options);
  if (!target) return undefined;
  const checked = renameable(target, options);
  return isRefusal(checked) ? checked : { range: target.range, placeholder: target.name };
}

/**
 * The edits a rename would make, or the reason there are none.
 *
 * The rule is all or nothing. An edit set comes back only when every occurrence
 * of the name is one the model resolved to *this* declaration; if any of them
 * sits in text the model could not attribute — an unresolvable override path, a
 * filter expression naming an attribute with no plan in front of it, an
 * unparsed statement, a string the model does not read as a source expression —
 * the rename is refused. A half-renamed file still parses and still means
 * something, just not what it used to, and no diagnostic would point at the
 * half that was left behind.
 */
export function provideRenameEdits(model: PlanDocument, position: Position, newName: string,
                                   options: NavigationOptions = {}): RenameResult {
  const target = targetAt(model, model.source.offsetAt(position), options);
  if (!target) return refusal('There is nothing to rename at this position.');
  const checked = renameable(target, options);
  if (isRefusal(checked)) return checked;
  if (!isValidIdentifier(newName)) {
    return refusal(`'${newName}' is not a valid HVP identifier: expected [A-Za-z_][A-Za-z0-9_]* `
      + 'and no reserved word.');
  }
  // One lookup answers both collisions: the scope seeds the built-ins and a
  // plan's own declaration shadows them, so a name a plan redeclares reports as
  // that plan's, which is what the user would go and fix.
  const taken = lookup(scopeFor(checked, model, options), newName);
  if (taken?.builtin) return refusal(`'${newName}' is the name of a built-in and cannot be declared.`);
  if (taken) return refusal(`'${newName}' is already declared in plan '${checked.planName}'.`);
  const { occurrences, problems } = findOccurrences(checked, model, options);
  if (problems.length) {
    const more = problems.length > 1
      ? ` (and ${problems.length - 1} more place${problems.length > 2 ? 's' : ''})` : '';
    return refusal(`'${checked.name}' cannot be renamed safely: it is also written in ${problems[0]}${more}.`);
  }
  const declarations = occurrences.filter(occurrence => occurrence.declaration);
  if (!declarations.length) return refusal(`'${checked.name}' has no declaration in this workspace.`);
  if (declarations.length > 1) {
    return refusal(`'${checked.name}' is declared ${declarations.length} times in plan '${checked.planName}'; `
      + 'fix the duplicate declaration before renaming.');
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const occurrence of occurrences) {
    (changes[occurrence.uri] ??= []).push(TextEdit.replace(occurrence.range, newName));
  }
  return { edit: { changes } };
}

/** The plan scope a renamed declaration lands in, for the collision check. */
function scopeFor(target: DeclarationTarget, model: PlanDocument, options: NavigationOptions): Scope {
  const entry = target.planName && options.index ? options.index.plans(target.planName)[0] : undefined;
  return entry ? scopeOf(entry.model, entry.node) : scopeOf(model, target.declaration.node);
}

/**
 * The target as something that may be renamed, or the reason it may not.
 *
 * WS6 renames attributes, annotations and metrics — the three names sharing one
 * per-plan namespace. Plans are not renamed: the chapter ties a plan name to
 * the `-plan` arguments a tool run is given, and files outside the workspace
 * may name it. Enum members are not either: their occurrences are values, and a
 * value the model classified as an identifier may equally be a name the
 * language does not model.
 */
function renameable(target: NavigationTarget, options: NavigationOptions): DeclarationTarget | RenameRefusal {
  if (target.kind === 'plan') {
    return refusal(`'${target.name}' is a plan name. A plan is named by the files a tool run is given, `
      + 'which reach outside this workspace, so renaming one here would not be safe.');
  }
  if (target.kind === 'enum-member') {
    return refusal(`'${target.name}' is a member of '${target.owner.name}'. Its occurrences are values, `
      + 'which the language does not model well enough to rewrite safely.');
  }
  if (target.declaration.builtin) {
    return refusal(`'${target.name}' is a built-in ${target.declarationKind} and cannot be renamed.`);
  }
  if (target.planName === undefined) {
    return refusal(`'${target.name}' is declared outside any plan, so there is no scope to rename it in.`);
  }
  if (!options.index) {
    return refusal('The workspace index is not available yet, so a rename could not be checked against the rest '
      + 'of the plan set. Try again in a moment.');
  }
  const entries = options.index.plans(target.planName);
  if (entries.length > 1) {
    return refusal(`Plan '${target.planName}' is declared in ${entries.length} files, so '${target.name}' is `
      + 'ambiguous: only one of them can be the plan this name belongs to.');
  }
  return target;
}

/**
 * The rules engine: pure, total matching of events against user-configured rules.
 *
 * `matchRules` is the whole surface — given an event, a set of rules, and a small
 * evaluation context, it returns one entry per (matching rule × dispatch target).
 * It performs no I/O, never mutates its inputs, and never throws: every failure
 * mode (an unknown operator, a malformed regex, a type mismatch) is treated as
 * "this criterion did not match" rather than an error. This fail-closed stance is
 * load-bearing — a misconfigured rule must silently decline to fire, never crash
 * the dispatch path.
 *
 * Per the architecture principle this module is domain-neutral: it evaluates the
 * SHAPE of a rule's `match` against the SHAPE of an event. All intent lives in the
 * string values the user supplies (sources, types, criteria paths, operands) —
 * never in a code branch here.
 */

import type {
  EventRecord,
  RuleDispatchTarget,
  RuleNotifyTarget,
  RuleRecord,
} from "../interfaces";

/**
 * The evaluation context threaded through a match pass. `me` is the identity the
 * literal operand string `"@Me"` resolves to before comparison; when it is
 * absent, `"@Me"` is compared literally.
 */
export interface MatchContext {
  me?: string;
}

/**
 * One resolved dispatch instruction: a rule fired and named a target playbook.
 * `matchRules` returns these flattened — a rule with N dispatch targets yields N
 * results when it matches.
 */
export interface RuleMatchResult {
  ruleId: number;
  ruleName: string;
  target: RuleDispatchTarget;
}

/**
 * One resolved notify instruction: a rule fired and named a target notifier.
 * `matchNotifyTargets` returns these flattened — a rule with N notify targets
 * yields N results when it matches. Independent of {@link RuleMatchResult}; the
 * dispatch and notify lists of a rule are evaluated separately.
 */
export interface RuleNotifyResult {
  ruleId: number;
  ruleName: string;
  target: RuleNotifyTarget;
}

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk a dotted `path` through `root`, returning the value found or `undefined`
 * as soon as a segment is missing or a non-object is traversed. Never throws.
 */
function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Resolve a criterion key to its actual value. A key is a dotted path resolved
 * against `event.payload` by default; an `event.` prefix resolves the remainder
 * against the event row itself (so `event.subject_ref` reads the row column and
 * `event.payload.x` reaches into the payload the long way round).
 */
function resolveCriterionPath(event: EventRecord, key: string): unknown {
  if (key === "event") return event;
  if (key.startsWith("event.")) {
    return resolvePath(event, key.slice("event.".length));
  }
  return resolvePath(event.payload, key);
}

/**
 * Apply `@Me` substitution to an operand: the literal string `"@Me"` becomes
 * `ctx.me` when that is set, and any other value passes through unchanged.
 */
function subst(value: unknown, ctx: MatchContext): unknown {
  return value === "@Me" && ctx.me !== undefined ? ctx.me : value;
}

/** Strict equality; scalars only carry meaning here (objects compare by identity). */
function strictEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * Order two values for the relational operators. Returns a negative, zero, or
 * positive number when both are numbers (excluding NaN) or both are strings, and
 * `undefined` for any type mismatch — the caller treats `undefined` as no match.
 */
function compareOrder(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return undefined;
}

/** `contains`/`has`: substring when the actual is a string, membership when it is an array. */
function containsMatch(actual: unknown, operand: unknown): boolean {
  if (typeof actual === "string") {
    return typeof operand === "string" && actual.includes(operand);
  }
  if (Array.isArray(actual)) {
    return actual.some((el) => strictEqual(el, operand));
  }
  return false;
}

/** Compile `pattern` to a RegExp, or `undefined` when it is malformed. */
function safeRegex(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== "string") return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/**
 * Evaluate a single `operator: operand` entry against the resolved `actual`
 * value. An unknown operator, a malformed regex, or an operand/actual type
 * mismatch returns `false` (fail-closed) rather than throwing.
 */
function matchOperator(
  op: string,
  actual: unknown,
  operand: unknown,
  ctx: MatchContext,
): boolean {
  switch (op) {
    case "eq":
    case "=":
    case "==":
      return strictEqual(actual, subst(operand, ctx));
    case "ne":
    case "!=":
    case "<>":
      return !strictEqual(actual, subst(operand, ctx));
    case "in":
      return (
        Array.isArray(operand) &&
        operand.some((el) => strictEqual(actual, subst(el, ctx)))
      );
    case "nin":
    case "not_in":
      return (
        Array.isArray(operand) &&
        !operand.some((el) => strictEqual(actual, subst(el, ctx)))
      );
    case "contains":
    case "has":
      return containsMatch(actual, subst(operand, ctx));
    case "=~":
    case "regex":
    case "matches": {
      if (typeof actual !== "string") return false;
      const re = safeRegex(operand);
      return re !== undefined && re.test(actual);
    }
    case "!~":
    case "not_matches": {
      if (typeof actual !== "string") return false;
      const re = safeRegex(operand);
      return re !== undefined && !re.test(actual);
    }
    case "gt":
    case ">": {
      const c = compareOrder(actual, subst(operand, ctx));
      return c !== undefined && c > 0;
    }
    case "gte":
    case ">=": {
      const c = compareOrder(actual, subst(operand, ctx));
      return c !== undefined && c >= 0;
    }
    case "lt":
    case "<": {
      const c = compareOrder(actual, subst(operand, ctx));
      return c !== undefined && c < 0;
    }
    case "lte":
    case "<=": {
      const c = compareOrder(actual, subst(operand, ctx));
      return c !== undefined && c <= 0;
    }
    case "exists":
      if (typeof operand !== "boolean") return false;
      return operand ? actual !== undefined : actual === undefined;
    default:
      return false; // unknown operator → fail closed
  }
}

/**
 * Evaluate one criterion `spec` against the resolved `actual` value:
 *   - a scalar spec → strict equality (with `@Me` substitution),
 *   - an array spec → membership,
 *   - an object spec → an operator map, every entry of which must hold (ANDed).
 * An empty operator map holds vacuously.
 */
function matchCriterion(
  actual: unknown,
  spec: unknown,
  ctx: MatchContext,
): boolean {
  if (Array.isArray(spec)) {
    return spec.some((el) => strictEqual(actual, subst(el, ctx)));
  }
  if (isRecord(spec)) {
    for (const [op, operand] of Object.entries(spec)) {
      if (!matchOperator(op, actual, operand, ctx)) return false;
    }
    return true;
  }
  return strictEqual(actual, subst(spec, ctx));
}

/**
 * Match an event's `type` against a rule's `match.type`, supporting three forms:
 *   - `*` matches any type,
 *   - `prefix.*` matches `type === prefix` or any `type` starting with `prefix.`,
 *   - anything else is an exact string equality.
 */
function typeMatches(matchType: string, eventType: string): boolean {
  if (matchType === "*") return true;
  if (matchType.endsWith(".*")) {
    const prefix = matchType.slice(0, -2);
    return eventType === prefix || eventType.startsWith(`${prefix}.`);
  }
  return eventType === matchType;
}

/**
 * True when every present part of a rule's `match` holds for `event`. An absent
 * `source`, `type`, or `criteria` is a wildcard; a present part that fails to
 * hold (including any single criterion that fails closed) rejects the rule.
 */
function ruleMatches(
  event: EventRecord,
  rule: RuleRecord,
  ctx: MatchContext,
): boolean {
  const { source, type, criteria } = rule.match;
  if (source !== undefined && event.source !== source) return false;
  if (type !== undefined && !typeMatches(type, event.type)) return false;
  if (criteria !== undefined) {
    for (const [key, spec] of Object.entries(criteria)) {
      if (!matchCriterion(resolveCriterionPath(event, key), spec, ctx)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Evaluate `event` against every rule, returning one {@link RuleMatchResult} per
 * dispatch target of every enabled rule that matches, in rule-then-target order.
 * Disabled rules are skipped. Pure and total: no I/O, no mutation, never throws.
 */
export function matchRules(
  event: EventRecord,
  rules: RuleRecord[],
  ctx: MatchContext = {},
): RuleMatchResult[] {
  const results: RuleMatchResult[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(event, rule, ctx)) continue;
    for (const target of rule.dispatch) {
      results.push({ ruleId: rule.id, ruleName: rule.name, target });
    }
  }
  return results;
}

/**
 * Evaluate `event` against every rule, returning one {@link RuleNotifyResult}
 * per notify target of every enabled rule that matches, in rule-then-target
 * order. Mirrors {@link matchRules} but flattens each rule's `notify` list
 * instead of its `dispatch` list, so a rule's notify and dispatch targets fire
 * independently. Pure and total: no I/O, no mutation, never throws.
 */
export function matchNotifyTargets(
  event: EventRecord,
  rules: RuleRecord[],
  ctx: MatchContext = {},
): RuleNotifyResult[] {
  const results: RuleNotifyResult[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(event, rule, ctx)) continue;
    for (const target of rule.notify) {
      results.push({ ruleId: rule.id, ruleName: rule.name, target });
    }
  }
  return results;
}

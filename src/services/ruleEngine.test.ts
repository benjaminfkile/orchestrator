import type { EventRecord, RuleRecord } from "../interfaces";

import {
  matchNotifyTargets,
  matchRules,
  type MatchContext,
} from "./ruleEngine";

/** A representative event; individual tests override fields as needed. */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 42,
    source: "ado",
    type: "work_item.updated",
    subject_kind: "item",
    subject_ref: "AB#123",
    payload: {
      state: "Active",
      priority: 2,
      title: "Fix the login flow",
      assignee: "alice",
      tags: ["urgent", "backend"],
      nested: { level: "high" },
      done: false,
      score: 7.5,
    },
    dedupe_key: null,
    ts: 1_000,
    last_dispatched_at: null,
    cleared_at: null,
    ...overrides,
  };
}

/** A rule with a single dispatch target; `match` is supplied per test. */
function makeRule(
  match: RuleRecord["match"],
  overrides: Partial<RuleRecord> = {},
): RuleRecord {
  return {
    id: 1,
    name: "rule-1",
    enabled: true,
    match,
    dispatch: [{ playbook_id: 10 }],
    notify: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

/** Convenience: does this single-rule match produce at least one result? */
function matches(
  match: RuleRecord["match"],
  event: EventRecord = makeEvent(),
  ctx: MatchContext = {},
): boolean {
  return matchRules(event, [makeRule(match)], ctx).length > 0;
}

describe("matchRules — source and type matching", () => {
  it("matches a bare {} rule against any event (all wildcards)", () => {
    expect(matches({})).toBe(true);
  });

  it("requires strict source equality when source is present", () => {
    expect(matches({ source: "ado" })).toBe(true);
    expect(matches({ source: "github" })).toBe(false);
    expect(matches({ source: "ADO" })).toBe(false); // case-sensitive
  });

  const typeCases: Array<{
    name: string;
    matchType: string;
    eventType: string;
    expected: boolean;
  }> = [
    { name: "exact hit", matchType: "work_item.updated", eventType: "work_item.updated", expected: true },
    { name: "exact miss", matchType: "work_item.created", eventType: "work_item.updated", expected: false },
    { name: "* matches anything", matchType: "*", eventType: "anything.at.all", expected: true },
    { name: "prefix.* on a dotted child", matchType: "work_item.*", eventType: "work_item.updated", expected: true },
    { name: "prefix.* on the bare prefix", matchType: "work_item.*", eventType: "work_item", expected: true },
    { name: "prefix.* rejects a different prefix", matchType: "work_item.*", eventType: "build.updated", expected: false },
    { name: "prefix.* rejects a prefix-substring", matchType: "work.*", eventType: "work_item.updated", expected: false },
    { name: "prefix.* deep child", matchType: "a.*", eventType: "a.b.c", expected: true },
  ];

  it.each(typeCases)("type $name", ({ matchType, eventType, expected }) => {
    expect(matches({ type: matchType }, makeEvent({ type: eventType }))).toBe(
      expected,
    );
  });

  it("ANDs source and type when both are present", () => {
    const m = { source: "ado", type: "work_item.*" };
    expect(matches(m, makeEvent({ source: "ado", type: "work_item.x" }))).toBe(true);
    expect(matches(m, makeEvent({ source: "github", type: "work_item.x" }))).toBe(false);
    expect(matches(m, makeEvent({ source: "ado", type: "build.x" }))).toBe(false);
  });
});

describe("matchRules — scalar and array criterion values", () => {
  it("matches a scalar criterion by strict equality against the payload", () => {
    expect(matches({ criteria: { state: "Active" } })).toBe(true);
    expect(matches({ criteria: { state: "Closed" } })).toBe(false);
    expect(matches({ criteria: { priority: 2 } })).toBe(true);
    expect(matches({ criteria: { priority: "2" } })).toBe(false); // no coercion
    expect(matches({ criteria: { done: false } })).toBe(true);
  });

  it("ANDs multiple criteria keys", () => {
    expect(matches({ criteria: { state: "Active", priority: 2 } })).toBe(true);
    expect(matches({ criteria: { state: "Active", priority: 1 } })).toBe(false);
  });

  it("treats an array criterion value as membership", () => {
    expect(matches({ criteria: { state: ["Active", "Resolved"] } })).toBe(true);
    expect(matches({ criteria: { state: ["Closed", "Resolved"] } })).toBe(false);
    expect(matches({ criteria: { priority: [1, 2, 3] } })).toBe(true);
  });

  it("resolves dotted payload paths", () => {
    expect(matches({ criteria: { "nested.level": "high" } })).toBe(true);
    expect(matches({ criteria: { "nested.level": "low" } })).toBe(false);
    expect(matches({ criteria: { "nested.missing": "x" } })).toBe(false);
  });
});

describe("matchRules — event.-prefixed paths", () => {
  it("resolves an event.-prefixed path against the event row, not the payload", () => {
    expect(matches({ criteria: { "event.subject_ref": "AB#123" } })).toBe(true);
    expect(matches({ criteria: { "event.subject_ref": "AB#999" } })).toBe(false);
    expect(matches({ criteria: { "event.type": "work_item.updated" } })).toBe(true);
    expect(matches({ criteria: { "event.source": "ado" } })).toBe(true);
  });

  it("reaches into the payload the long way via event.payload.*", () => {
    expect(matches({ criteria: { "event.payload.state": "Active" } })).toBe(true);
  });

  it("does not confuse a payload key named like a row column", () => {
    const event = makeEvent({
      subject_ref: "ROW",
      payload: { subject_ref: "PAYLOAD" },
    });
    expect(matches({ criteria: { subject_ref: "PAYLOAD" } }, event)).toBe(true);
    expect(matches({ criteria: { "event.subject_ref": "ROW" } }, event)).toBe(true);
    expect(matches({ criteria: { subject_ref: "ROW" } }, event)).toBe(false);
  });
});

describe("matchRules — @Me substitution", () => {
  it("substitutes @Me with ctx.me before comparing a scalar", () => {
    const event = makeEvent({ payload: { assignee: "alice" } });
    expect(matches({ criteria: { assignee: "@Me" } }, event, { me: "alice" })).toBe(true);
    expect(matches({ criteria: { assignee: "@Me" } }, event, { me: "bob" })).toBe(false);
  });

  it("compares @Me literally when ctx.me is unset", () => {
    const event = makeEvent({ payload: { assignee: "@Me" } });
    expect(matches({ criteria: { assignee: "@Me" } }, event, {})).toBe(true);
  });

  it("substitutes @Me inside array membership and operator operands", () => {
    const event = makeEvent({ payload: { assignee: "alice" } });
    expect(matches({ criteria: { assignee: ["@Me", "bob"] } }, event, { me: "alice" })).toBe(true);
    expect(matches({ criteria: { assignee: { eq: "@Me" } } }, event, { me: "alice" })).toBe(true);
    expect(matches({ criteria: { assignee: { in: ["@Me"] } } }, event, { me: "alice" })).toBe(true);
    expect(matches({ criteria: { assignee: { ne: "@Me" } } }, event, { me: "bob" })).toBe(true);
  });
});

describe("matchRules — operator map (table-driven)", () => {
  type Case = {
    op: string;
    operand: unknown;
    path: string;
    event?: EventRecord;
    expected: boolean;
  };

  const cases: Case[] = [
    // eq / = / ==
    { op: "eq", operand: "Active", path: "state", expected: true },
    { op: "=", operand: "Active", path: "state", expected: true },
    { op: "==", operand: "Closed", path: "state", expected: false },
    // ne / != / <>
    { op: "ne", operand: "Closed", path: "state", expected: true },
    { op: "!=", operand: "Active", path: "state", expected: false },
    { op: "<>", operand: "Closed", path: "state", expected: true },
    // in
    { op: "in", operand: ["Active", "Resolved"], path: "state", expected: true },
    { op: "in", operand: ["Closed"], path: "state", expected: false },
    { op: "in", operand: "not-an-array", path: "state", expected: false }, // fail closed
    // nin / not_in
    { op: "nin", operand: ["Closed", "Resolved"], path: "state", expected: true },
    { op: "not_in", operand: ["Active"], path: "state", expected: false },
    { op: "nin", operand: "not-an-array", path: "state", expected: false }, // fail closed
    // contains / has — substring
    { op: "contains", operand: "login", path: "title", expected: true },
    { op: "has", operand: "logout", path: "title", expected: false },
    { op: "contains", operand: 2, path: "title", expected: false }, // non-string operand vs string
    // contains / has — array element
    { op: "contains", operand: "urgent", path: "tags", expected: true },
    { op: "has", operand: "frontend", path: "tags", expected: false },
    // =~ / regex / matches
    { op: "=~", operand: "^Fix", path: "title", expected: true },
    { op: "regex", operand: "flow$", path: "title", expected: true },
    { op: "matches", operand: "^nope", path: "title", expected: false },
    { op: "=~", operand: "(unclosed", path: "title", expected: false }, // malformed regex fail closed
    { op: "=~", operand: "\\d+", path: "priority", expected: false }, // non-string actual fail closed
    // !~ / not_matches
    { op: "!~", operand: "^nope", path: "title", expected: true },
    { op: "not_matches", operand: "^Fix", path: "title", expected: false },
    { op: "!~", operand: "(unclosed", path: "title", expected: false }, // malformed regex fail closed
    { op: "!~", operand: "x", path: "priority", expected: false }, // non-string actual fail closed
    // gt / >
    { op: "gt", operand: 1, path: "priority", expected: true },
    { op: ">", operand: 2, path: "priority", expected: false },
    { op: "gt", operand: "1", path: "priority", expected: false }, // type mismatch fail closed
    // gte / >=
    { op: "gte", operand: 2, path: "priority", expected: true },
    { op: ">=", operand: 3, path: "priority", expected: false },
    // lt / <
    { op: "lt", operand: 3, path: "priority", expected: true },
    { op: "<", operand: 2, path: "priority", expected: false },
    // lte / <=
    { op: "lte", operand: 2, path: "priority", expected: true },
    { op: "<=", operand: 1, path: "priority", expected: false },
    // relational on floats and strings
    { op: "gt", operand: 7, path: "score", expected: true },
    { op: "lt", operand: "b", path: "assignee", expected: true }, // "alice" < "b"
    { op: "gt", operand: "b", path: "assignee", expected: false },
    // exists
    { op: "exists", operand: true, path: "state", expected: true },
    { op: "exists", operand: false, path: "state", expected: false },
    { op: "exists", operand: true, path: "missing", expected: false },
    { op: "exists", operand: false, path: "missing", expected: true },
    { op: "exists", operand: "yes", path: "state", expected: false }, // non-boolean operand fail closed
  ];

  it.each(cases)(
    "$op $operand on $path → $expected",
    ({ op, operand, path, event, expected }) => {
      const rule = { criteria: { [path]: { [op]: operand } } };
      expect(matches(rule, event ?? makeEvent())).toBe(expected);
    },
  );

  it("ANDs multiple operators in one operator map", () => {
    expect(matches({ criteria: { priority: { gte: 1, lte: 3 } } })).toBe(true);
    expect(matches({ criteria: { priority: { gte: 1, lt: 2 } } })).toBe(false);
  });

  it("fails closed on an unknown operator", () => {
    expect(matches({ criteria: { priority: { wat: 2 } } })).toBe(false);
    // Even when another operator in the same map would hold.
    expect(matches({ criteria: { priority: { eq: 2, wat: 2 } } })).toBe(false);
  });

  it("treats an empty operator map as vacuously true", () => {
    expect(matches({ criteria: { priority: {} } })).toBe(true);
  });
});

describe("matchRules — result shape and flattening", () => {
  it("returns one result per dispatch target of each matching rule", () => {
    const ruleA = makeRule(
      { source: "ado" },
      {
        id: 1,
        name: "A",
        dispatch: [
          { playbook_id: 10, bindings: { k: "v" } },
          { playbook_id: 11 },
        ],
      },
    );
    const ruleB = makeRule({ type: "build.*" }, { id: 2, name: "B" });
    const ruleC = makeRule(
      { source: "ado" },
      { id: 3, name: "C", dispatch: [{ playbook_id: 20 }] },
    );

    const results = matchRules(makeEvent(), [ruleA, ruleB, ruleC]);

    expect(results).toEqual([
      { ruleId: 1, ruleName: "A", target: { playbook_id: 10, bindings: { k: "v" } } },
      { ruleId: 1, ruleName: "A", target: { playbook_id: 11 } },
      { ruleId: 3, ruleName: "C", target: { playbook_id: 20 } },
    ]);
  });

  it("skips disabled rules even when they would match", () => {
    const rule = makeRule({ source: "ado" }, { enabled: false });
    expect(matchRules(makeEvent(), [rule])).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    const rule = makeRule({ source: "nope" });
    expect(matchRules(makeEvent(), [rule])).toEqual([]);
  });

  it("emits nothing for a matching rule with no dispatch targets", () => {
    const rule = makeRule({ source: "ado" }, { dispatch: [] });
    expect(matchRules(makeEvent(), [rule])).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const event = makeEvent();
    const rules = [makeRule({ source: "ado" })];
    const snapshot = JSON.stringify({ event, rules });
    matchRules(event, rules, { me: "alice" });
    expect(JSON.stringify({ event, rules })).toBe(snapshot);
  });
});

describe("matchRules — fail-closed robustness", () => {
  it("never throws on a null or non-object payload", () => {
    const nullPayload = makeEvent({ payload: null });
    const scalarPayload = makeEvent({ payload: 5 });
    expect(matches({ criteria: { state: "Active" } }, nullPayload)).toBe(false);
    expect(matches({ criteria: { "a.b": "x" } }, scalarPayload)).toBe(false);
    expect(matches({ criteria: { state: { exists: false } } }, nullPayload)).toBe(true);
  });

  it("fails closed when a relational operator meets a missing value", () => {
    expect(matches({ criteria: { missing: { gt: 1 } } })).toBe(false);
  });
});

describe("matchNotifyTargets", () => {
  it("flattens the notify targets of every matching enabled rule", () => {
    const event = makeEvent();
    const rules = [
      makeRule(
        { source: "ado" },
        { id: 1, name: "r1", notify: [{ notifier_id: 5 }, { notifier_id: 6 }] }
      ),
      makeRule(
        { source: "other" },
        { id: 2, name: "r2", notify: [{ notifier_id: 7 }] }
      ),
    ];
    const results = matchNotifyTargets(event, rules);
    expect(results).toEqual([
      { ruleId: 1, ruleName: "r1", target: { notifier_id: 5 } },
      { ruleId: 1, ruleName: "r1", target: { notifier_id: 6 } },
    ]);
  });

  it("skips disabled rules and rules with no notify targets", () => {
    const event = makeEvent();
    const rules = [
      makeRule({}, { id: 1, enabled: false, notify: [{ notifier_id: 1 }] }),
      makeRule({}, { id: 2, notify: [] }),
    ];
    expect(matchNotifyTargets(event, rules)).toEqual([]);
  });

  it("is independent of dispatch: a notify-only rule still fires", () => {
    const event = makeEvent();
    const rules = [
      makeRule({}, { id: 3, dispatch: [], notify: [{ notifier_id: 9 }] }),
    ];
    expect(matchNotifyTargets(event, rules)).toEqual([
      { ruleId: 3, ruleName: "rule-1", target: { notifier_id: 9 } },
    ]);
  });
});

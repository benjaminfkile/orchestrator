import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { createDispatch, listDispatches } from "../db/dispatches";
import { getEventById, insertEvent, listEvents } from "../db/events";
import { runMigrations } from "../db/migrate";
import { listNotifications } from "../db/notificationLog";
import { createNotifier } from "../db/notifiers";
import { createPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import { setSetting } from "../db/settings";
import type { Logger } from "../log";

import {
  COOLDOWN_SETTING_KEY,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_MAX_CHAIN_DEPTH,
  emitEvent,
  IDENTITY_ME_SETTING,
  MAX_CHAIN_DEPTH_SETTING,
  MAX_PER_EVENT_SETTING,
  MAX_PER_HOUR_SETTING,
  type EmitDeps,
} from "./eventIntake";

/** A logger that records every warn call for cap-enforcement assertions. */
function capturingLogger(): {
  logger: Logger;
  warnings: { msg: string; extra?: Record<string, unknown> }[];
} {
  const warnings: { msg: string; extra?: Record<string, unknown> }[] = [];
  const noop = () => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: (msg, extra) => {
      warnings.push({ msg, extra });
    },
    error: noop,
    child: () => logger,
  };
  return { logger, warnings };
}

/** A dispatcher stub counting kicks. */
function kickCounter(): { deps: EmitDeps; kicks: () => number } {
  let kicks = 0;
  return {
    deps: { dispatcher: { kick: () => (kicks += 1) } },
    kicks: () => kicks,
  };
}

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intake-"));
  return path.join(dir, "test.sqlite");
}

const baseEvent = {
  source: "moduleA",
  type: "thing.changed",
  subject_kind: "widget",
  subject_ref: "42",
  dedupe_key: "widget:42",
};

describe("eventIntake.emitEvent", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("inserts events that carry no dedupe_key without suppression", async () => {
    const { source, type, subject_kind, subject_ref } = baseEvent;
    const first = await emitEvent(
      { source, type, subject_kind, subject_ref, ts: 1000 },
      db
    );
    const second = await emitEvent(
      { source, type, subject_kind, subject_ref, ts: 1000 },
      db
    );
    expect(first.suppressed).toBe(false);
    expect(second.suppressed).toBe(false);
    expect(await listEvents({}, db)).toHaveLength(2);
  });

  it("suppresses a duplicate within the cooldown window", async () => {
    const first = await emitEvent({ ...baseEvent, ts: 1_000_000 }, db);
    expect(first.suppressed).toBe(false);

    // 100s later, well within the default 300s window.
    const second = await emitEvent({ ...baseEvent, ts: 1_100_000 }, db);
    expect(second).toEqual({ suppressed: true, reason: "cooldown" });

    // Only the first event was persisted.
    expect(await listEvents({}, db)).toHaveLength(1);
  });

  it("inserts again once the cooldown window has expired", async () => {
    await emitEvent({ ...baseEvent, ts: 1_000_000 }, db);

    // 301s later: just past the default 300s window.
    const later = await emitEvent({ ...baseEvent, ts: 1_301_000 }, db);
    expect(later.suppressed).toBe(false);
    expect(await listEvents({}, db)).toHaveLength(2);
  });

  it("honors a custom cooldown from app_settings", async () => {
    await setSetting(COOLDOWN_SETTING_KEY, "10", db);
    await emitEvent({ ...baseEvent, ts: 1_000_000 }, db);

    // 20s later would be suppressed under the default but not a 10s window.
    const later = await emitEvent({ ...baseEvent, ts: 1_020_000 }, db);
    expect(later.suppressed).toBe(false);

    // 5s after that is inside the 10s window relative to the last insert.
    const suppressed = await emitEvent({ ...baseEvent, ts: 1_025_000 }, db);
    expect(suppressed.suppressed).toBe(true);
  });

  it("re-arms after the prior event is cleared, even within the window", async () => {
    const first = await emitEvent({ ...baseEvent, ts: 1_000_000 }, db);
    expect(first.suppressed).toBe(false);
    if (first.suppressed) throw new Error("unreachable");

    // Clear the first event: it should no longer suppress.
    await db("events")
      .where({ id: first.event.id })
      .update({ cleared_at: 1_050_000 });

    // Still inside the cooldown window, but the only prior match is cleared.
    const second = await emitEvent({ ...baseEvent, ts: 1_100_000 }, db);
    expect(second.suppressed).toBe(false);
    expect(await listEvents({}, db)).toHaveLength(2);
  });

  it("does not let different dedupe_keys suppress each other", async () => {
    const a = await emitEvent(
      { ...baseEvent, dedupe_key: "widget:1", ts: 1000 },
      db
    );
    const b = await emitEvent(
      { ...baseEvent, dedupe_key: "widget:2", ts: 1000 },
      db
    );
    expect(a.suppressed).toBe(false);
    expect(b.suppressed).toBe(false);
    expect(await listEvents({}, db)).toHaveLength(2);
  });

  it("falls back to the default cooldown when the setting is unparseable", async () => {
    await setSetting(COOLDOWN_SETTING_KEY, "not-a-number", db);
    await emitEvent({ ...baseEvent, ts: 1_000_000 }, db);

    // Within the default window → suppressed.
    const within = await emitEvent(
      { ...baseEvent, ts: 1_000_000 + (DEFAULT_COOLDOWN_SECONDS - 1) * 1000 },
      db
    );
    expect(within.suppressed).toBe(true);
  });
});

describe("eventIntake.emitEvent — dispatch wiring", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  const noDedupe = {
    source: "moduleA",
    type: "thing.changed",
    subject_kind: "widget",
    subject_ref: "42",
  };

  /** Create a playbook (FK targets are enforced) and return its id. */
  async function mkPlaybook(name: string): Promise<number> {
    const pb = await createPlaybook(
      { name, image: "img:latest", ttl_seconds: 60 },
      db
    );
    return pb.id;
  }

  it("creates a queued dispatch per matched target and kicks the dispatcher", async () => {
    const pb = await mkPlaybook("p");
    const rule = await createRule(
      { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
      db
    );
    const { deps, kicks } = kickCounter();

    const result = await emitEvent(noDedupe, db, deps);
    expect(result.suppressed).toBe(false);
    if (result.suppressed) throw new Error("unreachable");

    const dispatches = await listDispatches(undefined, db);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      event_id: result.event.id,
      rule_id: rule.id,
      playbook_id: pb,
      status: "queued",
    });
    expect(kicks()).toBe(1);

    // last_dispatched_at is stamped on the event (both in-memory and on disk).
    expect(result.event.last_dispatched_at).not.toBeNull();
    const stored = await getEventById(result.event.id, db);
    expect(stored?.last_dispatched_at).toBe(result.event.last_dispatched_at);
  });

  it("creates one dispatch per target when a rule fans out", async () => {
    const ids = [
      await mkPlaybook("p1"),
      await mkPlaybook("p2"),
      await mkPlaybook("p3"),
    ];
    await createRule(
      {
        name: "fanout",
        match: {},
        dispatch: ids.map((playbook_id) => ({ playbook_id })),
      },
      db
    );

    await emitEvent(noDedupe, db);

    // listDispatches is newest-first; sort by id to recover creation order and
    // assert each target fanned out to its playbook.
    const dispatches = await listDispatches(undefined, db);
    expect(
      [...dispatches].sort((a, b) => a.id - b.id).map((d) => d.playbook_id)
    ).toEqual(ids);
  });

  it("fail-closes on a dangling target (deleted playbook), skipping it without throwing", async () => {
    // Two targets: one live playbook, one id that names no playbook (as if the
    // playbook was deleted while the rule kept pointing at it). The dangling one
    // must be skipped with a warning, not throw the FK error that would break
    // intake; the live target still dispatches.
    const live = await mkPlaybook("live");
    const missing = live + 12345;
    await createRule(
      {
        name: "mixed",
        match: {},
        dispatch: [{ playbook_id: missing }, { playbook_id: live }],
      },
      db
    );
    const { deps, kicks } = kickCounter();
    const { logger, warnings } = capturingLogger();

    const result = await emitEvent(noDedupe, db, { ...deps, logger });
    if (result.suppressed) throw new Error("unreachable");

    const dispatches = await listDispatches(undefined, db);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].playbook_id).toBe(live);
    expect(result.event.last_dispatched_at).not.toBeNull();
    expect(kicks()).toBe(1);
    expect(
      warnings.some((w) => w.msg.includes("missing playbook"))
    ).toBe(true);
  });

  it("creates no dispatch and no last_dispatched_at when every target is dangling", async () => {
    const missing = 99999;
    await createRule(
      { name: "dangling", match: {}, dispatch: [{ playbook_id: missing }] },
      db
    );
    const { deps, kicks } = kickCounter();

    const result = await emitEvent(noDedupe, db, deps);
    if (result.suppressed) throw new Error("unreachable");

    expect(await listDispatches(undefined, db)).toHaveLength(0);
    expect(result.event.last_dispatched_at).toBeNull();
    expect(kicks()).toBe(0);
  });

  it("creates no dispatch and no last_dispatched_at when no rule matches", async () => {
    const pb = await mkPlaybook("p");
    await createRule(
      {
        name: "other",
        match: { source: "elsewhere" },
        dispatch: [{ playbook_id: pb }],
      },
      db
    );
    const { deps, kicks } = kickCounter();

    const result = await emitEvent(noDedupe, db, deps);
    if (result.suppressed) throw new Error("unreachable");

    expect(await listDispatches(undefined, db)).toHaveLength(0);
    expect(result.event.last_dispatched_at).toBeNull();
    expect(kicks()).toBe(0);
  });

  it("ignores disabled rules", async () => {
    const pb = await mkPlaybook("p");
    await createRule(
      {
        name: "off",
        enabled: false,
        match: {},
        dispatch: [{ playbook_id: pb }],
      },
      db
    );

    await emitEvent(noDedupe, db);
    expect(await listDispatches(undefined, db)).toHaveLength(0);
  });

  it("creates no dispatch for a suppressed (deduped) event", async () => {
    const pb = await mkPlaybook("p");
    await createRule(
      { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
      db
    );
    const deduped = { ...noDedupe, dedupe_key: "widget:42" };
    const { deps, kicks } = kickCounter();

    const first = await emitEvent({ ...deduped, ts: 1_000_000 }, db, deps);
    expect(first.suppressed).toBe(false);
    // Within the cooldown window → suppressed, so no second dispatch.
    const second = await emitEvent({ ...deduped, ts: 1_100_000 }, db, deps);
    expect(second.suppressed).toBe(true);

    expect(await listDispatches(undefined, db)).toHaveLength(1);
    expect(kicks()).toBe(1);
  });

  it("resolves @Me from the identity_me setting", async () => {
    const pb = await mkPlaybook("p");
    await setSetting(IDENTITY_ME_SETTING, "alice", db);
    await createRule(
      {
        name: "mine",
        match: { criteria: { assignee: "@Me" } },
        dispatch: [{ playbook_id: pb }],
      },
      db
    );

    const mine = await emitEvent(
      { ...noDedupe, payload: { assignee: "alice" } },
      db
    );
    if (mine.suppressed) throw new Error("unreachable");
    expect(await listDispatches(undefined, db)).toHaveLength(1);

    const theirs = await emitEvent(
      { ...noDedupe, payload: { assignee: "bob" } },
      db
    );
    if (theirs.suppressed) throw new Error("unreachable");
    // Still just the one dispatch — bob's event did not match @Me=alice.
    expect(await listDispatches(undefined, db)).toHaveLength(1);
  });

  it("does not resolve @Me when identity_me is unset (empty string)", async () => {
    const pb = await mkPlaybook("p");
    await createRule(
      {
        name: "mine",
        match: { criteria: { assignee: "@Me" } },
        dispatch: [{ playbook_id: pb }],
      },
      db
    );

    // With me="" the literal "@Me" is compared as-is; "alice" !== "@Me".
    const result = await emitEvent(
      { ...noDedupe, payload: { assignee: "alice" } },
      db
    );
    if (result.suppressed) throw new Error("unreachable");
    expect(await listDispatches(undefined, db)).toHaveLength(0);
  });

  describe("caps", () => {
    it("drops targets beyond dispatch_max_per_event and warns", async () => {
      await setSetting(MAX_PER_EVENT_SETTING, "2", db);
      const ids = [
        await mkPlaybook("a"),
        await mkPlaybook("b"),
        await mkPlaybook("c"),
        await mkPlaybook("d"),
      ];
      await createRule(
        {
          name: "fanout",
          match: {},
          dispatch: ids.map((playbook_id) => ({ playbook_id })),
        },
        db
      );
      const { logger, warnings } = capturingLogger();

      await emitEvent(noDedupe, db, { logger });

      // listDispatches is newest-first; sort by id to recover creation order.
      const dispatches = await listDispatches(undefined, db);
      expect(
        [...dispatches].sort((a, b) => a.id - b.id).map((d) => d.playbook_id)
      ).toEqual(ids.slice(0, 2));
      expect(warnings).toHaveLength(1);
      expect(warnings[0].msg).toMatch(/dispatch_max_per_event/);
      expect(warnings[0].extra).toMatchObject({ cap: 2, dropped: 2 });
    });

    it("creates nothing once dispatch_max_per_hour is reached, and warns", async () => {
      await setSetting(MAX_PER_HOUR_SETTING, "2", db);
      const pb = await mkPlaybook("p");
      const ev = await insertEvent(noDedupe, db);
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );
      // Pre-fill the trailing hour to the cap.
      await createDispatch({ event_id: ev.id, playbook_id: pb }, db);
      await createDispatch({ event_id: ev.id, playbook_id: pb }, db);
      const { logger, warnings } = capturingLogger();
      const { deps, kicks } = kickCounter();

      const result = await emitEvent(noDedupe, db, {
        ...deps,
        logger,
      });
      if (result.suppressed) throw new Error("unreachable");

      // No new dispatch, no kick, no last_dispatched_at.
      expect(await listDispatches(undefined, db)).toHaveLength(2);
      expect(result.event.last_dispatched_at).toBeNull();
      expect(kicks()).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].msg).toMatch(/dispatch_max_per_hour/);
    });

    it("still creates when under the per-hour cap", async () => {
      await setSetting(MAX_PER_HOUR_SETTING, "5", db);
      const pb = await mkPlaybook("p");
      const ev = await insertEvent(noDedupe, db);
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );
      await createDispatch({ event_id: ev.id, playbook_id: pb }, db);

      await emitEvent(noDedupe, db);
      // The pre-existing one plus the newly created one.
      expect(await listDispatches(undefined, db)).toHaveLength(2);
    });
  });

  describe("chain-depth guard", () => {
    it("creates no dispatches when payload.chain_depth is at the default cap, but still inserts the event", async () => {
      const pb = await mkPlaybook("p");
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );
      const { logger, warnings } = capturingLogger();
      const { deps, kicks } = kickCounter();

      // chain_depth === the default cap (3) → blocked.
      const result = await emitEvent(
        { ...noDedupe, payload: { chain_depth: DEFAULT_MAX_CHAIN_DEPTH } },
        db,
        { ...deps, logger }
      );
      if (result.suppressed) throw new Error("unreachable");

      // The event row is still inserted, but no dispatch was created.
      expect(await listEvents({}, db)).toHaveLength(1);
      expect(await listDispatches(undefined, db)).toHaveLength(0);
      expect(result.event.last_dispatched_at).toBeNull();
      expect(kicks()).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].msg).toMatch(/dispatch_max_chain_depth/);
      expect(warnings[0].extra).toMatchObject({
        chainDepth: DEFAULT_MAX_CHAIN_DEPTH,
        cap: DEFAULT_MAX_CHAIN_DEPTH,
      });
    });

    it("still dispatches when chain_depth is below the cap", async () => {
      const pb = await mkPlaybook("p");
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );

      const result = await emitEvent(
        { ...noDedupe, payload: { chain_depth: DEFAULT_MAX_CHAIN_DEPTH - 1 } },
        db
      );
      if (result.suppressed) throw new Error("unreachable");
      expect(await listDispatches(undefined, db)).toHaveLength(1);
      expect(result.event.last_dispatched_at).not.toBeNull();
    });

    it("honors a custom dispatch_max_chain_depth setting", async () => {
      await setSetting(MAX_CHAIN_DEPTH_SETTING, "1", db);
      const pb = await mkPlaybook("p");
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );

      // chain_depth 1 >= cap 1 → blocked under the tightened setting.
      const result = await emitEvent(
        { ...noDedupe, payload: { chain_depth: 1 } },
        db
      );
      if (result.suppressed) throw new Error("unreachable");
      expect(await listDispatches(undefined, db)).toHaveLength(0);
    });

    it("does not affect events without a numeric chain_depth", async () => {
      const pb = await mkPlaybook("p");
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );

      // A non-numeric chain_depth is ignored — the guard is a no-op.
      const result = await emitEvent(
        { ...noDedupe, payload: { chain_depth: "deep" } },
        db
      );
      if (result.suppressed) throw new Error("unreachable");
      expect(await listDispatches(undefined, db)).toHaveLength(1);
    });
  });

  describe("skipRuleMatching option", () => {
    it("defaults to matching rules and dispatching (existing behavior)", async () => {
      const pb = await mkPlaybook("p");
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );

      // No options argument passed at all — the default path must dispatch.
      const result = await emitEvent(noDedupe, db);
      if (result.suppressed) throw new Error("unreachable");
      expect(await listDispatches(undefined, db)).toHaveLength(1);
      expect(result.event.last_dispatched_at).not.toBeNull();
    });

    it("skips rule matching and creates no dispatch when the flag is set", async () => {
      const pb = await mkPlaybook("p");
      // A wildcard rule that WOULD match every event.
      await createRule(
        { name: "r1", match: {}, dispatch: [{ playbook_id: pb }] },
        db
      );
      const { deps, kicks } = kickCounter();

      const result = await emitEvent(noDedupe, db, deps, {
        skipRuleMatching: true,
      });
      if (result.suppressed) throw new Error("unreachable");

      // The event is still recorded, but no rule ran and no dispatch was made.
      expect(await listEvents({}, db)).toHaveLength(1);
      expect(await listDispatches(undefined, db)).toHaveLength(0);
      expect(result.event.last_dispatched_at).toBeNull();
      expect(kicks()).toBe(0);
    });
  });
});

describe("eventIntake.emitEvent — notify wiring", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  const noDedupe = {
    source: "moduleA",
    type: "thing.changed",
    subject_kind: "widget",
    subject_ref: "42",
  };

  it("fires notify targets of a matching enabled rule into the log", async () => {
    const notifier = await createNotifier(
      {
        name: "inbox",
        title_template: "{{event.type}}",
        body_template: "{{payload.n}}",
      },
      db
    );
    await createRule(
      { name: "notify-rule", match: {}, notify: [{ notifier_id: notifier.id }] },
      db
    );

    const result = await emitEvent({ ...noDedupe, payload: { n: 7 } }, db);
    if (result.suppressed) throw new Error("unreachable");

    const rows = await listNotifications({}, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("thing.changed");
    expect(rows[0].body).toBe("7");
    expect(rows[0].status).toBe("delivered");
    // Notify does not create dispatches.
    expect(await listDispatches(undefined, db)).toHaveLength(0);
  });

  it("fires notify even when the per-hour dispatch cap blocks all dispatches", async () => {
    const pb = await createPlaybook(
      { name: "p", image: "img:latest", ttl_seconds: 60 },
      db
    );
    const notifier = await createNotifier(
      { name: "inbox", title_template: "hit" },
      db
    );
    await createRule(
      {
        name: "both",
        match: {},
        dispatch: [{ playbook_id: pb.id }],
        notify: [{ notifier_id: notifier.id }],
      },
      db
    );
    // Cap dispatch creation at zero: no dispatch may be created for this event.
    await setSetting(MAX_PER_HOUR_SETTING, "0", db);

    const result = await emitEvent(noDedupe, db);
    if (result.suppressed) throw new Error("unreachable");

    // No dispatch (cap), but the notification still delivered.
    expect(await listDispatches(undefined, db)).toHaveLength(0);
    const rows = await listNotifications({}, db);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("hit");
  });

  it("fires notify even when the chain-depth guard blocks dispatching", async () => {
    const pb = await createPlaybook(
      { name: "p", image: "img:latest", ttl_seconds: 60 },
      db
    );
    const notifier = await createNotifier(
      { name: "inbox", title_template: "hit" },
      db
    );
    await createRule(
      {
        name: "both",
        match: {},
        dispatch: [{ playbook_id: pb.id }],
        notify: [{ notifier_id: notifier.id }],
      },
      db
    );

    // A chain_depth at the cap suppresses all dispatch creation.
    const result = await emitEvent(
      { ...noDedupe, payload: { chain_depth: DEFAULT_MAX_CHAIN_DEPTH } },
      db
    );
    if (result.suppressed) throw new Error("unreachable");

    expect(await listDispatches(undefined, db)).toHaveLength(0);
    expect(await listNotifications({}, db)).toHaveLength(1);
  });

  it("skips notify entirely when skipRuleMatching is set", async () => {
    const notifier = await createNotifier(
      { name: "inbox", title_template: "hit" },
      db
    );
    await createRule(
      { name: "notify-rule", match: {}, notify: [{ notifier_id: notifier.id }] },
      db
    );

    const result = await emitEvent(noDedupe, db, {}, { skipRuleMatching: true });
    if (result.suppressed) throw new Error("unreachable");

    expect(await listNotifications({}, db)).toEqual([]);
  });
});

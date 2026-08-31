import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import type { DispatchStatus } from "../interfaces";

import { createDb } from "./db";
import {
  claimNextQueuedDispatch,
  createDispatch,
  getDispatch,
  getDispatchWithSubject,
  listDispatches,
  listDispatchesWithPendingRelease,
  listDispatchesWithSubject,
  resetToQueued,
  updateDispatch,
} from "./dispatches";
import { insertEvent } from "./events";
import { createPlaybook } from "./playbooks";
import { createRule } from "./rules";
import { runMigrations } from "./migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dispatches-"));
  return path.join(dir, "test.sqlite");
}

describe("dispatches repo", () => {
  let file: string;
  let db: Knex;
  let eventId: number;
  let ruleId: number;
  let playbookId: number;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);

    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "42",
      },
      db
    );
    eventId = event.id;
    const rule = await createRule({ name: "watcher" }, db);
    ruleId = rule.id;
    const playbook = await createPlaybook(
      { name: "pb", image: "img", ttl_seconds: 60 },
      db
    );
    playbookId = playbook.id;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  function newQueued() {
    return createDispatch({ event_id: eventId, playbook_id: playbookId }, db);
  }

  it("creates a dispatch with queued defaults", async () => {
    const created = await createDispatch(
      { event_id: eventId, rule_id: ruleId, playbook_id: playbookId },
      db
    );
    expect(created.id).toBeGreaterThan(0);
    expect(created.status).toBe("queued");
    expect(created.attempts).toBe(0);
    expect(created.rule_id).toBe(ruleId);
    expect(created.lease_id).toBeNull();
    expect(created.wisp_contract_id).toBeNull();
    expect(created.error).toBeNull();
    expect(created.created_at).toBe(created.updated_at);

    const fetched = await getDispatch(created.id, db);
    expect(fetched).toEqual(created);
  });

  it("defaults rule_id to null when omitted", async () => {
    const created = await newQueued();
    expect(created.rule_id).toBeNull();
  });

  it("returns undefined for a missing dispatch", async () => {
    expect(await getDispatch(9999, db)).toBeUndefined();
  });

  it("claimNextQueuedDispatch flips the oldest queued row to leasing", async () => {
    const a = await newQueued();
    const b = await newQueued();

    const claimed = await claimNextQueuedDispatch(db);
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe("leasing");
    expect(claimed?.updated_at).toBeGreaterThanOrEqual(a.updated_at);

    // The row is persisted as leasing; b is untouched.
    expect((await getDispatch(a.id, db))?.status).toBe("leasing");
    expect((await getDispatch(b.id, db))?.status).toBe("queued");
  });

  it("returns null when there is nothing queued", async () => {
    expect(await claimNextQueuedDispatch(db)).toBeNull();

    const a = await newQueued();
    await claimNextQueuedDispatch(db);
    // a is now leasing, none queued remain.
    expect(await claimNextQueuedDispatch(db)).toBeNull();
    expect((await getDispatch(a.id, db))?.status).toBe("leasing");
  });

  it("hands out rows strictly oldest-first across sequential claims", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await newQueued()).id);

    const claimed: number[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await claimNextQueuedDispatch(db);
      claimed.push(c!.id);
    }
    expect(claimed).toEqual(ids);
    expect(await claimNextQueuedDispatch(db)).toBeNull();
  });

  it("is atomic under interleaved concurrent claims: no duplicates, oldest-first", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) ids.push((await newQueued()).id);

    // Fire more claims than there are rows, all at once.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => claimNextQueuedDispatch(db))
    );

    const claimedIds = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => r.id);
    const nulls = results.filter((r) => r === null);

    // Every queued row was claimed exactly once, in FIFO order, and the
    // surplus claims each got null.
    expect(claimedIds).toEqual(ids);
    expect(new Set(claimedIds).size).toBe(ids.length);
    expect(nulls).toHaveLength(5);

    // Nothing is left queued.
    expect(await listDispatches("queued", db)).toHaveLength(0);
    expect(await listDispatches("leasing", db)).toHaveLength(20);
  });

  it("listDispatches filters by status and orders newest-first", async () => {
    const a = await newQueued();
    const b = await newQueued();
    const c = await newQueued();
    await updateDispatch(b.id, { status: "running" }, db);

    const all = await listDispatches(undefined, db);
    expect(all.map((d) => d.id)).toEqual([c.id, b.id, a.id]);

    const queued = await listDispatches("queued", db);
    expect(queued.map((d) => d.id)).toEqual([c.id, a.id]);

    const running = await listDispatches("running", db);
    expect(running.map((d) => d.id)).toEqual([b.id]);
  });

  it("updateDispatch writes provided fields, clears via null, and bumps updated_at", async () => {
    const created = await newQueued();

    const updated = await updateDispatch(
      created.id,
      {
        status: "running",
        lease_id: "lease-1",
        wisp_contract_id: "wc-1",
        attempts: 2,
        error: "boom",
      },
      db
    );
    expect(updated?.status).toBe("running");
    expect(updated?.lease_id).toBe("lease-1");
    expect(updated?.wisp_contract_id).toBe("wc-1");
    expect(updated?.attempts).toBe(2);
    expect(updated?.error).toBe("boom");
    expect(updated?.updated_at).toBeGreaterThanOrEqual(created.updated_at);

    const cleared = await updateDispatch(
      created.id,
      { lease_id: null, error: null },
      db
    );
    expect(cleared?.lease_id).toBeNull();
    expect(cleared?.error).toBeNull();
    // wisp_contract_id was not in the patch, so it is left unchanged.
    expect(cleared?.wisp_contract_id).toBe("wc-1");
  });

  it("returns undefined when updating a missing dispatch", async () => {
    expect(await updateDispatch(9999, { status: "done" }, db)).toBeUndefined();
  });

  it("resetToQueued returns a dispatch to queued and clears lease handles", async () => {
    const created = await newQueued();
    await updateDispatch(
      created.id,
      { status: "running", lease_id: "lease-1", wisp_contract_id: "wc-1" },
      db
    );

    const reset = await resetToQueued(created.id, db);
    expect(reset?.status).toBe("queued");
    expect(reset?.lease_id).toBeNull();
    expect(reset?.wisp_contract_id).toBeNull();

    // A reset row is claimable again.
    const claimed = await claimNextQueuedDispatch(db);
    expect(claimed?.id).toBe(created.id);
  });

  it(
    "resetToQueued clears release tracking from the prior attempt: released_at " +
      "and release_pending both reset",
    async () => {
      // Attempt 1: leased, ran, released successfully — the finally block
      // stamped released_at on the row before the retry decision.
      const created = await newQueued();
      await updateDispatch(
        created.id,
        {
          status: "failed",
          lease_id: "lease-1",
          wisp_contract_id: "wc-1",
          attempts: 1,
          released_at: 1_000,
          release_pending: false,
        },
        db
      );

      const reset = await resetToQueued(created.id, db);

      expect(reset?.status).toBe("queued");
      expect(reset?.lease_id).toBeNull();
      expect(reset?.wisp_contract_id).toBeNull();
      // The load-bearing invariant: release tracking describes the CURRENT
      // lease attempt, so nulling the handles must also null these.
      expect(reset?.released_at).toBeNull();
      expect(reset?.release_pending).toBe(false);
    }
  );

  it("resetToQueued preserves the attempts counter", async () => {
    const created = await newQueued();
    await updateDispatch(
      created.id,
      {
        status: "failed",
        lease_id: "lease-1",
        wisp_contract_id: "wc-1",
        attempts: 3,
        error: "boom",
      },
      db
    );

    const reset = await resetToQueued(created.id, db);
    // The retry counter must survive across the requeue — that's what caps
    // total attempts. rule_id/playbook_id/event_id are also untouched.
    expect(reset?.attempts).toBe(3);
    expect(reset?.playbook_id).toBe(created.playbook_id);
    expect(reset?.event_id).toBe(created.event_id);
  });

  it(
    "regression: a retried dispatch whose second lease's release fails is " +
      "still visible to the pending-release sweep",
    async () => {
      // Attempt 1: leased, ran, host died, finally-block released the lease
      // — released_at is stamped on the row. Dispatcher then requeues:
      const created = await newQueued();
      await updateDispatch(
        created.id,
        {
          status: "failed",
          lease_id: "lease-1",
          wisp_contract_id: "wc-1",
          attempts: 1,
          released_at: 1_000,
          release_pending: false,
        },
        db
      );
      await resetToQueued(created.id, db);

      // Attempt 2: a NEW lease is acquired and its release later fails, so
      // the executor flips release_pending. Before the fix, the stale
      // released_at from attempt 1 would still sit on the row, hiding this
      // leaked lease from the sweep forever.
      const claimed = await claimNextQueuedDispatch(db);
      expect(claimed?.id).toBe(created.id);
      await updateDispatch(
        created.id,
        {
          status: "failed",
          lease_id: "lease-2",
          wisp_contract_id: "wc-2",
          attempts: 2,
          release_pending: true,
        },
        db
      );

      const pending = await listDispatchesWithPendingRelease(db);
      expect(pending.map((d) => d.id)).toContain(created.id);
      const row = pending.find((d) => d.id === created.id);
      expect(row?.lease_id).toBe("lease-2");
      expect(row?.released_at).toBeNull();
      expect(row?.release_pending).toBe(true);
    }
  );

  it("returns undefined when resetting a missing dispatch", async () => {
    expect(await resetToQueued(9999, db)).toBeUndefined();
  });

  describe("subject-joined reads", () => {
    it("getDispatchWithSubject joins the triggering event's subject and payload hints", async () => {
      const richEvent = await insertEvent(
        {
          source: "moduleA",
          type: "workitem.updated",
          subject_kind: "workitem",
          subject_ref: "42",
          payload: {
            title: "Fix the widget",
            url: "https://example.test/wi/42",
            work_item_type: "Bug",
          },
        },
        db
      );
      const created = await createDispatch(
        { event_id: richEvent.id, playbook_id: playbookId },
        db
      );

      const withSubject = await getDispatchWithSubject(created.id, db);
      // Additive: every base dispatch field is still present…
      expect(withSubject).toMatchObject({
        id: created.id,
        event_id: richEvent.id,
        playbook_id: playbookId,
        status: "queued",
      });
      // …plus the joined subject block, including the opaque work_item_type hint.
      expect(withSubject).toMatchObject({
        subject_kind: "workitem",
        subject_ref: "42",
        event_type: "workitem.updated",
        subject_title: "Fix the widget",
        subject_url: "https://example.test/wi/42",
        subject_type: "Bug",
      });
    });

    it("yields null title/url when the payload lacks them, and undefined for a missing dispatch", async () => {
      // beforeEach's event has no payload → null hints, kind/ref/type still set.
      const created = await createDispatch(
        { event_id: eventId, playbook_id: playbookId },
        db
      );
      const withSubject = await getDispatchWithSubject(created.id, db);
      expect(withSubject).toMatchObject({
        subject_kind: "widget",
        subject_ref: "42",
        event_type: "thing.changed",
        subject_title: null,
        subject_url: null,
        subject_type: null,
      });

      expect(await getDispatchWithSubject(9999, db)).toBeUndefined();
    });

    it("listDispatchesWithSubject carries subject fields, filtered and newest-first", async () => {
      const a = await createDispatch(
        { event_id: eventId, playbook_id: playbookId },
        db
      );
      const b = await createDispatch(
        { event_id: eventId, playbook_id: playbookId },
        db
      );
      await updateDispatch(b.id, { status: "running" }, db);

      const all = await listDispatchesWithSubject({}, db);
      expect(all.map((d) => d.id)).toEqual([b.id, a.id]);
      for (const d of all) {
        expect(d.subject_kind).toBe("widget");
        expect(d.subject_ref).toBe("42");
        expect(d.event_type).toBe("thing.changed");
        expect(d.subject_title).toBeNull();
        expect(d.subject_url).toBeNull();
      }

      const running = await listDispatchesWithSubject({ status: "running" }, db);
      expect(running.map((d) => d.id)).toEqual([b.id]);
    });

    it("listDispatchesWithSubject active:true returns only non-terminal work", async () => {
      // One dispatch per lifecycle state; only the non-terminal four should
      // survive the `active` filter, newest-first.
      const states: DispatchStatus[] = [
        "queued",
        "leasing",
        "running",
        "collecting",
        "done",
        "failed",
      ];
      const ids: Record<string, number> = {};
      for (const status of states) {
        const d = await createDispatch(
          { event_id: eventId, playbook_id: playbookId },
          db
        );
        await updateDispatch(d.id, { status }, db);
        ids[status] = d.id;
      }

      const active = await listDispatchesWithSubject({ active: true }, db);
      expect(active.map((d) => d.status).sort()).toEqual(
        ["collecting", "leasing", "queued", "running"].sort()
      );
      expect(active.map((d) => d.id)).not.toContain(ids.done);
      expect(active.map((d) => d.id)).not.toContain(ids.failed);
      // Newest-first ordering is preserved (collecting was created last).
      expect(active[0].id).toBe(ids.collecting);

      // Combines with `status`: active + a terminal status yields nothing.
      const none = await listDispatchesWithSubject(
        { active: true, status: "done" },
        db
      );
      expect(none).toHaveLength(0);
    });
  });

  it("cancelQueuedDispatch wins only while the row is still queued", async () => {
    const { cancelQueuedDispatch } = await import("./dispatches");
    const queued = await createDispatch(
      { event_id: eventId, rule_id: ruleId, playbook_id: playbookId },
      db
    );
    const won = await cancelQueuedDispatch(queued.id, db);
    expect(won?.status).toBe("cancelled");
    expect(won?.error).toBe("cancelled");

    const created = await createDispatch(
      { event_id: eventId, rule_id: ruleId, playbook_id: playbookId },
      db
    );
    await updateDispatch(created.id, { status: "running" }, db);
    const running = { id: created.id };
    const lost = await cancelQueuedDispatch(running.id, db);
    expect(lost).toBeUndefined();
    const untouched = await getDispatch(running.id, db);
    expect(untouched?.status).toBe("running");
    expect(untouched?.error ?? null).toBeNull();
  });
});

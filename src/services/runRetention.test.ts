import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { insertEvent } from "../db/events";
import { createFinding, listFindings } from "../db/findings";
import { runMigrations } from "../db/migrate";
import { insertNotification } from "../db/notificationLog";
import { createPlaybook } from "../db/playbooks";
import { createRun, listRuns } from "../db/runs";
import { setSetting } from "../db/settings";
import type { DispatchStatus } from "../interfaces";

import { dispatchLogPath } from "./dispatchLog";
import {
  DEFAULT_RUN_RETENTION_MAX,
  pruneRunRetention,
  readRetentionCap,
} from "./runRetention";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("runRetention", () => {
  let dbDir: string;
  let logDir: string;
  let db: Knex;
  let eventId: number;
  let playbookId: number;

  beforeEach(async () => {
    dbDir = tempDir("orch-retention-db-");
    logDir = tempDir("orch-retention-logs-");
    db = createDb(path.join(dbDir, "test.sqlite"));
    await runMigrations(db);

    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "42",
        payload: {},
      },
      db
    );
    eventId = event.id;
    const playbook = await createPlaybook(
      { name: "pb", image: "img", ttl_seconds: 60 },
      db
    );
    playbookId = playbook.id;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /**
   * Insert a dispatch row directly so `created_at` and `status` are fully
   * controlled (the repo helper stamps "now" and defaults to queued). Returns
   * the new dispatch id.
   */
  async function seedDispatch(
    status: DispatchStatus,
    createdAt: number
  ): Promise<number> {
    const [row] = await db("dispatches")
      .insert({
        event_id: eventId,
        rule_id: null,
        playbook_id: playbookId,
        status,
        lease_id: null,
        wisp_contract_id: null,
        attempts: 0,
        error: null,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning("id");
    return typeof row === "number" ? row : row.id;
  }

  /** Write a non-empty per-dispatch log file under the test log dir. */
  function writeLog(dispatchId: number): string {
    const filePath = dispatchLogPath(dispatchId, logDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `log for ${dispatchId}\n`);
    return filePath;
  }

  describe("readRetentionCap", () => {
    it("defaults to 2000 when unset", async () => {
      expect(await readRetentionCap(db)).toBe(DEFAULT_RUN_RETENTION_MAX);
      expect(DEFAULT_RUN_RETENTION_MAX).toBe(2000);
    });

    it("falls back to the default for empty or garbage values", async () => {
      await setSetting("run_retention_max", "   ", db);
      expect(await readRetentionCap(db)).toBe(2000);
      await setSetting("run_retention_max", "not-a-number", db);
      expect(await readRetentionCap(db)).toBe(2000);
    });

    it("honors a parseable value, flooring fractional inputs", async () => {
      await setSetting("run_retention_max", "150.9", db);
      expect(await readRetentionCap(db)).toBe(150);
    });

    it("returns 0 or a negative value verbatim (the disable signal)", async () => {
      await setSetting("run_retention_max", "0", db);
      expect(await readRetentionCap(db)).toBe(0);
      await setSetting("run_retention_max", "-5", db);
      expect(await readRetentionCap(db)).toBe(-5);
    });
  });

  describe("pruneRunRetention", () => {
    it("prunes the oldest terminal dispatches beyond the cap, keeping the newest", async () => {
      await setSetting("run_retention_max", "2", db);
      // Five terminal dispatches, oldest (created_at) first.
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await seedDispatch(i % 2 === 0 ? "done" : "failed", 1000 + i));
      }

      const result = await pruneRunRetention({ db, logBaseDir: logDir });
      expect(result.cap).toBe(2);
      // 5 terminal, cap 2 → prune the 3 oldest.
      expect(result.prunedDispatches).toBe(3);

      const remaining = await db("dispatches").select("id").orderBy("id", "asc");
      // The two newest survive; the three oldest are gone.
      expect(remaining.map((r) => r.id)).toEqual([ids[3], ids[4]]);
    });

    it("is a no-op when the terminal count is at or under the cap", async () => {
      await setSetting("run_retention_max", "5", db);
      for (let i = 0; i < 3; i++) await seedDispatch("done", 1000 + i);

      const result = await pruneRunRetention({ db, logBaseDir: logDir });
      expect(result.prunedDispatches).toBe(0);
      expect(await db("dispatches").count({ n: "*" }).first()).toMatchObject({
        n: 3,
      });
    });

    it("cascades findings -> runs -> dispatch and removes the log file", async () => {
      await setSetting("run_retention_max", "1", db);

      const oldId = await seedDispatch("done", 1000);
      const oldLog = writeLog(oldId);
      const oldRun = await createRun({ dispatch_id: oldId }, db);
      await createFinding({ run_id: oldRun.id, content: "old finding" }, db);

      const newId = await seedDispatch("done", 2000);
      const newLog = writeLog(newId);
      const newRun = await createRun({ dispatch_id: newId }, db);
      await createFinding({ run_id: newRun.id, content: "new finding" }, db);

      const result = await pruneRunRetention({ db, logBaseDir: logDir });
      expect(result.prunedDispatches).toBe(1);

      // The old dispatch, its run, and its findings are all gone.
      expect(await db("dispatches").where({ id: oldId }).first()).toBeUndefined();
      expect(await listRuns(oldId, db)).toHaveLength(0);
      expect(await db("findings").where({ id: oldRun.id }).first())
        .toBeUndefined();
      expect(fs.existsSync(oldLog)).toBe(false);

      // The newest dispatch and its run/finding/log survive untouched.
      expect(await db("dispatches").where({ id: newId }).first()).toBeDefined();
      expect(await listRuns(newId, db)).toHaveLength(1);
      expect(await listFindings(newRun.id, db)).toHaveLength(1);
      expect(fs.existsSync(newLog)).toBe(true);
    });

    it("does not error when a pruned dispatch has no log file on disk", async () => {
      await setSetting("run_retention_max", "0", db); // temporarily disabled
      const oldId = await seedDispatch("done", 1000);
      await seedDispatch("done", 2000);
      // No log file was ever written for oldId.
      await setSetting("run_retention_max", "1", db);

      const result = await pruneRunRetention({ db, logBaseDir: logDir });
      expect(result.prunedDispatches).toBe(1);
      expect(await db("dispatches").where({ id: oldId }).first())
        .toBeUndefined();
    });

    it("never touches non-terminal dispatches", async () => {
      await setSetting("run_retention_max", "1", db);
      // Two terminal + one of each non-terminal state; only terminals count.
      await seedDispatch("done", 1000);
      await seedDispatch("failed", 1001);
      const queued = await seedDispatch("queued", 900);
      const leasing = await seedDispatch("leasing", 901);
      const running = await seedDispatch("running", 902);
      const collecting = await seedDispatch("collecting", 903);

      const result = await pruneRunRetention({ db, logBaseDir: logDir });
      // 2 terminal, cap 1 → prune 1 (the oldest terminal); non-terminals stay.
      expect(result.prunedDispatches).toBe(1);
      for (const id of [queued, leasing, running, collecting]) {
        expect(await db("dispatches").where({ id }).first()).toBeDefined();
      }
    });

    it("leaves the originating event and notification_log rows in place", async () => {
      await setSetting("run_retention_max", "1", db);
      const notif = await insertNotification(
        { event_id: eventId, title: "t", body: "b", status: "delivered" },
        db
      );
      await seedDispatch("done", 1000);
      await seedDispatch("done", 2000);

      await pruneRunRetention({ db, logBaseDir: logDir });

      // The event that triggered the pruned dispatch remains, as does the
      // notification log — retention only trims run history.
      expect(await db("events").where({ id: eventId }).first()).toBeDefined();
      expect(await db("notification_log").where({ id: notif.id }).first())
        .toBeDefined();
    });

    it("disables pruning entirely when the cap is 0 or negative", async () => {
      for (let i = 0; i < 4; i++) await seedDispatch("done", 1000 + i);

      await setSetting("run_retention_max", "0", db);
      expect(
        (await pruneRunRetention({ db, logBaseDir: logDir })).prunedDispatches
      ).toBe(0);

      await setSetting("run_retention_max", "-1", db);
      expect(
        (await pruneRunRetention({ db, logBaseDir: logDir })).prunedDispatches
      ).toBe(0);

      // All four terminal dispatches remain.
      expect(await db("dispatches").count({ n: "*" }).first()).toMatchObject({
        n: 4,
      });
    });

    it("prunes across multiple batches", async () => {
      // Exceed the 500-row batch size to exercise the chunking loop.
      await setSetting("run_retention_max", "10", db);
      const total = 1005;
      const rows = [];
      for (let i = 0; i < total; i++) {
        rows.push({
          event_id: eventId,
          rule_id: null,
          playbook_id: playbookId,
          status: "done",
          lease_id: null,
          wisp_contract_id: null,
          attempts: 0,
          error: null,
          created_at: 1000 + i,
          updated_at: 1000 + i,
        });
      }
      await db.batchInsert("dispatches", rows, 500);

      const result = await pruneRunRetention({ db, logBaseDir: logDir });
      expect(result.prunedDispatches).toBe(total - 10);
      expect(await db("dispatches").count({ n: "*" }).first()).toMatchObject({
        n: 10,
      });
    });
  });
});

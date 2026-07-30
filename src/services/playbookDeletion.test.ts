import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { createDispatch } from "../db/dispatches";
import { insertEvent } from "../db/events";
import { createFinding } from "../db/findings";
import { runMigrations } from "../db/migrate";
import { createPlaybook, getPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import { createRun } from "../db/runs";
import type { DispatchStatus } from "../interfaces";

import { dispatchLogPath } from "./dispatchLog";
import {
  deletePlaybookWithHistory,
  getPlaybookUsage,
} from "./playbookDeletion";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("playbookDeletion", () => {
  let dbDir: string;
  let logDir: string;
  let db: Knex;
  let eventId: number;

  beforeEach(async () => {
    dbDir = tempDir("orch-pbdel-db-");
    logDir = tempDir("orch-pbdel-logs-");
    db = createDb(path.join(dbDir, "test.sqlite"));
    await runMigrations(db);
    // Migrations seed a built-in playbook; start clean for deterministic counts.
    await db("playbooks").del();
    const event = await insertEvent(
      { source: "s", type: "t", subject_kind: "k", subject_ref: "r", payload: {} },
      db
    );
    eventId = event.id;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** Seed a dispatch (given status) + run + finding + a log file on disk. */
  async function seedRun(
    playbookId: number,
    status: DispatchStatus
  ): Promise<{ dispatchId: number; logPath: string }> {
    const dispatch = await createDispatch(
      { event_id: eventId, playbook_id: playbookId, status },
      db
    );
    const run = await createRun({ dispatch_id: dispatch.id }, db);
    await createFinding({ run_id: run.id, content: "f" }, db);
    const logPath = dispatchLogPath(dispatch.id, logDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `log ${dispatch.id}\n`);
    return { dispatchId: dispatch.id, logPath };
  }

  describe("deletePlaybookWithHistory", () => {
    it("cascades terminal dispatches, runs, findings, and log files, then the row", async () => {
      const pb = await createPlaybook(
        { name: "pb", image: "img", ttl_seconds: 60 },
        db
      );
      const a = await seedRun(pb.id, "done");
      const b = await seedRun(pb.id, "failed");

      const result = await deletePlaybookWithHistory(pb.id, {
        db,
        logBaseDir: logDir,
      });
      expect(result).toEqual({ outcome: "deleted" });

      expect(await getPlaybook(pb.id, db)).toBeUndefined();
      for (const { dispatchId, logPath } of [a, b]) {
        expect(await db("dispatches").where({ id: dispatchId }).first())
          .toBeUndefined();
        expect(fs.existsSync(logPath)).toBe(false);
      }
      expect(await db("runs").count({ n: "*" }).first()).toMatchObject({ n: 0 });
      expect(await db("findings").count({ n: "*" }).first()).toMatchObject({
        n: 0,
      });
    });

    it("refuses (in_flight) and deletes nothing when a non-terminal dispatch exists", async () => {
      const pb = await createPlaybook(
        { name: "pb", image: "img", ttl_seconds: 60 },
        db
      );
      const terminal = await seedRun(pb.id, "done");
      await seedRun(pb.id, "leasing");
      await seedRun(pb.id, "queued");

      const result = await deletePlaybookWithHistory(pb.id, {
        db,
        logBaseDir: logDir,
      });
      expect(result).toEqual({ outcome: "in_flight", inFlight: 2 });

      // Nothing removed — the playbook, all dispatches, and the log file remain.
      expect(await getPlaybook(pb.id, db)).toBeDefined();
      expect(await db("dispatches").count({ n: "*" }).first()).toMatchObject({
        n: 3,
      });
      expect(fs.existsSync(terminal.logPath)).toBe(true);
    });

    it("reports not_found for a missing playbook", async () => {
      expect(await deletePlaybookWithHistory(9999, { db })).toEqual({
        outcome: "not_found",
      });
    });

    it("does not error when a terminal dispatch has no log file on disk", async () => {
      const pb = await createPlaybook(
        { name: "pb", image: "img", ttl_seconds: 60 },
        db
      );
      // A terminal dispatch that never wrote a log.
      const dispatch = await createDispatch(
        { event_id: eventId, playbook_id: pb.id, status: "done" },
        db
      );

      const result = await deletePlaybookWithHistory(pb.id, {
        db,
        logBaseDir: logDir,
      });
      expect(result).toEqual({ outcome: "deleted" });
      expect(await db("dispatches").where({ id: dispatch.id }).first())
        .toBeUndefined();
    });
  });

  describe("getPlaybookUsage", () => {
    it("counts run history and lists only enabled referencing rules", async () => {
      const pb = await createPlaybook(
        { name: "pb", image: "img", ttl_seconds: 60 },
        db
      );
      await seedRun(pb.id, "done");
      await seedRun(pb.id, "failed");
      await seedRun(pb.id, "running");
      const enabled = await createRule(
        { name: "on", enabled: true, dispatch: [{ playbook_id: pb.id }] },
        db
      );
      await createRule(
        { name: "off", enabled: false, dispatch: [{ playbook_id: pb.id }] },
        db
      );

      const usage = await getPlaybookUsage(pb.id, db);
      expect(usage).toEqual({
        dispatches: 3,
        runs: 3,
        findings: 3,
        in_flight: 1,
        referencing_rules: [{ id: enabled.id, name: "on" }],
      });
    });
  });
});

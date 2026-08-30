import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";
import { insertEvent } from "../events";
import { listNotifiers } from "../notifiers";
import { listPlaybooks } from "../playbooks";
import { listRules } from "../rules";

/** Every migration up to (but NOT including) the 026 cleanup migration. */
const LAST_PRE_026_MIGRATION = "20260713000025_smoke_test_credential_leak_hunt";

const SMOKE_TEST_PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const NOTIFIER_NAME = "desktop";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-drop-seed-"));
  return path.join(dir, "test.sqlite");
}

/**
 * Bring the schema up through 025 (the last of the historical seed migrations,
 * now a no-op stub) but NOT through 026. On a fresh DB this leaves every
 * table empty, so tests can inject the seed rows themselves to simulate an
 * upgraded install that carried the old seed forward.
 */
async function migrateToJustBefore026(db: Knex): Promise<void> {
  for (;;) {
    const [, applied] = await db.migrate.up();
    if (applied.includes(LAST_PRE_026_MIGRATION)) return;
    if (applied.length === 0) {
      throw new Error("ran out of migrations before reaching pre-026 marker");
    }
  }
}

/**
 * Insert the historical smoke-test seed rows (as an older orchestrator's 023
 * migration would have written them) so the 026 cleanup migration has
 * something to look at. `ts` is used for both `created_at` and `updated_at`
 * so the row starts pristine; callers bump `updated_at` explicitly when they
 * want to simulate a user edit.
 */
async function insertPristineSeed(db: Knex, ts: number): Promise<{
  playbookId: number;
  notifierId: number;
  dispatchRuleIds: number[];
  notifyRuleIds: number[];
}> {
  const [playbookId] = await db("playbooks").insert({
    name: SMOKE_TEST_PLAYBOOK_NAME,
    image: "setting:default_lease_image",
    host: null,
    isolation: null,
    ttl_seconds: 1800,
    resources: JSON.stringify({ cpus: 2, memory_mb: 4096 }),
    network: "open",
    userdata_template: "#!/bin/sh\nexit 0",
    prompt_template: "seed",
    runner: "claude-code",
    runner_config: JSON.stringify({}),
    env_requirements: JSON.stringify([
      "CLAUDE_CODE_OAUTH_TOKEN",
      { name: "ADO_PAT", inject: "step-only" },
    ]),
    steps: JSON.stringify([]),
    granted_capabilities: JSON.stringify([]),
    output_kind: "findings",
    created_at: ts,
    updated_at: ts,
  });
  const [notifierId] = await db("notifiers").insert({
    name: NOTIFIER_NAME,
    config: JSON.stringify({}),
    title_template: "t",
    body_template: "b",
    enabled: 1,
    created_at: ts,
    updated_at: ts,
  });
  const dispatchRuleIds: number[] = [];
  for (const eventType of [
    "ado.workitem.created",
    "ado.workitem.updated",
    "ado.workitem.tagged",
    "ado.workitem.assigned",
    "ado.workitem.state_changed",
    "ado.workitem.area_changed",
    "ado.workitem.iteration_changed",
  ]) {
    const [id] = await db("rules").insert({
      name: `smoke test: ${eventType}`,
      enabled: 1,
      match: JSON.stringify({
        source: "ado",
        type: eventType,
        criteria: { tags: { contains: SMOKE_TEST_PLAYBOOK_NAME } },
      }),
      dispatch: JSON.stringify([{ playbook_id: playbookId }]),
      notify: JSON.stringify([]),
      created_at: ts,
      updated_at: ts,
    });
    dispatchRuleIds.push(Number(id));
  }
  const notifyRuleIds: number[] = [];
  for (const spec of [
    { name: "Smoke test started", type: "run.started" },
    { name: "Smoke test finished", type: "run.completed" },
    { name: "Smoke test failed", type: "run.failed" },
  ]) {
    const [id] = await db("rules").insert({
      name: spec.name,
      enabled: 1,
      match: JSON.stringify({
        source: "orchestrator",
        type: spec.type,
        criteria: { playbook_name: SMOKE_TEST_PLAYBOOK_NAME },
      }),
      dispatch: JSON.stringify([]),
      notify: JSON.stringify([{ notifier_id: notifierId }]),
      created_at: ts,
      updated_at: ts,
    });
    notifyRuleIds.push(Number(id));
  }
  return {
    playbookId: Number(playbookId),
    notifierId: Number(notifierId),
    dispatchRuleIds,
    notifyRuleIds,
  };
}

describe("drop seed smoke-test content migration (026)", () => {
  let file: string;
  let db: Knex;

  beforeEach(() => {
    file = tempDbFile();
    db = createDb(file);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("fresh DB (every migration in one pass)", () => {
    beforeEach(async () => {
      await runMigrations(db);
    });

    it("leaves the playbooks, rules, and notifiers tables EMPTY", async () => {
      expect(await listPlaybooks(db)).toEqual([]);
      expect(await listRules(db)).toEqual([]);
      expect(await listNotifiers(db)).toEqual([]);
    });
  });

  describe("upgraded DB: 026 applied on top of pristine seed rows", () => {
    it("removes the playbook, notifier, and all seeded rules when nothing has been touched", async () => {
      await migrateToJustBefore026(db);
      await insertPristineSeed(db, 100);

      // The seed is there before 026 runs.
      expect(
        (await listPlaybooks(db)).find((p) => p.name === SMOKE_TEST_PLAYBOOK_NAME)
      ).toBeDefined();
      expect(
        (await listNotifiers(db)).find((n) => n.name === NOTIFIER_NAME)
      ).toBeDefined();
      expect((await listRules(db)).length).toBe(10);

      await runMigrations(db);

      // ...and gone after.
      expect(await listPlaybooks(db)).toEqual([]);
      expect(await listNotifiers(db)).toEqual([]);
      expect(await listRules(db)).toEqual([]);
    });

    it("KEEPS the playbook when the user has customized it (updated_at !== created_at)", async () => {
      await migrateToJustBefore026(db);
      const { playbookId } = await insertPristineSeed(db, 100);
      // Simulate a UI edit that bumped updated_at on the playbook only.
      await db("playbooks")
        .where({ id: playbookId })
        .update({ ttl_seconds: 42, updated_at: 200 });

      await runMigrations(db);

      const post = (await listPlaybooks(db)).find(
        (p) => p.name === SMOKE_TEST_PLAYBOOK_NAME
      );
      expect(post).toBeDefined();
      expect(post!.ttl_seconds).toBe(42);
    });

    it("KEEPS the playbook when a dispatch references it, even if pristine", async () => {
      await migrateToJustBefore026(db);
      const { playbookId } = await insertPristineSeed(db, 100);
      const event = await insertEvent(
        {
          source: "test",
          type: "test.event",
          subject_kind: "test",
          subject_ref: "x",
          payload: {},
        },
        db
      );
      await db("dispatches").insert({
        event_id: event.id,
        playbook_id: playbookId,
        status: "done",
        attempts: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      await runMigrations(db);

      const post = (await listPlaybooks(db)).find(
        (p) => p.name === SMOKE_TEST_PLAYBOOK_NAME
      );
      expect(post).toBeDefined();
    });

    it("KEEPS a user-edited notifier and leaves its seeded rules alone if they were also edited", async () => {
      await migrateToJustBefore026(db);
      const { notifierId, notifyRuleIds } = await insertPristineSeed(db, 100);
      // A user renamed one of the notify rules and edited the notifier.
      await db("notifiers")
        .where({ id: notifierId })
        .update({ title_template: "custom", updated_at: 200 });
      await db("rules")
        .where({ id: notifyRuleIds[0] })
        .update({ enabled: 0, updated_at: 200 });

      await runMigrations(db);

      const notifier = (await listNotifiers(db)).find(
        (n) => n.name === NOTIFIER_NAME
      );
      expect(notifier).toBeDefined();
      expect(notifier!.title_template).toBe("custom");
      // The customized rule survives; the untouched sibling rules are gone.
      const rulesLeft = await listRules(db);
      expect(rulesLeft.find((r) => r.id === notifyRuleIds[0])).toBeDefined();
      expect(rulesLeft.find((r) => r.id === notifyRuleIds[1])).toBeUndefined();
    });

    it("removes only the seeded dispatch rules that are still pristine", async () => {
      await migrateToJustBefore026(db);
      const { dispatchRuleIds } = await insertPristineSeed(db, 100);
      // User edits the first three dispatch rules but leaves the rest pristine.
      const edited = dispatchRuleIds.slice(0, 3);
      await db("rules").whereIn("id", edited).update({ updated_at: 200 });

      await runMigrations(db);

      const remaining = await listRules(db);
      const remainingIds = remaining.map((r) => r.id);
      for (const id of edited) expect(remainingIds).toContain(id);
      for (const id of dispatchRuleIds.slice(3)) {
        expect(remainingIds).not.toContain(id);
      }
    });

    it("is idempotent on a re-run (already-removed rows stay removed)", async () => {
      await migrateToJustBefore026(db);
      await insertPristineSeed(db, 100);
      await runMigrations(db);

      // Bringing the schema up again finds nothing to delete and does not
      // throw or resurrect anything.
      await runMigrations(db);
      expect(await listPlaybooks(db)).toEqual([]);
      expect(await listRules(db)).toEqual([]);
      expect(await listNotifiers(db)).toEqual([]);
    });
  });

  describe("upgraded DB with a legacy pristine researcher", () => {
    it("removes an unmodified researcher playbook too", async () => {
      await migrateToJustBefore026(db);
      // Simulate an old DB where migration 009 seeded the researcher and 023
      // (which used to remove it) never ran.
      const [researcherId] = await db("playbooks").insert({
        name: "researcher",
        image: "setting:default_lease_image",
        host: null,
        isolation: null,
        ttl_seconds: 3600,
        resources: JSON.stringify({}),
        network: "open",
        userdata_template: "",
        prompt_template: "seed",
        runner: "claude-code",
        runner_config: JSON.stringify({}),
        env_requirements: JSON.stringify([]),
        steps: JSON.stringify([]),
        granted_capabilities: JSON.stringify([]),
        output_kind: "findings",
        created_at: 50,
        updated_at: 50,
      });

      await runMigrations(db);

      expect(
        (await listPlaybooks(db)).find((p) => p.name === "researcher")
      ).toBeUndefined();
      // Bind used so eslint/tsc do not complain about the unused id.
      expect(researcherId).toBeGreaterThan(0);
    });
  });
});

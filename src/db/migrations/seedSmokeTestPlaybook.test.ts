import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";
import { insertEvent } from "../events";
import { getPlaybook, listPlaybooks } from "../playbooks";
import { listRules } from "../rules";
import { listNotifiers } from "../notifiers";

/** Every migration up to (but NOT including) the 023 smoke-test seed. */
const LAST_PRE_023_MIGRATION = "20260713000022_dispatch_release_tracking";

const SMOKE_TEST_NAME = "smoke-test-clone-and-claude-linux";
const NOTIFIER_NAME = "desktop";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-smoke-seed-"));
  return path.join(dir, "test.sqlite");
}

/**
 * Bring the schema up through the 022 dispatch-release-tracking migration
 * but NOT through 023, so the seeded researcher is present and untouched.
 * `migrate.up()` (no args) applies one migration at a time; loop until we
 * cross the last pre-023 marker (mirrors playbookRunner.test.ts's approach).
 */
async function migrateToJustBefore023(db: Knex): Promise<void> {
  for (;;) {
    const [, applied] = await db.migrate.up();
    if (applied.includes(LAST_PRE_023_MIGRATION)) return;
    if (applied.length === 0) {
      throw new Error("ran out of migrations before reaching pre-023 marker");
    }
  }
}

describe("smoke-test playbook seed migration (023)", () => {
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

  describe("fresh DB (009 then 023 in one latest() pass)", () => {
    beforeEach(async () => {
      await runMigrations(db);
    });

    it("leaves ONLY the smoke-test playbook seeded — no researcher, no GIT_TOKEN", async () => {
      const names = (await listPlaybooks(db)).map((p) => p.name).sort();
      expect(names).toEqual([SMOKE_TEST_NAME]);

      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === SMOKE_TEST_NAME
      );
      expect(smoke).toBeDefined();
      const env = smoke!.env_requirements;
      // No GIT_TOKEN warning: the smoke-test playbook doesn't require it.
      expect(env).not.toContainEqual("GIT_TOKEN");
      expect(env).not.toContainEqual({ name: "GIT_TOKEN", inject: "step-only" });
    });

    it("seeds the smoke-test playbook with the expected shape", async () => {
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === SMOKE_TEST_NAME
      )!;
      expect(smoke.image).toBe("setting:default_lease_image");
      expect(smoke.ttl_seconds).toBe(1800);
      expect(smoke.network).toBe("open");
      expect(smoke.resources).toEqual({ cpus: 2, memory_mb: 4096 });
      expect(smoke.runner).toBe("claude-code");
      expect(smoke.output_kind).toBe("findings");
      // env_requirements: plain string for CLAUDE_CODE_OAUTH_TOKEN, object
      // form for ADO_PAT to keep it out of the lease environment.
      expect(smoke.env_requirements).toContainEqual("CLAUDE_CODE_OAUTH_TOKEN");
      expect(smoke.env_requirements).toContainEqual({
        name: "ADO_PAT",
        inject: "step-only",
      });
      // Four ordered pre steps: install az, clone, scrub, install claude.
      const steps = smoke.steps as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(4);
      expect(steps.map((s) => s.label)).toEqual([
        "install azure cli",
        "clone first repo in project",
        "scrub credentials (step-only PAT never survives past this step)",
        "install claude code",
      ]);
      for (const step of steps) expect(step.phase).toBe("pre");
      // Pre-step templates render the PAT and derive ORG/PROJECT generically.
      const clone = steps[1].command_template as string;
      expect(clone).toContain("{{env.ADO_PAT}}");
      expect(clone).toContain("{{payload.api_url}}");
      expect(clone).toContain("{{payload.area_path}}");
      expect(clone).toContain("az repos list");
    });

    it("seeds one dispatch rule per ADO work-item event type", async () => {
      const rules = await listRules(db);
      const dispatchRules = rules.filter((r) => r.name.startsWith("smoke test: "));
      const eventTypes = dispatchRules
        .map((r) => r.match.type)
        .filter((t): t is string => typeof t === "string")
        .sort();
      expect(eventTypes).toEqual([
        "ado.workitem.area_changed",
        "ado.workitem.assigned",
        "ado.workitem.created",
        "ado.workitem.iteration_changed",
        "ado.workitem.state_changed",
        "ado.workitem.tagged",
        "ado.workitem.updated",
      ]);
      for (const rule of dispatchRules) {
        expect(rule.enabled).toBe(true);
        expect(rule.match.source).toBe("ado");
        expect(rule.match.criteria).toEqual({
          tags: { contains: SMOKE_TEST_NAME },
        });
        expect(rule.dispatch).toHaveLength(1);
      }
      // Every dispatch target points at the seeded playbook.
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === SMOKE_TEST_NAME
      )!;
      for (const rule of dispatchRules) {
        expect(rule.dispatch[0].playbook_id).toBe(smoke.id);
      }
    });

    it("seeds the desktop notifier and two notify rules that reference it", async () => {
      const notifiers = await listNotifiers(db);
      const desktop = notifiers.find((n) => n.name === NOTIFIER_NAME);
      expect(desktop).toBeDefined();
      expect(desktop!.enabled).toBe(true);

      const rules = await listRules(db);
      const started = rules.find((r) => r.name === "Smoke test started");
      const finished = rules.find((r) => r.name === "Smoke test finished");
      expect(started).toBeDefined();
      expect(finished).toBeDefined();

      // Both notify rules match the run-lifecycle callback events keyed to
      // this playbook's name — the same shape the dispatcher emits.
      for (const rule of [started!, finished!]) {
        expect(rule.enabled).toBe(true);
        expect(rule.match.source).toBe("orchestrator");
        expect(rule.match.criteria).toEqual({
          playbook_name: SMOKE_TEST_NAME,
        });
        expect(rule.dispatch).toHaveLength(0);
        expect(rule.notify).toEqual([{ notifier_id: desktop!.id }]);
      }
      expect(started!.match.type).toBe("run.started");
      expect(finished!.match.type).toBe("run.completed");
    });

    it("is idempotent: a second migrate pass keeps counts stable", async () => {
      const before = {
        playbooks: (await listPlaybooks(db)).length,
        rules: (await listRules(db)).length,
        notifiers: (await listNotifiers(db)).length,
      };
      await runMigrations(db);
      const after = {
        playbooks: (await listPlaybooks(db)).length,
        rules: (await listRules(db)).length,
        notifiers: (await listNotifiers(db)).length,
      };
      expect(after).toEqual(before);
    });
  });

  describe("upgraded DB: 023 applied on top of an existing researcher", () => {
    it("removes an UNMODIFIED researcher (updated_at === created_at, no dispatches)", async () => {
      await migrateToJustBefore023(db);
      // Confirm 009's researcher is there and unmodified.
      const pre = (await listPlaybooks(db)).find((p) => p.name === "researcher");
      expect(pre).toBeDefined();
      expect(pre!.updated_at).toBe(pre!.created_at);

      await runMigrations(db);

      const post = (await listPlaybooks(db)).find((p) => p.name === "researcher");
      expect(post).toBeUndefined();
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === SMOKE_TEST_NAME
      );
      expect(smoke).toBeDefined();
    });

    it("KEEPS a USER-MODIFIED researcher (updated_at !== created_at)", async () => {
      await migrateToJustBefore023(db);
      const pre = (await listPlaybooks(db)).find((p) => p.name === "researcher");
      expect(pre).toBeDefined();
      // Simulate a user edit that bumped updated_at without deleting the row.
      await db("playbooks")
        .where({ id: pre!.id })
        .update({ ttl_seconds: 42, updated_at: pre!.updated_at + 1 });

      await runMigrations(db);

      const post = await getPlaybook(pre!.id, db);
      expect(post).toBeDefined();
      expect(post!.name).toBe("researcher");
      expect(post!.ttl_seconds).toBe(42);
      // The smoke-test seed still lands alongside the preserved researcher.
      expect(
        (await listPlaybooks(db)).find((p) => p.name === SMOKE_TEST_NAME)
      ).toBeDefined();
    });

    it("KEEPS a researcher that a dispatch references, even if unmodified", async () => {
      await migrateToJustBefore023(db);
      const pre = (await listPlaybooks(db)).find((p) => p.name === "researcher");
      expect(pre).toBeDefined();
      expect(pre!.updated_at).toBe(pre!.created_at);

      // Enqueue a dispatch referencing the researcher — a user ran it once,
      // so the run history still points at this playbook_id. Deleting the
      // playbook would either trip the FK or silently strand history rows;
      // the migration must skip.
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
        playbook_id: pre!.id,
        status: "done",
        attempts: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      await runMigrations(db);

      const post = await getPlaybook(pre!.id, db);
      expect(post).toBeDefined();
      expect(post!.name).toBe("researcher");
    });
  });
});

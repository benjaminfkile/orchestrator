import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runner-mig-"));
  return path.join(dir, "test.sqlite");
}

/** Minimal not-null columns a pre-018 playbook row needs (model/allowed_tools nullable). */
function legacyRow(
  over: Partial<{ model: string | null; allowed_tools: string | null }> & {
    name: string;
  }
): Record<string, unknown> {
  return {
    image: "img",
    ttl_seconds: 60,
    userdata_template: "",
    prompt_template: "",
    model: null,
    allowed_tools: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("playbook runner migration", () => {
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

  it("adds runner + runner_config and drops model + allowed_tools", async () => {
    expect(await db.schema.hasColumn("playbooks", "runner")).toBe(true);
    expect(await db.schema.hasColumn("playbooks", "runner_config")).toBe(true);
    expect(await db.schema.hasColumn("playbooks", "model")).toBe(false);
    expect(await db.schema.hasColumn("playbooks", "allowed_tools")).toBe(false);
  });

  it("defaults new rows to the claude-code runner with an empty config", async () => {
    // The seeded researcher went through the backfill; both its fields survive.
    const seeded = await db("playbooks").where({ name: "researcher" }).first();
    expect(seeded.runner).toBe("claude-code");
    expect(JSON.parse(seeded.runner_config)).toEqual({});
  });

  it("backfills runner_config from model/allowed_tools, omitting null fields", async () => {
    // Roll back the drop so the legacy columns exist, insert rows carrying the
    // four combinations of model/allowed_tools, then re-apply and inspect the
    // folded runner_config. Existing rows keep identical effective behavior: the
    // claude-code runner reads exactly these keys back out of runner_config.
    await db.migrate.down({ name: "20260713000018_playbook_runner" }); // revert
    expect(await db.schema.hasColumn("playbooks", "model")).toBe(true);
    expect(await db.schema.hasColumn("playbooks", "runner_config")).toBe(false);

    await db("playbooks").insert([
      legacyRow({
        name: "both",
        model: "claude-opus-4-8",
        allowed_tools: JSON.stringify(["Read", "Bash"]),
      }),
      legacyRow({ name: "model-only", model: "claude-sonnet-5" }),
      legacyRow({
        name: "tools-only",
        allowed_tools: JSON.stringify(["Grep"]),
      }),
      legacyRow({ name: "neither" }),
    ]);

    await db.migrate.up({ name: "20260713000018_playbook_runner" }); // re-apply
    expect(await db.schema.hasColumn("playbooks", "model")).toBe(false);

    const rows = await db("playbooks").whereIn("name", [
      "both",
      "model-only",
      "tools-only",
      "neither",
    ]);
    const byName = Object.fromEntries(
      rows.map((r) => [r.name, JSON.parse(r.runner_config)])
    );
    expect(byName.both).toEqual({
      model: "claude-opus-4-8",
      allowed_tools: ["Read", "Bash"],
    });
    expect(byName["model-only"]).toEqual({ model: "claude-sonnet-5" });
    expect(byName["tools-only"]).toEqual({ allowed_tools: ["Grep"] });
    expect(byName.neither).toEqual({});

    // Every backfilled row names the default runner.
    for (const row of rows) {
      expect(row.runner).toBe("claude-code");
    }
  });

  it("applies on a DB with dispatches referencing playbooks (FK-safe rebuild)", async () => {
    // Regression: dropping model/allowed_tools rebuilds the playbooks table
    // (create -> copy -> DROP old -> rename). With foreign_keys ON and child
    // dispatches rows referencing playbooks, the DROP tripped the FK and the
    // app could not boot. A fresh DB never reproduces it -- we MUST seed an
    // FK-referencing dispatch row at migration 017 before applying 018.
    //
    // Stand up a SECOND database migrated only to 017 so we control the moment
    // the referencing row exists. createDb is the exact production path, and it
    // yields a connection with foreign_keys already ON (assert it below), so
    // this matches how src/db/db.ts enables enforcement in production.
    const fkFile = tempDbFile();
    const fkDb = createDb(fkFile);
    try {
      // Bring the schema up to (and including) 017 only, so 018 has not run yet.
      for (;;) {
        const [, applied] = await fkDb.migrate.up();
        if (applied.includes("20260713000017_drop_notifier_kind")) break;
        if (applied.length === 0) {
          throw new Error("ran out of migrations before reaching 017");
        }
      }
      expect(await fkDb.schema.hasColumn("playbooks", "model")).toBe(true);
      expect(await fkDb.schema.hasColumn("playbooks", "runner")).toBe(false);

      // Enforcement must be ON for this test to be meaningful -- otherwise the
      // DROP during the rebuild would never trip the FK and the bug is masked.
      const [pragma] = await fkDb.raw("PRAGMA foreign_keys");
      expect(pragma.foreign_keys).toBe(1);

      // Seed a playbook, the event a dispatch needs, and a dispatch that
      // references BOTH. The dispatch's playbook_id is the FK that the rebuild's
      // DROP TABLE "playbooks" would violate.
      const [playbookId] = await fkDb("playbooks").insert(
        legacyRow({ name: "referenced", model: "claude-opus-4-8" })
      );
      const [eventId] = await fkDb("events").insert({
        source: "test",
        type: "test.event",
        subject_kind: "test",
        subject_ref: "ref-1",
        payload: "{}",
        ts: 1,
      });
      await fkDb("dispatches").insert({
        event_id: eventId,
        playbook_id: playbookId,
        status: "done",
        attempts: 0,
        created_at: 1,
        updated_at: 1,
      });

      // Apply the remaining migrations (018). Before the fix this threw
      // `DROP TABLE "playbooks" - FOREIGN KEY constraint failed`.
      await runMigrations(fkDb);

      // The rebuild succeeded: new columns exist and the legacy ones are gone.
      expect(await fkDb.schema.hasColumn("playbooks", "runner_config")).toBe(true);
      expect(await fkDb.schema.hasColumn("playbooks", "model")).toBe(false);

      // model was folded into runner_config by the backfill.
      const playbook = await fkDb("playbooks").where({ id: playbookId }).first();
      expect(playbook.runner).toBe("claude-code");
      expect(JSON.parse(playbook.runner_config)).toEqual({
        model: "claude-opus-4-8",
      });

      // The FK still resolves: the dispatch row joins to its (rebuilt) playbook.
      const joined = await fkDb("dispatches")
        .join("playbooks", "dispatches.playbook_id", "playbooks.id")
        .where("dispatches.event_id", eventId)
        .select("playbooks.name as playbook_name")
        .first();
      expect(joined.playbook_name).toBe("referenced");

      // Enforcement is restored after the migration.
      const [pragmaAfter] = await fkDb.raw("PRAGMA foreign_keys");
      expect(pragmaAfter.foreign_keys).toBe(1);
    } finally {
      await fkDb.destroy();
      fs.rmSync(path.dirname(fkFile), { recursive: true, force: true });
    }
  });

  it("down migration unpacks runner_config back into model/allowed_tools", async () => {
    // Insert a modern row via the repo path, roll back, and confirm the legacy
    // columns are reconstructed from runner_config.
    await db("playbooks").insert({
      name: "modern",
      image: "img",
      ttl_seconds: 60,
      userdata_template: "",
      prompt_template: "",
      runner: "claude-code",
      runner_config: JSON.stringify({
        model: "claude-opus-4-8",
        allowed_tools: ["Read"],
      }),
      created_at: 1,
      updated_at: 1,
    });

    await db.migrate.down({ name: "20260713000018_playbook_runner" }); // revert
    const row = await db("playbooks").where({ name: "modern" }).first();
    expect(row.model).toBe("claude-opus-4-8");
    expect(JSON.parse(row.allowed_tools)).toEqual(["Read"]);
  });
});

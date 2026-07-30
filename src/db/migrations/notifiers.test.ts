import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notifiers-mig-"));
  return path.join(dir, "test.sqlite");
}

describe("notifiers migration", () => {
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

  it("creates the notifiers and notification_log tables", async () => {
    expect(await db.schema.hasTable("notifiers")).toBe(true);
    expect(await db.schema.hasTable("notification_log")).toBe(true);
  });

  it("round-trips a notifier row with its column defaults", async () => {
    await db("notifiers").insert({
      name: "inbox",
      created_at: 1,
      updated_at: 1,
    });
    const row = await db("notifiers").where({ name: "inbox" }).first();
    expect(row.config).toBe("{}");
    expect(row.title_template).toBe("");
    expect(row.body_template).toBe("");
    // sqlite stores booleans as 0/1.
    expect(row.enabled).toBe(1);
  });

  it("declares a unique index on the notifier name", async () => {
    // Assert the schema shape (a UNIQUE index on `name`) rather than exercising
    // the driver's throw behavior, which the repo-level test already covers.
    const rows = await db.raw(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifiers'"
    );
    const indexNames = (rows as { name: string }[]).map((r) => r.name);
    expect(indexNames).toContain("notifiers_name_unique");
  });

  it("adds rules.notify defaulting to an empty JSON array", async () => {
    expect(await db.schema.hasColumn("rules", "notify")).toBe(true);
    // Insert a rule the low-level way, omitting notify, to exercise the DEFAULT.
    await db("rules").insert({
      name: "r",
      enabled: true,
      match: "{}",
      dispatch: "[]",
      created_at: 1,
      updated_at: 1,
    });
    const row = await db("rules").where({ name: "r" }).first();
    expect(row.notify).toBe("[]");
  });

  it("round-trips down() by dropping the notify column and tables", async () => {
    // Roll back the drop-kind migration and then the notifiers migration, and
    // confirm the schema is restored. Target each by name: later migrations sit
    // on top of these, so a bare down() would revert the newest one instead.
    await db.migrate.down({ name: "20260713000017_drop_notifier_kind" });
    await db.migrate.down({ name: "20260713000016_notifiers" });
    expect(await db.schema.hasTable("notifiers")).toBe(false);
    expect(await db.schema.hasTable("notification_log")).toBe(false);
    expect(await db.schema.hasColumn("rules", "notify")).toBe(false);
  });
});

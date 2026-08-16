import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-drop-kind-mig-"));
  return path.join(dir, "test.sqlite");
}

describe("drop notifier kind migration", () => {
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

  it("drops the kind column from notifiers and notification_log", async () => {
    expect(await db.schema.hasColumn("notifiers", "kind")).toBe(false);
    expect(await db.schema.hasColumn("notification_log", "kind")).toBe(false);
  });

  it("preserves existing notifier rows across the column drop", async () => {
    // Roll back the drop so `kind` exists again, insert rows carrying it (as
    // they would have existed before this migration), then re-apply the drop and
    // confirm every row survives with its other columns intact.
    // Target this migration by name: later migrations sit on top of it, so a
    // bare down() would revert the newest one instead.
    await db.migrate.down({ name: "20260713000017_drop_notifier_kind" });
    expect(await db.schema.hasColumn("notifiers", "kind")).toBe(true);
    // Clear the seeded `desktop` notifier so id-ordering / name assertions
    // below are deterministic; this test cares about the rows it inserts.
    await db("notifiers").del();

    await db("notifiers").insert([
      {
        name: "alpha",
        kind: "inbox",
        config: JSON.stringify({ channel: "x" }),
        title_template: "{{event.type}}",
        body_template: "b",
        enabled: 1,
        created_at: 10,
        updated_at: 20,
      },
      {
        name: "beta",
        kind: "desktop",
        config: "{}",
        title_template: "",
        body_template: "",
        enabled: 0,
        created_at: 30,
        updated_at: 40,
      },
    ]);
    await db("notification_log").insert({
      notifier_id: 1,
      event_id: 7,
      kind: "inbox",
      title: "t",
      body: "b",
      status: "delivered",
      error: null,
      read_at: null,
      created_at: 50,
    });

    await db.migrate.up({ name: "20260713000017_drop_notifier_kind" }); // re-apply
    expect(await db.schema.hasColumn("notifiers", "kind")).toBe(false);

    const notifiers = await db("notifiers").orderBy("id", "asc");
    expect(notifiers.map((n) => n.name)).toEqual(["alpha", "beta"]);
    expect(notifiers[0].config).toBe(JSON.stringify({ channel: "x" }));
    expect(notifiers[0].title_template).toBe("{{event.type}}");
    expect(notifiers[0].enabled).toBe(1);
    expect(notifiers[1].enabled).toBe(0);
    expect(notifiers[1].created_at).toBe(30);

    const log = await db("notification_log").first();
    expect(log.title).toBe("t");
    expect(log.notifier_id).toBe(1);
    expect(log.event_id).toBe(7);
    expect(log.status).toBe("delivered");
  });
});

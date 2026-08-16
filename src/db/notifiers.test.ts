import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { runMigrations } from "./migrate";
import {
  createNotifier,
  deleteNotifier,
  getNotifier,
  listNotifiers,
  updateNotifier,
} from "./notifiers";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notifiers-"));
  return path.join(dir, "test.sqlite");
}

describe("notifiers repo", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    // Migrations seed a built-in `desktop` notifier; clear the table so
    // id-ordering and count assertions below are deterministic.
    await db("notifiers").del();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("creates a notifier with defaults and parses config in/out", async () => {
    const created = await createNotifier({ name: "inbox-a" }, db);
    expect(created.id).toBeGreaterThan(0);
    expect(created.config).toEqual({});
    expect(created.title_template).toBe("");
    expect(created.body_template).toBe("");
    expect(created.enabled).toBe(true);
    expect(created.created_at).toBeGreaterThan(0);
    expect(created.updated_at).toBe(created.created_at);

    const round = await getNotifier(created.id, db);
    expect(round).toEqual(created);
  });

  it("stores an explicit config, templates, and enabled flag", async () => {
    const created = await createNotifier(
      {
        name: "n",
        config: { channel: "x" },
        title_template: "{{event.type}}",
        body_template: "{{payload.title}}",
        enabled: false,
      },
      db
    );
    expect(created.config).toEqual({ channel: "x" });
    expect(created.title_template).toBe("{{event.type}}");
    expect(created.enabled).toBe(false);
  });

  it("enforces the unique name constraint", async () => {
    await createNotifier({ name: "dup" }, db);
    // A duplicate name must not produce a second row: the DB rejects the insert.
    await createNotifier({ name: "dup" }, db).catch(() => {
      /* the unique index rejects the duplicate; swallow the constraint error */
    });
    const dupes = await db("notifiers").where({ name: "dup" });
    expect(dupes).toHaveLength(1);
  });

  it("lists notifiers newest-first", async () => {
    const a = await createNotifier({ name: "a" }, db);
    const b = await createNotifier({ name: "b" }, db);
    const list = await listNotifiers(db);
    expect(list.map((n) => n.id)).toEqual([b.id, a.id]);
  });

  it("applies a partial update and bumps updated_at", async () => {
    const created = await createNotifier({ name: "n" }, db);
    const updated = await updateNotifier(
      created.id,
      { config: { k: 1 }, enabled: false },
      db
    );
    expect(updated?.config).toEqual({ k: 1 });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe("n");
    expect(updated?.updated_at).toBeGreaterThanOrEqual(created.updated_at);
  });

  it("returns undefined updating a missing notifier", async () => {
    expect(await updateNotifier(999, { name: "x" }, db)).toBeUndefined();
  });

  it("deletes a notifier", async () => {
    const created = await createNotifier({ name: "n" }, db);
    expect(await deleteNotifier(created.id, db)).toBe(true);
    expect(await getNotifier(created.id, db)).toBeUndefined();
    expect(await deleteNotifier(created.id, db)).toBe(false);
  });
});

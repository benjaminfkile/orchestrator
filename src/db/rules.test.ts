import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { runMigrations } from "./migrate";
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  updateRule,
} from "./rules";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-rules-"));
  return path.join(dir, "test.sqlite");
}

describe("rules repo", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    // Start from an empty table: migrations seed a built-in rule, but these
    // tests exercise CRUD against a clean slate.
    await db("rules").del();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("creates a rule and reads it back with decoded JSON and boolean columns", async () => {
    const created = await createRule(
      {
        name: "watcher",
        match: { source: "moduleA", type: "thing.changed", criteria: { n: 1 } },
        dispatch: [{ playbook_id: 7, bindings: { k: "v" } }],
      },
      db
    );

    expect(created.id).toBeGreaterThan(0);
    expect(created.enabled).toBe(true);
    expect(created.match).toEqual({
      source: "moduleA",
      type: "thing.changed",
      criteria: { n: 1 },
    });
    expect(created.dispatch).toEqual([{ playbook_id: 7, bindings: { k: "v" } }]);
    expect(created.created_at).toBe(created.updated_at);

    const fetched = await getRule(created.id, db);
    expect(fetched).toEqual(created);
  });

  it("applies defaults: enabled true, empty match, dispatch, and notify", async () => {
    const created = await createRule({ name: "bare" }, db);
    expect(created.enabled).toBe(true);
    expect(created.match).toEqual({});
    expect(created.dispatch).toEqual([]);
    expect(created.notify).toEqual([]);
  });

  it("persists and parses notify targets alongside dispatch", async () => {
    const created = await createRule(
      {
        name: "both",
        dispatch: [{ playbook_id: 7 }],
        notify: [{ notifier_id: 3 }, { notifier_id: 4 }],
      },
      db
    );
    expect(created.notify).toEqual([{ notifier_id: 3 }, { notifier_id: 4 }]);
    const fetched = await getRule(created.id, db);
    expect(fetched?.notify).toEqual([{ notifier_id: 3 }, { notifier_id: 4 }]);

    // notify can be updated independently of dispatch.
    const updated = await updateRule(created.id, { notify: [] }, db);
    expect(updated?.notify).toEqual([]);
    expect(updated?.dispatch).toEqual([{ playbook_id: 7 }]);
  });

  it("honors an explicit enabled=false", async () => {
    const created = await createRule({ name: "off", enabled: false }, db);
    expect(created.enabled).toBe(false);
    const fetched = await getRule(created.id, db);
    expect(fetched?.enabled).toBe(false);
  });

  it("returns undefined for a missing rule", async () => {
    expect(await getRule(9999, db)).toBeUndefined();
  });

  it("lists rules newest-first", async () => {
    const a = await createRule({ name: "a" }, db);
    const b = await createRule({ name: "b" }, db);
    const c = await createRule({ name: "c" }, db);
    const rows = await listRules(db);
    expect(rows.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
  });

  it("updates only the provided fields and bumps updated_at", async () => {
    const created = await createRule(
      { name: "orig", match: { source: "s" } },
      db
    );

    const updated = await updateRule(
      created.id,
      {
        enabled: false,
        dispatch: [{ playbook_id: 3 }],
      },
      db
    );

    expect(updated).toBeDefined();
    expect(updated?.name).toBe("orig");
    expect(updated?.match).toEqual({ source: "s" });
    expect(updated?.enabled).toBe(false);
    expect(updated?.dispatch).toEqual([{ playbook_id: 3 }]);
    expect(updated?.created_at).toBe(created.created_at);
    expect(updated?.updated_at).toBeGreaterThanOrEqual(created.updated_at);
  });

  it("returns undefined when updating a missing rule", async () => {
    expect(await updateRule(9999, { name: "x" }, db)).toBeUndefined();
  });

  it("deletes a rule and reports whether a row was removed", async () => {
    const created = await createRule({ name: "doomed" }, db);
    expect(await deleteRule(created.id, db)).toBe(true);
    expect(await getRule(created.id, db)).toBeUndefined();
    expect(await deleteRule(created.id, db)).toBe(false);
  });
});

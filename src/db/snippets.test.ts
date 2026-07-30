import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { runMigrations } from "./migrate";
import { createDb } from "./db";
import {
  createSnippet,
  deleteSnippet,
  getSnippet,
  getSnippetByName,
  listSnippets,
  updateSnippet,
} from "./snippets";

describe("snippets repo", () => {
  let db: Knex;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-snippets-db-"));
    db = createDb(path.join(dir, "test.sqlite"));
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates with a defaulted description and reads back by id", async () => {
    const created = await createSnippet(
      { kind: "prompt", name: "a", content: "body" },
      db
    );
    expect(created.description).toBe("");
    expect(await getSnippet(created.id, db)).toEqual(created);
  });

  it("enforces UNIQUE(kind, name) but allows the same name across kinds", async () => {
    await createSnippet({ kind: "step", name: "dup", content: "x" }, db);
    await expect(
      createSnippet({ kind: "step", name: "dup", content: "y" }, db)
    ).rejects.toThrow(/already exists/);
    // Same name under a different kind is fine.
    await expect(
      createSnippet({ kind: "prompt", name: "dup", content: "z" }, db)
    ).resolves.toBeDefined();
  });

  it("getSnippetByName isolates by kind (a wrong-kind name does not match)", async () => {
    await createSnippet({ kind: "prompt", name: "shared", content: "p" }, db);
    expect((await getSnippetByName("prompt", "shared", db))?.content).toBe("p");
    // The same name under a different kind returns undefined — the loud-failure hook.
    expect(await getSnippetByName("userdata", "shared", db)).toBeUndefined();
    expect(await getSnippetByName("step", "missing", db)).toBeUndefined();
  });

  it("lists newest-first and filters by kind", async () => {
    await createSnippet({ kind: "prompt", name: "p", content: "1" }, db);
    await createSnippet({ kind: "step", name: "s", content: "2" }, db);
    expect(await listSnippets(undefined, db)).toHaveLength(2);
    const steps = await listSnippets("step", db);
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("s");
  });

  it("updates fields (including a rename) and deletes", async () => {
    const created = await createSnippet(
      { kind: "prompt", name: "old", content: "c" },
      db
    );
    const updated = await updateSnippet(
      created.id,
      { name: "new", content: "c2", description: "d" },
      db
    );
    expect(updated?.name).toBe("new");
    expect(updated?.content).toBe("c2");
    expect(updated?.description).toBe("d");
    expect(updated?.updated_at).toBeGreaterThanOrEqual(created.updated_at);

    expect(await deleteSnippet(created.id, db)).toBe(true);
    expect(await getSnippet(created.id, db)).toBeUndefined();
    expect(await deleteSnippet(created.id, db)).toBe(false);
  });

  it("update/delete of an absent id returns undefined/false", async () => {
    expect(await updateSnippet(9999, { name: "x" }, db)).toBeUndefined();
    expect(await deleteSnippet(9999, db)).toBe(false);
  });
});

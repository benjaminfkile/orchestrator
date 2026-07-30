import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb, resolveDbPath } from "./db";
import { runMigrations } from "./migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-db-"));
  return path.join(dir, "test.sqlite");
}

describe("resolveDbPath", () => {
  const original = process.env.ORCH_DB_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.ORCH_DB_PATH;
    else process.env.ORCH_DB_PATH = original;
  });

  it("uses ORCH_DB_PATH when set", () => {
    process.env.ORCH_DB_PATH = "/tmp/custom/orch.sqlite";
    expect(resolveDbPath()).toBe("/tmp/custom/orch.sqlite");
  });

  it("falls back to a user-data path under an orchestrator dir when unset", () => {
    delete process.env.ORCH_DB_PATH;
    const resolved = resolveDbPath();
    expect(resolved).toContain(path.join("orchestrator", "orchestrator.sqlite"));
  });
});

describe("createDb + migrations", () => {
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

  it("creates the on-disk sqlite file and the app_settings table", async () => {
    await runMigrations(db);
    expect(fs.existsSync(file)).toBe(true);
    expect(await db.schema.hasTable("app_settings")).toBe(true);
  });

  it("runs migrations idempotently (second run is a no-op)", async () => {
    // knex.migrate.latest resolves to [batchNo, appliedMigrationNames].
    const [, firstRun] = await db.migrate.latest();
    expect(firstRun.length).toBeGreaterThan(0);

    const [, secondRun] = await db.migrate.latest();
    // Nothing pending on the second run.
    expect(secondRun).toEqual([]);
  });
});

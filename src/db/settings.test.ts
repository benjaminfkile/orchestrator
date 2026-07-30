import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { runMigrations } from "./migrate";
import { getSetting, setSetting } from "./settings";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-settings-"));
  return path.join(dir, "test.sqlite");
}

describe("app_settings get/set helpers", () => {
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

  it("returns the fallback when a key is absent", async () => {
    expect(await getSetting("missing", "default", db)).toBe("default");
    expect(await getSetting("missing", undefined, db)).toBeUndefined();
  });

  it("persists and reads back a value", async () => {
    await setSetting("wisper.baseUrl", "http://localhost:8080", db);
    expect(await getSetting("wisper.baseUrl", "fallback", db)).toBe(
      "http://localhost:8080"
    );
  });

  it("upserts an existing key rather than erroring", async () => {
    await setSetting("theme", "light", db);
    await setSetting("theme", "dark", db);
    expect(await getSetting("theme", undefined, db)).toBe("dark");

    const rows = await db("app_settings").where({ key: "theme" });
    expect(rows).toHaveLength(1);
  });
});

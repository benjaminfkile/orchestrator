import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { runMigrations } from "./migrate";
import {
  getModuleConfig,
  setModuleConfig,
  type ModuleConfigNotifier,
} from "./moduleConfig";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-moduleconfig-"));
  return path.join(dir, "test.sqlite");
}

describe("module_config get/set helpers", () => {
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

  it("returns undefined when a module has no stored config", async () => {
    expect(await getModuleConfig("missing", db)).toBeUndefined();
  });

  it("persists and reads back a JSON config object", async () => {
    await setModuleConfig("mod.a", { intervalSeconds: 30, name: "poll" }, db);
    expect(await getModuleConfig("mod.a", db)).toEqual({
      intervalSeconds: 30,
      name: "poll",
    });
  });

  it("upserts an existing module rather than erroring", async () => {
    await setModuleConfig("mod.a", { intervalSeconds: 30 }, db);
    await setModuleConfig("mod.a", { intervalSeconds: 60 }, db);
    expect(await getModuleConfig("mod.a", db)).toEqual({ intervalSeconds: 60 });

    const rows = await db("module_config").where({ module_id: "mod.a" });
    expect(rows).toHaveLength(1);
  });

  it("bumps updated_at on each write", async () => {
    await setModuleConfig("mod.a", { v: 1 }, db);
    const first = await db("module_config").where({ module_id: "mod.a" }).first();
    await setModuleConfig("mod.a", { v: 2 }, db);
    const second = await db("module_config").where({ module_id: "mod.a" }).first();
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at);
  });

  it("stores an empty object when config is null/undefined", async () => {
    await setModuleConfig("mod.a", undefined, db);
    expect(await getModuleConfig("mod.a", db)).toEqual({});
  });

  it("notifies the notifier after a write, with the module id", async () => {
    const seen: string[] = [];
    const notifier: ModuleConfigNotifier = {
      onConfigChanged: async (moduleId) => {
        // The row must already be persisted by the time we are notified.
        expect(await getModuleConfig(moduleId, db)).toEqual({ intervalSeconds: 5 });
        seen.push(moduleId);
      },
    };
    await setModuleConfig("mod.a", { intervalSeconds: 5 }, db, notifier);
    expect(seen).toEqual(["mod.a"]);
  });

  it("does not require a notifier", async () => {
    await expect(
      setModuleConfig("mod.a", { intervalSeconds: 5 }, db)
    ).resolves.toBeUndefined();
  });
});

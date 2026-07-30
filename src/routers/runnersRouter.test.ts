import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { runnerIds } from "../runners/registry";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runners-router-"));
  return path.join(dir, "test.sqlite");
}

describe("runners router", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("lists the registered runner ids", async () => {
    const res = await request(app).get("/api/runners");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runners: runnerIds() });
    // claude-code is always registered.
    expect(res.body.runners).toContain("claude-code");
  });
});

import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "./app";
import { createDb, setDb } from "./db/db";
import { runMigrations } from "./db/migrate";
import { resetHealthDeps, setHealthDeps } from "./routers/healthRouter";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-app-"));
  return path.join(dir, "test.sqlite");
}

describe("GET /api/health", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
    setHealthDeps({
      fetchImpl: async () => new Response("ok", { status: 200 }),
      now: () => 1000,
    });
  });

  afterEach(async () => {
    resetHealthDeps();
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("returns status ok with db and wisper health", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: true, wisper: true });
  });
});

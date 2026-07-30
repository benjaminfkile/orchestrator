import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";

import {
  resetHealthDeps,
  setHealthDeps,
  WISPER_PROBE_CACHE_MS,
} from "./healthRouter";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-health-router-"));
  return path.join(dir, "test.sqlite");
}

describe("health router", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
  });

  afterEach(async () => {
    resetHealthDeps();
    try {
      await db.destroy();
    } catch {
      // already destroyed by a test
    }
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("reports db true and wisper true when the probe succeeds", async () => {
    setHealthDeps({
      fetchImpl: async () => new Response("ok", { status: 200 }),
      now: () => 1000,
    });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: true, wisper: true });
  });

  it("reports wisper false when the probe fails", async () => {
    setHealthDeps({
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      now: () => 1000,
    });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.wisper).toBe(false);
  });

  it("reports wisper false on a non-2xx response", async () => {
    setHealthDeps({
      fetchImpl: async () => new Response("nope", { status: 503 }),
      now: () => 1000,
    });
    const res = await request(app).get("/api/health");
    expect(res.body.wisper).toBe(false);
  });

  it("reports db false when the database is unreachable", async () => {
    await db.destroy();
    setHealthDeps({
      fetchImpl: async () => new Response("ok", { status: 200 }),
      now: () => 1000,
    });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe(false);
  });

  it("caches the wisper probe for 30s, then re-probes", async () => {
    let calls = 0;
    let clock = 1000;
    setHealthDeps({
      fetchImpl: async () => {
        calls += 1;
        return new Response("ok", { status: 200 });
      },
      now: () => clock,
    });

    await request(app).get("/api/health");
    expect(calls).toBe(1);

    // within the cache window → served from cache
    clock += WISPER_PROBE_CACHE_MS - 1;
    await request(app).get("/api/health");
    expect(calls).toBe(1);

    // past the cache window → re-probes
    clock += 2;
    await request(app).get("/api/health");
    expect(calls).toBe(2);
  });

  it("probes {WISPER_BASE_URL}/healthz", async () => {
    let seenUrl = "";
    setHealthDeps({
      fetchImpl: async (input) => {
        seenUrl = String(input);
        return new Response("ok", { status: 200 });
      },
      now: () => 1000,
    });
    await request(app).get("/api/health");
    expect(seenUrl).toMatch(/\/healthz$/);
  });
});

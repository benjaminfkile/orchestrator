import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { insertEvent } from "../db/events";
import { runMigrations } from "../db/migrate";
import { ModuleRegistry } from "../modules/registry";
import { resetRuntime, setRuntime } from "../runtime";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-events-router-"));
  return path.join(dir, "test.sqlite");
}

describe("events router", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
  });

  afterEach(async () => {
    resetRuntime();
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  async function seed(n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const ev = await insertEvent(
        {
          source: "moduleA",
          type: "thing.changed",
          subject_kind: "item",
          subject_ref: `ref-${i}`,
          payload: { n: i },
        },
        db
      );
      ids.push(ev.id);
    }
    return ids;
  }

  describe("GET /api/events", () => {
    it("returns events newest-first", async () => {
      const ids = await seed(3);
      const res = await request(app).get("/api/events");
      expect(res.status).toBe(200);
      expect(res.body.map((e: { id: number }) => e.id)).toEqual(
        [...ids].reverse()
      );
      // payload is decoded, not a JSON string.
      expect(res.body[0].payload).toEqual({ n: 2 });
    });

    it("honors limit", async () => {
      await seed(5);
      const res = await request(app).get("/api/events?limit=2");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it("pages by the before cursor (strictly-less-than id)", async () => {
      const ids = await seed(4);
      const res = await request(app).get(`/api/events?before=${ids[2]}`);
      expect(res.status).toBe(200);
      expect(res.body.map((e: { id: number }) => e.id)).toEqual([
        ids[1],
        ids[0],
      ]);
    });

    it("400s on a non-integer limit", async () => {
      const res = await request(app).get("/api/events?limit=abc");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s on an out-of-range limit", async () => {
      const res = await request(app).get("/api/events?limit=0");
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
    });

    it("400s on a non-integer before", async () => {
      const res = await request(app).get("/api/events?before=-1");
      expect(res.status).toBe(400);
    });

    it("filters by the q search param and composes with the cursor", async () => {
      const wanted = await insertEvent(
        {
          source: "ado",
          type: "workitem.created",
          subject_kind: "workitem",
          subject_ref: "4242",
          payload: { title: "hello" },
        },
        db
      );
      await insertEvent(
        {
          source: "github",
          type: "pull_request.opened",
          subject_kind: "pr",
          subject_ref: "1",
        },
        db
      );
      const res = await request(app).get("/api/events?q=4242");
      expect(res.status).toBe(200);
      expect(res.body.map((e: { id: number }) => e.id)).toEqual([wanted.id]);
      // cursor applies to the filtered set: nothing older than `wanted` matches.
      const paged = await request(app).get(
        `/api/events?q=4242&before=${wanted.id}`
      );
      expect(paged.body).toEqual([]);
    });

    it("400s on a repeated (array) q", async () => {
      const res = await request(app).get("/api/events?q=a&q=b");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/events/facets", () => {
    it("returns empty arrays for an empty table and no modules", async () => {
      const res = await request(app).get("/api/events/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sources: [], types: [] });
    });

    it("returns distinct sources and types sorted ascending", async () => {
      const rows = [
        { source: "moduleB", type: "thing.updated" },
        { source: "moduleA", type: "thing.changed" },
        { source: "moduleA", type: "thing.updated" },
        { source: "moduleB", type: "thing.changed" },
      ];
      for (const r of rows) {
        await insertEvent(
          { ...r, subject_kind: "item", subject_ref: "x" },
          db
        );
      }
      const res = await request(app).get("/api/events/facets");
      expect(res.status).toBe(200);
      expect(res.body.sources).toEqual(["moduleA", "moduleB"]);
      expect(res.body.types).toEqual(["thing.changed", "thing.updated"]);
    });

    it("merges module-advertised event types with DB distincts", async () => {
      await insertEvent(
        {
          source: "moduleA",
          type: "thing.changed",
          subject_kind: "item",
          subject_ref: "x",
        },
        db
      );
      const registry = new ModuleRegistry();
      registry.register({
        id: "m",
        eventTypes: ["zeta.emitted", "thing.changed"],
      });
      setRuntime({ registry });

      const res = await request(app).get("/api/events/facets");
      expect(res.status).toBe(200);
      // Recorded source only; types are the union, de-duped and sorted.
      expect(res.body.sources).toEqual(["moduleA"]);
      expect(res.body.types).toEqual(["thing.changed", "zeta.emitted"]);
    });

    it("suggests module event types even with an empty events table", async () => {
      const registry = new ModuleRegistry();
      registry.register({ id: "m", eventTypes: ["a.b", "c.d"] });
      setRuntime({ registry });

      const res = await request(app).get("/api/events/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sources: [], types: ["a.b", "c.d"] });
    });
  });

  describe("GET /api/events/:id", () => {
    it("returns a single event", async () => {
      const [id] = await seed(1);
      const res = await request(app).get(`/api/events/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.subject_ref).toBe("ref-0");
    });

    it("404s for a missing event", async () => {
      const res = await request(app).get("/api/events/9999");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s for a non-numeric id", async () => {
      const res = await request(app).get("/api/events/abc");
      expect(res.status).toBe(400);
    });
  });
});

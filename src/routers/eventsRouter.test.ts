import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { insertEvent, listEvents } from "../db/events";
import { runMigrations } from "../db/migrate";
import { ModuleRegistry } from "../modules/registry";
import { createPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import { listDispatches } from "../db/dispatches";
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

  describe("POST /api/events", () => {
    it("mints an event with defaults, returns 201, and matches rules", async () => {
      const playbook = await createPlaybook(
        { name: "pb-manual", image: "img", ttl_seconds: 60 },
        db
      );
      await createRule(
        {
          name: "catch-manual",
          match: { source: "manual", type: "test.manual" },
          dispatch: [{ playbook_id: playbook.id }],
        },
        db
      );
      let kicked = 0;
      setRuntime({ dispatcher: { kick: () => (kicked += 1) } });

      const res = await request(app).post("/api/events").send({
        type: "test.manual",
        subject_ref: "smoke-1",
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        source: "manual",
        type: "test.manual",
        subject_kind: "manual",
        subject_ref: "smoke-1",
        payload: {},
        dedupe_key: "manual:manual:test.manual:smoke-1",
      });
      expect(typeof res.body.id).toBe("number");
      expect(typeof res.body.ts).toBe("number");

      // Full shape matches what GET /api/events returns for the same row.
      const listed = await request(app).get("/api/events");
      expect(listed.status).toBe(200);
      expect(listed.body[0]).toEqual(res.body);

      // Rule matched -> a queued dispatch is created and the dispatcher kicked.
      const dispatches = await listDispatches(undefined, db);
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].event_id).toBe(res.body.id);
      expect(dispatches[0].playbook_id).toBe(playbook.id);
      expect(kicked).toBe(1);
    });

    it("honors an explicit source, subject_kind, and payload", async () => {
      const res = await request(app)
        .post("/api/events")
        .send({
          source: "cli",
          type: "chaos.injected",
          subject_kind: "region",
          subject_ref: "us-fake-1",
          payload: { note: "smoke" },
        });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        source: "cli",
        type: "chaos.injected",
        subject_kind: "region",
        subject_ref: "us-fake-1",
        payload: { note: "smoke" },
        dedupe_key: "manual:cli:chaos.injected:us-fake-1",
      });
    });

    it("dedupes a second mint on the same (source,type,subject_ref) triple", async () => {
      const first = await request(app)
        .post("/api/events")
        .send({ type: "test.manual", subject_ref: "smoke-1" });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/events")
        .send({
          type: "test.manual",
          subject_ref: "smoke-1",
          payload: { ignored: true },
        });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      // Body reflects the ORIGINAL event: the duplicate payload was not inserted.
      expect(second.body.payload).toEqual({});

      // Exactly one row landed in the events table.
      const rows = await listEvents({}, db);
      expect(rows).toHaveLength(1);
    });

    it("mints separate events for different subject_refs (no cross-dedupe)", async () => {
      const a = await request(app)
        .post("/api/events")
        .send({ type: "test.manual", subject_ref: "one" });
      const b = await request(app)
        .post("/api/events")
        .send({ type: "test.manual", subject_ref: "two" });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.id).not.toBe(b.body.id);
    });

    it("400s when type is missing", async () => {
      const res = await request(app)
        .post("/api/events")
        .send({ subject_ref: "smoke-1" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s when subject_ref is missing", async () => {
      const res = await request(app)
        .post("/api/events")
        .send({ type: "test.manual" });
      expect(res.status).toBe(400);
    });

    it("400s when type is an empty string", async () => {
      const res = await request(app)
        .post("/api/events")
        .send({ type: "", subject_ref: "smoke-1" });
      expect(res.status).toBe(400);
    });

    it("400s when subject_ref is not a string", async () => {
      const res = await request(app)
        .post("/api/events")
        .send({ type: "test.manual", subject_ref: 42 });
      expect(res.status).toBe(400);
    });

    it("400s when payload is not an object", async () => {
      const res = await request(app)
        .post("/api/events")
        .send({
          type: "test.manual",
          subject_ref: "smoke-1",
          payload: "not an object",
        });
      expect(res.status).toBe(400);
    });

    it("400s on an unknown body key", async () => {
      const res = await request(app)
        .post("/api/events")
        .send({
          type: "test.manual",
          subject_ref: "smoke-1",
          dedupe_key: "attacker:supplied",
        });
      expect(res.status).toBe(400);
    });

    it("400s on a non-object body", async () => {
      const res = await request(app)
        .post("/api/events")
        .set("Content-Type", "application/json")
        .send('"nope"');
      expect(res.status).toBe(400);
    });

    it("succeeds even when no dispatcher is wired (kick is a no-op)", async () => {
      // resetRuntime already ran in beforeEach: no dispatcher present.
      const res = await request(app)
        .post("/api/events")
        .send({ type: "test.manual", subject_ref: "smoke-1" });
      expect(res.status).toBe(201);
    });
  });
});

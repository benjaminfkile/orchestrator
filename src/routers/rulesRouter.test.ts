import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { createPlaybook } from "../db/playbooks";
import { createRule, getRule } from "../db/rules";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-rules-router-"));
  return path.join(dir, "test.sqlite");
}

describe("rules router", () => {
  let file: string;
  let db: Knex;
  let playbookId: number;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    // Migrations seed a built-in rule; these tests exercise the router against a
    // clean slate.
    await db("rules").del();
    setDb(db);
    const pb = await createPlaybook(
      { name: "pb", image: "img", ttl_seconds: 60 },
      db
    );
    playbookId = pb.id;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("GET /api/rules", () => {
    it("lists rules newest-first", async () => {
      const a = await createRule({ name: "a" }, db);
      const b = await createRule({ name: "b" }, db);
      const res = await request(app).get("/api/rules");
      expect(res.status).toBe(200);
      expect(res.body.map((r: { id: number }) => r.id)).toEqual([b.id, a.id]);
    });
  });

  describe("GET /api/rules/:id", () => {
    it("returns one rule", async () => {
      const created = await createRule({ name: "one" }, db);
      const res = await request(app).get(`/api/rules/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("one");
    });

    it("404s for a missing rule", async () => {
      const res = await request(app).get("/api/rules/9999");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });
  });

  describe("POST /api/rules", () => {
    it("creates a rule with a valid match and dispatch", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({
          name: "watcher",
          match: { source: "moduleA", type: "thing.*", criteria: { n: 1 } },
          dispatch: [{ playbook_id: playbookId, bindings: { k: "v" } }],
        });
      expect(res.status).toBe(201);
      expect(res.body.id).toBeGreaterThan(0);
      expect(res.body.enabled).toBe(true);
      expect(res.body.dispatch).toEqual([
        { playbook_id: playbookId, bindings: { k: "v" } },
      ]);
      // persisted
      const stored = await getRule(res.body.id, db);
      expect(stored?.name).toBe("watcher");
    });

    it("400s when name is missing", async () => {
      const res = await request(app).post("/api/rules").send({ enabled: true });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s on an unknown top-level field", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", bogus: 1 });
      expect(res.status).toBe(400);
    });

    it("400s when match is not an object", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", match: "nope" });
      expect(res.status).toBe(400);
    });

    it("400s when match.source is not a string", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", match: { source: 5 } });
      expect(res.status).toBe(400);
    });

    it("400s when dispatch is not an array", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", dispatch: {} });
      expect(res.status).toBe(400);
    });

    it("400s when a dispatch target lacks a numeric playbook_id", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", dispatch: [{ playbook_id: "nope" }] });
      expect(res.status).toBe(400);
    });

    it("400s when a dispatch playbook_id does not exist", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", dispatch: [{ playbook_id: 9999 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/9999/);
    });

    it("accepts and persists notify targets alongside dispatch", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({
          name: "both",
          dispatch: [{ playbook_id: playbookId }],
          notify: [{ notifier_id: 3 }, { notifier_id: 4 }],
        });
      expect(res.status).toBe(201);
      expect(res.body.notify).toEqual([{ notifier_id: 3 }, { notifier_id: 4 }]);
      const stored = await getRule(res.body.id, db);
      expect(stored?.notify).toEqual([{ notifier_id: 3 }, { notifier_id: 4 }]);
    });

    it("defaults notify to an empty array", async () => {
      const res = await request(app).post("/api/rules").send({ name: "n" });
      expect(res.status).toBe(201);
      expect(res.body.notify).toEqual([]);
    });

    it("400s when notify is not an array", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", notify: {} });
      expect(res.status).toBe(400);
    });

    it("400s when a notify target lacks a numeric notifier_id", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", notify: [{ notifier_id: "nope" }] });
      expect(res.status).toBe(400);
    });

    it("400s on an unknown notify target field", async () => {
      const res = await request(app)
        .post("/api/rules")
        .send({ name: "x", notify: [{ notifier_id: 1, bogus: 2 }] });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/rules/:id", () => {
    it("updates provided fields only", async () => {
      const created = await createRule(
        { name: "orig", match: { source: "s" } },
        db
      );
      const res = await request(app)
        .patch(`/api/rules/${created.id}`)
        .send({ enabled: false, dispatch: [{ playbook_id: playbookId }] });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("orig");
      expect(res.body.enabled).toBe(false);
      expect(res.body.match).toEqual({ source: "s" });
      expect(res.body.dispatch).toEqual([{ playbook_id: playbookId }]);
    });

    it("404s for a missing rule", async () => {
      const res = await request(app)
        .patch("/api/rules/9999")
        .send({ name: "x" });
      expect(res.status).toBe(404);
    });

    it("400s on an invalid dispatch playbook reference", async () => {
      const created = await createRule({ name: "r" }, db);
      const res = await request(app)
        .patch(`/api/rules/${created.id}`)
        .send({ dispatch: [{ playbook_id: 9999 }] });
      expect(res.status).toBe(400);
    });

    it("updates notify targets", async () => {
      const created = await createRule(
        { name: "r", notify: [{ notifier_id: 1 }] },
        db
      );
      const res = await request(app)
        .patch(`/api/rules/${created.id}`)
        .send({ notify: [{ notifier_id: 2 }] });
      expect(res.status).toBe(200);
      expect(res.body.notify).toEqual([{ notifier_id: 2 }]);
    });
  });

  describe("DELETE /api/rules/:id", () => {
    it("deletes a rule", async () => {
      const created = await createRule({ name: "doomed" }, db);
      const res = await request(app).delete(`/api/rules/${created.id}`);
      expect(res.status).toBe(204);
      expect(await getRule(created.id, db)).toBeUndefined();
    });

    it("404s for a missing rule", async () => {
      const res = await request(app).delete("/api/rules/9999");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/rules/:id/enable and /disable", () => {
    it("disables then enables a rule", async () => {
      const created = await createRule({ name: "r", enabled: true }, db);

      const off = await request(app).post(`/api/rules/${created.id}/disable`);
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);

      const on = await request(app).post(`/api/rules/${created.id}/enable`);
      expect(on.status).toBe(200);
      expect(on.body.enabled).toBe(true);
    });

    it("404s enabling a missing rule", async () => {
      const res = await request(app).post("/api/rules/9999/enable");
      expect(res.status).toBe(404);
    });
  });

  it("returns {error} for malformed JSON bodies", async () => {
    const res = await request(app)
      .post("/api/rules")
      .set("Content-Type", "application/json")
      .send("{ not json ");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String) });
  });
});

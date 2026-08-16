import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { createNotifier, getNotifier } from "../db/notifiers";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notifiers-router-"));
  return path.join(dir, "test.sqlite");
}

describe("notifiers router", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    // Migrations seed a built-in `desktop` notifier; drop it so id-ordering
    // and count assertions here are deterministic.
    await db("notifiers").del();
    setDb(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("POST /api/notifiers", () => {
    it("creates a notifier with defaults", async () => {
      const res = await request(app)
        .post("/api/notifiers")
        .send({ name: "inbox-a" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("inbox-a");
      expect(res.body.config).toEqual({});
      expect(res.body.enabled).toBe(true);
    });

    it("accepts config and templates", async () => {
      const res = await request(app)
        .post("/api/notifiers")
        .send({
          name: "n",
          config: { channel: "x" },
          title_template: "{{event.type}}",
          body_template: "b",
          enabled: false,
        });
      expect(res.status).toBe(201);
      expect(res.body.config).toEqual({ channel: "x" });
      expect(res.body.enabled).toBe(false);
    });

    it("rejects a missing name", async () => {
      const res = await request(app).post("/api/notifiers").send({});
      expect(res.status).toBe(400);
    });

    it("rejects a kind field: notifications have no delivery kind", async () => {
      const res = await request(app)
        .post("/api/notifiers")
        .send({ name: "n", kind: "inbox" });
      expect(res.status).toBe(400);
    });

    it("rejects an unknown field", async () => {
      const res = await request(app)
        .post("/api/notifiers")
        .send({ name: "n", bogus: 1 });
      expect(res.status).toBe(400);
    });

    it("rejects a non-object config", async () => {
      const res = await request(app)
        .post("/api/notifiers")
        .send({ name: "n", config: "nope" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/notifiers", () => {
    it("lists newest-first", async () => {
      const a = await createNotifier({ name: "a" }, db);
      const b = await createNotifier({ name: "b" }, db);
      const res = await request(app).get("/api/notifiers");
      expect(res.status).toBe(200);
      expect(res.body.map((n: { id: number }) => n.id)).toEqual([b.id, a.id]);
    });

    it("returns one notifier and 404s for a missing id", async () => {
      const created = await createNotifier({ name: "one" }, db);
      const ok = await request(app).get(`/api/notifiers/${created.id}`);
      expect(ok.status).toBe(200);
      expect(ok.body.name).toBe("one");
      const missing = await request(app).get("/api/notifiers/9999");
      expect(missing.status).toBe(404);
    });
  });

  describe("PATCH /api/notifiers/:id", () => {
    it("updates fields", async () => {
      const created = await createNotifier({ name: "n" }, db);
      const res = await request(app)
        .patch(`/api/notifiers/${created.id}`)
        .send({ enabled: false, title_template: "t" });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.title_template).toBe("t");
    });

    it("404s for a missing notifier", async () => {
      const res = await request(app)
        .patch("/api/notifiers/9999")
        .send({ name: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/notifiers/:id", () => {
    it("deletes and then 404s", async () => {
      const created = await createNotifier({ name: "n" }, db);
      const del = await request(app).delete(`/api/notifiers/${created.id}`);
      expect(del.status).toBe(204);
      expect(await getNotifier(created.id, db)).toBeUndefined();
      const again = await request(app).delete(`/api/notifiers/${created.id}`);
      expect(again.status).toBe(404);
    });
  });
});

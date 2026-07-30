import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { insertNotification } from "../db/notificationLog";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notif-router-"));
  return path.join(dir, "test.sqlite");
}

async function seed(db: Knex, title: string): Promise<number> {
  const row = await insertNotification(
    { title, body: "b", status: "delivered" },
    db
  );
  return row.id;
}

describe("notifications router", () => {
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

  describe("GET /api/notifications", () => {
    it("lists newest-first with cursor paging and unread filter", async () => {
      const a = await seed(db, "a");
      const b = await seed(db, "b");
      const c = await seed(db, "c");

      const all = await request(app).get("/api/notifications");
      expect(all.status).toBe(200);
      expect(all.body.map((r: { id: number }) => r.id)).toEqual([c, b, a]);

      const page = await request(app).get(
        `/api/notifications?limit=1&cursor=${c}`
      );
      expect(page.body.map((r: { id: number }) => r.id)).toEqual([b]);

      await request(app).post(`/api/notifications/${b}/read`);
      const unread = await request(app).get("/api/notifications?unread=1");
      expect(unread.body.map((r: { id: number }) => r.id)).toEqual([c, a]);
    });

    it("rejects a malformed limit", async () => {
      const res = await request(app).get("/api/notifications?limit=abc");
      expect(res.status).toBe(400);
    });

    it("filters by the q search param and composes with the cursor", async () => {
      const alpha = await seed(db, "alpha match");
      const beta = await seed(db, "beta match");
      await seed(db, "gamma");

      const res = await request(app).get("/api/notifications?q=match");
      expect(res.status).toBe(200);
      expect(res.body.map((r: { id: number }) => r.id)).toEqual([beta, alpha]);

      const page = await request(app).get(
        `/api/notifications?q=match&cursor=${beta}`
      );
      expect(page.body.map((r: { id: number }) => r.id)).toEqual([alpha]);
    });
  });

  describe("GET /api/notifications/unread-count", () => {
    it("counts unread rows", async () => {
      await seed(db, "a");
      const id = await seed(db, "b");
      let res = await request(app).get("/api/notifications/unread-count");
      expect(res.body).toEqual({ count: 2 });
      await request(app).post(`/api/notifications/${id}/read`);
      res = await request(app).get("/api/notifications/unread-count");
      expect(res.body).toEqual({ count: 1 });
    });
  });

  describe("POST /api/notifications/:id/read", () => {
    it("marks a row read and 404s for a missing id", async () => {
      const id = await seed(db, "a");
      const ok = await request(app).post(`/api/notifications/${id}/read`);
      expect(ok.status).toBe(200);
      expect(ok.body.read_at).not.toBeNull();
      const missing = await request(app).post("/api/notifications/9999/read");
      expect(missing.status).toBe(404);
    });
  });

  describe("POST /api/notifications/read-all", () => {
    it("marks every unread row read", async () => {
      await seed(db, "a");
      await seed(db, "b");
      const res = await request(app).post("/api/notifications/read-all");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2 });
      const count = await request(app).get("/api/notifications/unread-count");
      expect(count.body).toEqual({ count: 0 });
    });
  });
});

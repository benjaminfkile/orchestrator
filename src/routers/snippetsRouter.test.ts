import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { createSnippet } from "../db/snippets";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-snippets-router-"));
  return path.join(dir, "test.sqlite");
}

describe("snippets router", () => {
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

  describe("POST /api/snippets", () => {
    it("creates a snippet with a defaulted description", async () => {
      const res = await request(app)
        .post("/api/snippets")
        .send({ kind: "prompt", name: "greeting", content: "hello" });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe("prompt");
      expect(res.body.name).toBe("greeting");
      expect(res.body.content).toBe("hello");
      expect(res.body.description).toBe("");
      expect(res.body.id).toEqual(expect.any(Number));
    });

    it("rejects an invalid kind", async () => {
      const res = await request(app)
        .post("/api/snippets")
        .send({ kind: "bogus", name: "x", content: "c" });
      expect(res.status).toBe(400);
    });

    it("rejects a missing name or content", async () => {
      const noName = await request(app)
        .post("/api/snippets")
        .send({ kind: "prompt", content: "c" });
      expect(noName.status).toBe(400);
      const noContent = await request(app)
        .post("/api/snippets")
        .send({ kind: "prompt", name: "n" });
      expect(noContent.status).toBe(400);
    });

    it("rejects an unknown field", async () => {
      const res = await request(app)
        .post("/api/snippets")
        .send({ kind: "prompt", name: "n", content: "c", bogus: 1 });
      expect(res.status).toBe(400);
    });

    it("409s on a duplicate (kind, name)", async () => {
      await request(app)
        .post("/api/snippets")
        .send({ kind: "step", name: "build", content: "make" });
      const dup = await request(app)
        .post("/api/snippets")
        .send({ kind: "step", name: "build", content: "make all" });
      expect(dup.status).toBe(409);
    });

    it("allows the same name under a different kind", async () => {
      const a = await request(app)
        .post("/api/snippets")
        .send({ kind: "step", name: "shared", content: "a" });
      const b = await request(app)
        .post("/api/snippets")
        .send({ kind: "prompt", name: "shared", content: "b" });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });
  });

  describe("GET /api/snippets", () => {
    it("lists all snippets, and filters by kind", async () => {
      await createSnippet({ kind: "prompt", name: "p1", content: "a" }, db);
      await createSnippet({ kind: "step", name: "s1", content: "b" }, db);
      await createSnippet({ kind: "userdata", name: "u1", content: "c" }, db);

      const all = await request(app).get("/api/snippets");
      expect(all.status).toBe(200);
      expect(all.body).toHaveLength(3);

      const steps = await request(app).get("/api/snippets?kind=step");
      expect(steps.status).toBe(200);
      expect(steps.body).toHaveLength(1);
      expect(steps.body[0].name).toBe("s1");
    });

    it("400s on an invalid ?kind filter", async () => {
      const res = await request(app).get("/api/snippets?kind=bogus");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/snippets/:id", () => {
    it("reads one, 404 when absent", async () => {
      const created = await createSnippet(
        { kind: "prompt", name: "x", content: "y" },
        db
      );
      const ok = await request(app).get(`/api/snippets/${created.id}`);
      expect(ok.status).toBe(200);
      expect(ok.body.name).toBe("x");
      const missing = await request(app).get("/api/snippets/99999");
      expect(missing.status).toBe(404);
    });
  });

  describe("PATCH /api/snippets/:id", () => {
    it("renames a snippet (references break by design)", async () => {
      const created = await createSnippet(
        { kind: "prompt", name: "old", content: "c" },
        db
      );
      const res = await request(app)
        .patch(`/api/snippets/${created.id}`)
        .send({ name: "new" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("new");
    });

    it("404 when the snippet is absent", async () => {
      const res = await request(app)
        .patch("/api/snippets/99999")
        .send({ name: "z" });
      expect(res.status).toBe(404);
    });

    it("rejects an invalid kind on update", async () => {
      const created = await createSnippet(
        { kind: "prompt", name: "k", content: "c" },
        db
      );
      const res = await request(app)
        .patch(`/api/snippets/${created.id}`)
        .send({ kind: "nope" });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/snippets/:id", () => {
    it("deletes one, 404 when absent", async () => {
      const created = await createSnippet(
        { kind: "step", name: "d", content: "c" },
        db
      );
      const ok = await request(app).delete(`/api/snippets/${created.id}`);
      expect(ok.status).toBe(204);
      const again = await request(app).delete(`/api/snippets/${created.id}`);
      expect(again.status).toBe(404);
    });
  });
});

import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { createDispatch } from "../db/dispatches";
import { insertEvent } from "../db/events";
import { createFinding } from "../db/findings";
import { createPlaybook, getPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import { createRun } from "../db/runs";
import type { DispatchStatus } from "../interfaces";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-playbooks-router-"));
  return path.join(dir, "test.sqlite");
}

const VALID = { name: "pb", image: "img", ttl_seconds: 60 };

describe("playbooks router", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    // Migrations seed a built-in `researcher` playbook; start from a clean
    // table so id-ordering and count assertions are deterministic.
    await db("playbooks").del();
    setDb(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("GET /api/playbooks", () => {
    it("lists playbooks newest-first", async () => {
      const a = await createPlaybook({ ...VALID, name: "a" }, db);
      const b = await createPlaybook({ ...VALID, name: "b" }, db);
      const res = await request(app).get("/api/playbooks");
      expect(res.status).toBe(200);
      expect(res.body.map((p: { id: number }) => p.id)).toEqual([b.id, a.id]);
    });
  });

  describe("GET /api/playbooks/:id", () => {
    it("returns one playbook", async () => {
      const created = await createPlaybook(VALID, db);
      const res = await request(app).get(`/api/playbooks/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("pb");
    });

    it("404s for a missing playbook", async () => {
      const res = await request(app).get("/api/playbooks/9999");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });
  });

  describe("POST /api/playbooks", () => {
    it("creates a playbook with defaults applied", async () => {
      const res = await request(app).post("/api/playbooks").send(VALID);
      expect(res.status).toBe(201);
      expect(res.body.id).toBeGreaterThan(0);
      expect(res.body.network).toBe("open");
      expect(res.body.output_kind).toBe("findings");
      expect(await getPlaybook(res.body.id, db)).toBeDefined();
    });

    it("creates a playbook with validated steps and resources", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({
          ...VALID,
          resources: { cpus: 2, memory_mb: 512 },
          steps: [{ phase: "pre", command_template: "echo hi", label: "greet" }],
          runner: "claude-code",
          runner_config: { allowed_tools: ["Bash"] },
          env_requirements: ["TOKEN"],
        });
      expect(res.status).toBe(201);
      expect(res.body.resources).toEqual({ cpus: 2, memory_mb: 512 });
      expect(res.body.steps).toHaveLength(1);
      expect(res.body.runner).toBe("claude-code");
      expect(res.body.runner_config).toEqual({ allowed_tools: ["Bash"] });
    });

    it("creates a playbook with a valid isolation level", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, isolation: "sandboxed" });
      expect(res.status).toBe(201);
      expect(res.body.isolation).toBe("sandboxed");
    });

    it("defaults isolation to null when omitted", async () => {
      const res = await request(app).post("/api/playbooks").send(VALID);
      expect(res.status).toBe(201);
      expect(res.body.isolation).toBeNull();
    });

    it("400s on an unknown isolation level", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, isolation: "nope" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("isolation");
    });

    it("400s on an unknown runner id", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, runner: "does-not-exist" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("runner");
    });

    it("400s when runner_config is not an object", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, runner_config: "nope" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("runner_config");
    });

    it("400s on the retired model/allowed_tools keys, pointing at runner_config", async () => {
      for (const key of ["model", "allowed_tools"]) {
        const res = await request(app)
          .post("/api/playbooks")
          .send({ ...VALID, [key]: "x" });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain("runner_config");
      }
    });

    it("creates a playbook with validated granted_capabilities", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({
          ...VALID,
          granted_capabilities: [
            { capability_id: "ado.get_work_item", config: { org: "acme" } },
            { capability_id: "other.thing" },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.granted_capabilities).toEqual([
        { capability_id: "ado.get_work_item", config: { org: "acme" } },
        { capability_id: "other.thing" },
      ]);
    });

    it("400s when a granted capability is missing its capability_id", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, granted_capabilities: [{ config: {} }] });
      expect(res.status).toBe(400);
    });

    it("400s when a granted capability config is not an object", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({
          ...VALID,
          granted_capabilities: [
            { capability_id: "x", config: "nope" },
          ],
        });
      expect(res.status).toBe(400);
    });

    it("400s when name is missing", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ image: "img", ttl_seconds: 60 });
      expect(res.status).toBe(400);
    });

    it("400s when ttl_seconds is not a positive integer", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, ttl_seconds: 0 });
      expect(res.status).toBe(400);
    });

    it("400s on an unknown field", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, bogus: true });
      expect(res.status).toBe(400);
    });

    it("400s on an invalid step phase", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({
          ...VALID,
          steps: [{ phase: "nope", command_template: "x", label: "y" }],
        });
      expect(res.status).toBe(400);
    });

    it("400s when resources holds a non-integer", async () => {
      const res = await request(app)
        .post("/api/playbooks")
        .send({ ...VALID, resources: { cpus: "two" } });
      expect(res.status).toBe(400);
    });

    it("409s on a duplicate name", async () => {
      await createPlaybook(VALID, db);
      const res = await request(app).post("/api/playbooks").send(VALID);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: expect.any(String) });
    });
  });

  describe("PATCH /api/playbooks/:id", () => {
    it("updates provided fields only", async () => {
      const created = await createPlaybook(VALID, db);
      const res = await request(app)
        .patch(`/api/playbooks/${created.id}`)
        .send({ image: "img2", network: "none" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("pb");
      expect(res.body.image).toBe("img2");
      expect(res.body.network).toBe("none");
    });

    it("404s for a missing playbook", async () => {
      const res = await request(app)
        .patch("/api/playbooks/9999")
        .send({ image: "x" });
      expect(res.status).toBe(404);
    });

    it("clears isolation back to the default with an explicit null", async () => {
      const created = await createPlaybook({ ...VALID, isolation: "vm" }, db);
      const res = await request(app)
        .patch(`/api/playbooks/${created.id}`)
        .send({ isolation: null });
      expect(res.status).toBe(200);
      expect(res.body.isolation).toBeNull();
    });

    it("409s when renaming onto an existing name", async () => {
      await createPlaybook({ ...VALID, name: "taken" }, db);
      const mine = await createPlaybook({ ...VALID, name: "mine" }, db);
      const res = await request(app)
        .patch(`/api/playbooks/${mine.id}`)
        .send({ name: "taken" });
      expect(res.status).toBe(409);
    });

    it("400s on an invalid field type", async () => {
      const created = await createPlaybook(VALID, db);
      const res = await request(app)
        .patch(`/api/playbooks/${created.id}`)
        .send({ ttl_seconds: "long" });
      expect(res.status).toBe(400);
    });
  });

  /**
   * Seed one dispatch (with the given status) plus a run and a finding beneath
   * it, all owned by `playbookId`. Returns the new dispatch id.
   */
  async function seedRun(
    playbookId: number,
    status: DispatchStatus
  ): Promise<number> {
    const event = await insertEvent(
      {
        source: "s",
        type: "t",
        subject_kind: "k",
        subject_ref: "r",
        payload: {},
      },
      db
    );
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbookId, status },
      db
    );
    const run = await createRun({ dispatch_id: dispatch.id }, db);
    await createFinding({ run_id: run.id, content: "f" }, db);
    return dispatch.id;
  }

  describe("DELETE /api/playbooks/:id", () => {
    it("deletes an unreferenced playbook", async () => {
      const created = await createPlaybook(VALID, db);
      const res = await request(app).delete(`/api/playbooks/${created.id}`);
      expect(res.status).toBe(204);
      expect(await getPlaybook(created.id, db)).toBeUndefined();
    });

    it("404s for a missing playbook", async () => {
      const res = await request(app).delete("/api/playbooks/9999");
      expect(res.status).toBe(404);
    });

    it("cascades terminal run history and deletes the playbook (204)", async () => {
      const created = await createPlaybook(VALID, db);
      const d1 = await seedRun(created.id, "done");
      const d2 = await seedRun(created.id, "failed");

      const res = await request(app).delete(`/api/playbooks/${created.id}`);
      expect(res.status).toBe(204);

      // The playbook, its dispatches, runs, and findings are all gone.
      expect(await getPlaybook(created.id, db)).toBeUndefined();
      for (const id of [d1, d2]) {
        expect(await db("dispatches").where({ id }).first()).toBeUndefined();
      }
      expect(
        await db("runs")
          .join("dispatches", "runs.dispatch_id", "dispatches.id")
          .where("dispatches.playbook_id", created.id)
          .first()
      ).toBeUndefined();
      expect(await db("findings").count({ n: "*" }).first()).toMatchObject({
        n: 0,
      });
    });

    it("409s with an in-flight count when a non-terminal dispatch exists", async () => {
      const created = await createPlaybook(VALID, db);
      await seedRun(created.id, "done");
      await seedRun(created.id, "running");

      const res = await request(app).delete(`/api/playbooks/${created.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("playbook has 1 in-flight dispatches");
      // Nothing was deleted — the playbook and its history remain.
      expect(await getPlaybook(created.id, db)).toBeDefined();
      expect(await db("dispatches").count({ n: "*" }).first()).toMatchObject({
        n: 2,
      });
    });

    it("deletes even when a rule still references the playbook", async () => {
      const created = await createPlaybook(VALID, db);
      await createRule(
        { name: "r", dispatch: [{ playbook_id: created.id }] },
        db
      );
      const res = await request(app).delete(`/api/playbooks/${created.id}`);
      expect(res.status).toBe(204);
      expect(await getPlaybook(created.id, db)).toBeUndefined();
    });
  });

  describe("GET /api/playbooks/:id/usage", () => {
    it("404s for a missing playbook", async () => {
      const res = await request(app).get("/api/playbooks/9999/usage");
      expect(res.status).toBe(404);
    });

    it("reports cascade counts, in-flight, and enabled referencing rules", async () => {
      const created = await createPlaybook(VALID, db);
      await seedRun(created.id, "done");
      await seedRun(created.id, "failed");
      await seedRun(created.id, "running");
      const enabled = await createRule(
        { name: "on", enabled: true, dispatch: [{ playbook_id: created.id }] },
        db
      );
      // A disabled rule referencing it is omitted; an unrelated rule too.
      await createRule(
        { name: "off", enabled: false, dispatch: [{ playbook_id: created.id }] },
        db
      );
      await createRule(
        { name: "other", dispatch: [{ playbook_id: created.id + 999 }] },
        db
      );

      const res = await request(app).get(`/api/playbooks/${created.id}/usage`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        dispatches: 3,
        runs: 3,
        findings: 3,
        in_flight: 1,
        referencing_rules: [{ id: enabled.id, name: "on" }],
      });
    });
  });
});

import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { getModuleConfig } from "../db/moduleConfig";
import {
  ModuleRegistry,
  type BackfillOptions,
  type OrchestratorModule,
} from "../modules/registry";
import { resetRuntime, setRuntime } from "../runtime";
import { TriggerScheduler } from "../services/triggerScheduler";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-modules-router-"));
  return path.join(dir, "test.sqlite");
}

describe("modules router", () => {
  let file: string;
  let db: Knex;
  let registry: ModuleRegistry;
  let scheduler: TriggerScheduler;
  let applied: unknown[];
  /** Records every options object the backfill-capable producer was invoked with. */
  let backfillCalls: BackfillOptions[];
  /** When set, the backfill-capable producer throws it instead of returning. */
  let backfillThrows: Error | null;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);

    registry = new ModuleRegistry();
    scheduler = new TriggerScheduler({
      resolveTick: (id) => registry.getProducer(id)?.tick,
    });
    applied = [];

    const testModule: OrchestratorModule = {
      id: "mod.test",
      producers: [
        { id: "mod.test.poll", tick: async () => {}, defaultTrigger: { kind: "manual" } },
      ],
      validateConfig(config) {
        const c = config as { intervalSeconds?: unknown };
        if (c.intervalSeconds !== undefined && typeof c.intervalSeconds !== "number") {
          throw new Error("intervalSeconds must be a number");
        }
      },
      applyConfig(config) {
        applied.push(config);
        const c = config as { intervalSeconds?: number };
        scheduler.applyTrigger(
          "mod.test.poll",
          typeof c.intervalSeconds === "number"
            ? { kind: "interval", seconds: c.intervalSeconds }
            : { kind: "manual" }
        );
      },
    };
    registry.register(testModule);
    backfillCalls = [];
    backfillThrows = null;

    setRuntime({ registry, scheduler });
  });

  afterEach(async () => {
    scheduler.stop();
    await db.destroy();
    resetRuntime();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("GET /api/modules", () => {
    it("lists module ids with producer statuses", async () => {
      // arm the producer so it has a status to report
      scheduler.applyTrigger("mod.test.poll", { kind: "interval", seconds: 60 });
      const res = await request(app).get("/api/modules");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("mod.test");
      expect(res.body[0].producers).toHaveLength(1);
      expect(res.body[0].producers[0].producerId).toBe("mod.test.poll");
      expect(res.body[0].producers[0].trigger).toEqual({
        kind: "interval",
        seconds: 60,
      });
    });

    it("reports null status for a never-scheduled producer", async () => {
      const res = await request(app).get("/api/modules");
      expect(res.status).toBe(200);
      expect(res.body[0].producers[0].trigger).toBeNull();
      expect(res.body[0].producers[0].lastTickAt).toBeNull();
    });

    it("503s when no module system is wired", async () => {
      resetRuntime();
      const res = await request(app).get("/api/modules");
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/modules/:id/config", () => {
    it("returns null config before anything is stored", async () => {
      const res = await request(app).get("/api/modules/mod.test/config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ module_id: "mod.test", config: null });
    });

    it("404s for an unknown module", async () => {
      const res = await request(app).get("/api/modules/nope/config");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/modules/:id/config", () => {
    it("persists the config and reconciles the producer trigger", async () => {
      const res = await request(app)
        .put("/api/modules/mod.test/config")
        .send({ intervalSeconds: 120 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        module_id: "mod.test",
        config: { intervalSeconds: 120 },
      });
      // stored
      expect(await getModuleConfig("mod.test", db)).toEqual({
        intervalSeconds: 120,
      });
      // reconcile ran: applyConfig invoked, trigger re-derived
      expect(applied).toEqual([{ intervalSeconds: 120 }]);
      expect(scheduler.getProducerStatus("mod.test.poll")?.trigger).toEqual({
        kind: "interval",
        seconds: 120,
      });
    });

    it("400s when the module rejects the config, without persisting", async () => {
      const res = await request(app)
        .put("/api/modules/mod.test/config")
        .send({ intervalSeconds: "fast" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
      // nothing persisted, applyConfig never ran
      expect(await getModuleConfig("mod.test", db)).toBeUndefined();
      expect(applied).toEqual([]);
    });

    it("404s for an unknown module", async () => {
      const res = await request(app)
        .put("/api/modules/nope/config")
        .send({ x: 1 });
      expect(res.status).toBe(404);
    });

    it("400s on a non-object body", async () => {
      const res = await request(app)
        .put("/api/modules/mod.test/config")
        .set("Content-Type", "application/json")
        .send("[]");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/modules/:id/backfill", () => {
    // A module whose first producer implements the optional backfill hook (and a
    // second producer that does NOT), registered per-test so the module-listing
    // tests above stay a single-module world.
    beforeEach(() => {
      const backfillModule: OrchestratorModule = {
        id: "mod.backfill",
        producers: [
          {
            id: "mod.backfill.poll",
            tick: async () => {},
            defaultTrigger: { kind: "manual" },
            backfill: async (options) => {
              backfillCalls.push(options);
              if (backfillThrows) throw backfillThrows;
              const candidates = 5;
              return {
                candidates,
                emitted: options.dryRun
                  ? 0
                  : Math.min(candidates, options.limit ?? candidates),
              };
            },
          },
          {
            id: "mod.backfill.other",
            tick: async () => {},
            defaultTrigger: { kind: "manual" },
          },
        ],
      };
      registry.register(backfillModule);
    });

    it("404s for an unknown module", async () => {
      const res = await request(app)
        .post("/api/modules/nope/backfill")
        .send({ dry_run: true });
      expect(res.status).toBe(404);
      expect(backfillCalls).toEqual([]);
    });

    it("400s for a module whose producers do not support backfill", async () => {
      const res = await request(app)
        .post("/api/modules/mod.test/backfill")
        .send({ dry_run: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/support backfill/);
    });

    it("dry_run is side-effect free and returns the candidate count", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ dry_run: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ candidates: 5, emitted: 0 });
      expect(backfillCalls).toEqual([{ dryRun: true, limit: undefined }]);
    });

    it("passes limit and a non-dry run through to the hook", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ limit: 2 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ candidates: 5, emitted: 2 });
      expect(backfillCalls).toEqual([{ dryRun: false, limit: 2 }]);
    });

    it("defaults dry_run to false when omitted", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ candidates: 5, emitted: 5 });
      expect(backfillCalls).toEqual([{ dryRun: false, limit: undefined }]);
    });

    it("targets an explicit producer_id", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ producer_id: "mod.backfill.poll", dry_run: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ candidates: 5, emitted: 0 });
    });

    it("404s when the named producer_id is not on the module", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ producer_id: "mod.backfill.missing", dry_run: true });
      expect(res.status).toBe(404);
      expect(backfillCalls).toEqual([]);
    });

    it("400s when the named producer does not support backfill", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ producer_id: "mod.backfill.other", dry_run: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/support backfill/);
    });

    it("surfaces a hook refusal as a 400 with its message", async () => {
      backfillThrows = new Error("module is disabled");
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ dry_run: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("module is disabled");
    });

    it("400s on a bad limit", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ limit: 0 });
      expect(res.status).toBe(400);
      expect(backfillCalls).toEqual([]);
    });

    it("400s on an unknown body field", async () => {
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ nope: 1 });
      expect(res.status).toBe(400);
      expect(backfillCalls).toEqual([]);
    });

    it("503s when no module system is wired", async () => {
      resetRuntime();
      const res = await request(app)
        .post("/api/modules/mod.backfill/backfill")
        .send({ dry_run: true });
      expect(res.status).toBe(503);
    });
  });
});

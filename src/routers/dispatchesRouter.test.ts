import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import {
  claimNextQueuedDispatch,
  createDispatch,
  getDispatch,
  updateDispatch,
} from "../db/dispatches";
import { insertEvent } from "../db/events";
import { createFinding } from "../db/findings";
import { createPlaybook } from "../db/playbooks";
import { runMigrations } from "../db/migrate";
import { createRun } from "../db/runs";
import { setSetting } from "../db/settings";
import type { DispatchStatus } from "../interfaces";
import { resetRuntime, setRuntime } from "../runtime";
import { openDispatchLog } from "../services/dispatchLog";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dispatches-router-"));
  return path.join(dir, "test.sqlite");
}

describe("dispatches router", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
    resetRuntime();
  });

  afterEach(async () => {
    await db.destroy();
    resetRuntime();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  async function seedDispatch(
    status: DispatchStatus = "queued",
    attempts = 0,
    payload: unknown = {}
  ): Promise<number> {
    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "item",
        subject_ref: "ref-1",
        payload,
      },
      db
    );
    const playbook = await createPlaybook(
      { name: `pb-${Math.random()}`, image: "img", ttl_seconds: 60 },
      db
    );
    const dispatch = await createDispatch(
      {
        event_id: event.id,
        playbook_id: playbook.id,
        status,
        attempts,
        error: status === "failed" ? "boom" : null,
      },
      db
    );
    return dispatch.id;
  }

  describe("GET /api/dispatches", () => {
    it("lists dispatches newest-first", async () => {
      const a = await seedDispatch("queued");
      const b = await seedDispatch("failed");
      const res = await request(app).get("/api/dispatches");
      expect(res.status).toBe(200);
      expect(res.body.map((d: { id: number }) => d.id)).toEqual([b, a]);
    });

    it("filters by status", async () => {
      await seedDispatch("queued");
      const failed = await seedDispatch("failed");
      const res = await request(app).get("/api/dispatches?status=failed");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(failed);
    });

    it("400s on an unknown status", async () => {
      const res = await request(app).get("/api/dispatches?status=nope");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("active=1 returns only the non-terminal statuses", async () => {
      const queued = await seedDispatch("queued");
      const leasing = await seedDispatch("leasing");
      const running = await seedDispatch("running");
      const collecting = await seedDispatch("collecting");
      await seedDispatch("done");
      await seedDispatch("failed");

      const res = await request(app).get("/api/dispatches?active=1");
      expect(res.status).toBe(200);
      expect(res.body.map((d: { status: string }) => d.status).sort()).toEqual(
        ["collecting", "leasing", "queued", "running"]
      );
      const ids = res.body.map((d: { id: number }) => d.id).sort();
      expect(ids).toEqual([queued, leasing, running, collecting].sort());
    });

    it("returns the full history when active is absent", async () => {
      await seedDispatch("queued");
      await seedDispatch("done");
      await seedDispatch("failed");
      const res = await request(app).get("/api/dispatches");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
    });

    it("filters by the q search param and composes with status", async () => {
      const hit = await seedDispatch("failed", 0, { title: "Zebra crossing" });
      await seedDispatch("queued", 0, { title: "nothing here" });

      // Matches the subject title of the failed dispatch only.
      const res = await request(app).get("/api/dispatches?q=Zebra");
      expect(res.status).toBe(200);
      expect(res.body.map((d: { id: number }) => d.id)).toEqual([hit]);

      // q composes with status: the queued filter excludes the failed match.
      const composed = await request(app).get(
        "/api/dispatches?q=Zebra&status=queued"
      );
      expect(composed.body).toEqual([]);
    });

    it("carries the triggering event's subject fields on each row", async () => {
      const withHints = await seedDispatch("queued", 0, {
        title: "Fix the widget",
        url: "https://example.test/wi/42",
      });
      const noHints = await seedDispatch("queued", 0, { note: "no title here" });

      const res = await request(app).get("/api/dispatches");
      expect(res.status).toBe(200);
      const rich = res.body.find((d: { id: number }) => d.id === withHints);
      expect(rich).toMatchObject({
        subject_kind: "item",
        subject_ref: "ref-1",
        event_type: "thing.changed",
        subject_title: "Fix the widget",
        subject_url: "https://example.test/wi/42",
      });
      // A payload without title/url yields null hints, never a crash.
      const plain = res.body.find((d: { id: number }) => d.id === noHints);
      expect(plain).toMatchObject({
        subject_kind: "item",
        subject_ref: "ref-1",
        subject_title: null,
        subject_url: null,
      });
    });

    it("adds no waiting fields when the run-budget gate is off", async () => {
      const queuedId = await seedDispatch("queued");
      const res = await request(app).get("/api/dispatches");
      const queued = res.body.find((d: { id: number }) => d.id === queuedId);
      expect(queued.waiting_reason).toBeUndefined();
      expect(queued.status).toBe("queued");
    });

    it("annotates queued dispatches held by the run budget with waiting_reason", async () => {
      await setSetting("run_budget_per_hour", "1", db);
      // A run started just now fills the default 60-minute window to the budget.
      const doneId = await seedDispatch("done");
      await createRun({ dispatch_id: doneId, started_at: Date.now() }, db);
      const queuedId = await seedDispatch("queued");

      const res = await request(app).get("/api/dispatches");
      expect(res.status).toBe(200);
      const queued = res.body.find((d: { id: number }) => d.id === queuedId);
      expect(queued.waiting_reason).toBe("budget");
      expect(queued.window_count).toBe(1);
      expect(queued.budget).toBe(1);
      expect(typeof queued.next_eligible_at).toBe("number");
      // Non-queued rows are left untouched.
      const done = res.body.find((d: { id: number }) => d.id === doneId);
      expect(done.waiting_reason).toBeUndefined();
    });

    it("exposes waiting_reason on the dispatch detail endpoint too", async () => {
      await setSetting("run_budget_per_hour", "1", db);
      const doneId = await seedDispatch("done");
      await createRun({ dispatch_id: doneId, started_at: Date.now() }, db);
      const queuedId = await seedDispatch("queued");

      const res = await request(app).get(`/api/dispatches/${queuedId}`);
      expect(res.status).toBe(200);
      expect(res.body.waiting_reason).toBe("budget");
      expect(res.body.budget).toBe(1);
      expect(Array.isArray(res.body.runs)).toBe(true);
    });
  });

  describe("GET /api/dispatches/:id", () => {
    it("embeds runs and their findings", async () => {
      const id = await seedDispatch("done");
      const run = await createRun({ dispatch_id: id, exit_code: 0 }, db);
      await createFinding({ run_id: run.id, content: "found it" }, db);

      const res = await request(app).get(`/api/dispatches/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].id).toBe(run.id);
      expect(res.body.runs[0].findings).toHaveLength(1);
      expect(res.body.runs[0].findings[0].content).toBe("found it");
    });

    it("includes the triggering event's subject fields on the detail", async () => {
      const id = await seedDispatch("done", 0, {
        title: "Fix the widget",
        url: "https://example.test/wi/42",
      });

      const res = await request(app).get(`/api/dispatches/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        subject_kind: "item",
        subject_ref: "ref-1",
        event_type: "thing.changed",
        subject_title: "Fix the widget",
        subject_url: "https://example.test/wi/42",
      });
    });

    it("404s for a missing dispatch", async () => {
      const res = await request(app).get("/api/dispatches/9999");
      expect(res.status).toBe(404);
    });

    it("400s for a non-numeric id", async () => {
      const res = await request(app).get("/api/dispatches/abc");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/dispatches/:id/retry", () => {
    it("requeues a failed dispatch, resets attempts, and kicks the dispatcher", async () => {
      const id = await seedDispatch("failed", 3);
      // give it a stale (already-released) lease/contract to prove the
      // handles AND the release tracking are cleared for the fresh attempt
      await updateDispatch(
        id,
        { lease_id: "lease-1", wisp_contract_id: "c-1", released_at: 111 },
        db
      );

      let kicked = 0;
      setRuntime({ dispatcher: { kick: () => (kicked += 1) } });

      const res = await request(app).post(`/api/dispatches/${id}/retry`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("queued");
      expect(res.body.attempts).toBe(0);
      expect(res.body.lease_id).toBeNull();
      expect(res.body.wisp_contract_id).toBeNull();
      expect(res.body.released_at).toBeNull();
      expect(res.body.release_pending).toBe(false);
      expect(res.body.error).toBeNull();
      expect(kicked).toBe(1);

      const reloaded = await getDispatch(id, db);
      expect(reloaded?.status).toBe("queued");
      expect(reloaded?.attempts).toBe(0);
      expect(reloaded?.released_at).toBeNull();
      expect(reloaded?.release_pending).toBe(false);
    });

    it("409s while the dispatch still holds an unreleased lease (sweep owns it)", async () => {
      const id = await seedDispatch("failed");
      // lease_id set, released_at null = release still pending; requeueing
      // would drop the handle out of the sweep's predicate and leak the lease.
      await updateDispatch(
        id,
        { lease_id: "lease-unreleased", release_pending: true },
        db
      );

      const res = await request(app).post(`/api/dispatches/${id}/retry`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/release/i);

      // untouched: still failed, lease handle and release flag intact
      const reloaded = await getDispatch(id, db);
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.lease_id).toBe("lease-unreleased");
      expect(reloaded?.release_pending).toBe(true);
    });

    it("409s when the dispatch is not failed", async () => {
      const id = await seedDispatch("running");
      const res = await request(app).post(`/api/dispatches/${id}/retry`);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: expect.any(String) });
      // unchanged
      const reloaded = await getDispatch(id, db);
      expect(reloaded?.status).toBe("running");
    });

    it("404s for a missing dispatch", async () => {
      const res = await request(app).post("/api/dispatches/9999/retry");
      expect(res.status).toBe(404);
    });

    it("succeeds even when no dispatcher is wired (kick is a no-op)", async () => {
      const id = await seedDispatch("failed");
      // resetRuntime already ran in beforeEach: no dispatcher present.
      const res = await request(app).post(`/api/dispatches/${id}/retry`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("queued");
    });
  });

  describe("POST /api/dispatches", () => {
    async function seedEventAndPlaybook(): Promise<{
      eventId: number;
      playbookId: number;
    }> {
      const event = await insertEvent(
        {
          source: "moduleA",
          type: "thing.changed",
          subject_kind: "item",
          subject_ref: "ref-1",
          payload: { title: "Fix the widget" },
        },
        db
      );
      const playbook = await createPlaybook(
        { name: `pb-${Math.random()}`, image: "img", ttl_seconds: 60 },
        db
      );
      return { eventId: event.id, playbookId: playbook.id };
    }

    it("creates a queued dispatch with rule_id null and kicks the dispatcher", async () => {
      const { eventId, playbookId } = await seedEventAndPlaybook();
      let kicked = 0;
      setRuntime({ dispatcher: { kick: () => (kicked += 1) } });

      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: eventId, playbook_id: playbookId });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        event_id: eventId,
        playbook_id: playbookId,
        rule_id: null,
        status: "queued",
        attempts: 0,
      });
      // Same shape as the GET endpoints: subject fields joined in.
      expect(res.body).toMatchObject({
        subject_kind: "item",
        subject_ref: "ref-1",
        event_type: "thing.changed",
        subject_title: "Fix the widget",
      });
      expect(kicked).toBe(1);

      const reloaded = await getDispatch(res.body.id, db);
      expect(reloaded?.status).toBe("queued");
      expect(reloaded?.rule_id).toBeNull();
      expect(reloaded?.attempts).toBe(0);
    });

    it("succeeds even when no dispatcher is wired (kick is a no-op)", async () => {
      const { eventId, playbookId } = await seedEventAndPlaybook();
      // resetRuntime already ran in beforeEach: no dispatcher present.
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: eventId, playbook_id: playbookId });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("queued");
    });

    it("makes the dispatch claimable by the dispatcher queue", async () => {
      const { eventId, playbookId } = await seedEventAndPlaybook();
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: eventId, playbook_id: playbookId });
      expect(res.status).toBe(201);

      const claimed = await claimNextQueuedDispatch(db);
      expect(claimed?.id).toBe(res.body.id);
      expect(claimed?.status).toBe("leasing");
      expect(claimed?.rule_id).toBeNull();
    });

    it("is not blocked by the per-event dispatch cap", async () => {
      const { eventId, playbookId } = await seedEventAndPlaybook();
      await setSetting("dispatch_max_per_event", "0", db);
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: eventId, playbook_id: playbookId });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("queued");
    });

    it("404s when the event does not exist", async () => {
      const { playbookId } = await seedEventAndPlaybook();
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: 9999, playbook_id: playbookId });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("404s when the playbook does not exist", async () => {
      const { eventId } = await seedEventAndPlaybook();
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: eventId, playbook_id: 9999 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s on a missing body field", async () => {
      const { eventId } = await seedEventAndPlaybook();
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: eventId });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s on an unknown body key", async () => {
      const { eventId, playbookId } = await seedEventAndPlaybook();
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: eventId, playbook_id: playbookId, rule_id: 1 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("400s on a non-integer id", async () => {
      const { playbookId } = await seedEventAndPlaybook();
      const res = await request(app)
        .post("/api/dispatches")
        .send({ event_id: "1", playbook_id: playbookId });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });
  });

  describe("GET /api/dispatches/:id/log", () => {
    let logBaseDir: string;

    beforeEach(() => {
      logBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dispatch-log-"));
    });

    afterEach(() => {
      fs.rmSync(logBaseDir, { recursive: true, force: true });
    });

    it("404s when the dispatch does not exist", async () => {
      setRuntime({ logTail: { baseDir: logBaseDir } });
      const res = await request(app).get("/api/dispatches/9999/log");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("404s when the log file does not exist yet", async () => {
      const id = await seedDispatch("running");
      setRuntime({ logTail: { baseDir: logBaseDir } });
      const res = await request(app).get(`/api/dispatches/${id}/log`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it("streams current content then closes when the dispatch is terminal", async () => {
      const id = await seedDispatch("running");
      const dl = openDispatchLog(id, { baseDir: logBaseDir });
      dl.append("first line");
      dl.append("second line");
      dl.close();
      setRuntime({
        logTail: { baseDir: logBaseDir, pollIntervalMs: 20, statusIntervalMs: 20 },
      });

      // Flip to a terminal status shortly after the request opens so the tail
      // reads the current content and then closes on the status poll.
      const timer = setTimeout(() => {
        void updateDispatch(id, { status: "done" }, db);
      }, 60);

      const res = await request(app).get(`/api/dispatches/${id}/log`);
      clearTimeout(timer);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).toContain("first line");
      expect(res.text).toContain("second line");
    });

    it("tails bytes appended after the stream has started", async () => {
      const id = await seedDispatch("running");
      const dl = openDispatchLog(id, { baseDir: logBaseDir });
      dl.append("initial content");
      // Long status interval: the tail stays open on the running dispatch until
      // the client disconnects, so we can observe an append surface mid-stream.
      setRuntime({
        logTail: {
          baseDir: logBaseDir,
          pollIntervalMs: 20,
          statusIntervalMs: 5000,
        },
      });

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const collected = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timed out waiting for appended bytes")),
            4000
          );
          const req = http.get(
            { host: "127.0.0.1", port, path: `/api/dispatches/${id}/log` },
            (res) => {
              res.setEncoding("utf8");
              let all = "";
              let appended = false;
              res.on("data", (chunk: string) => {
                all += chunk;
                if (!appended && all.includes("initial content")) {
                  // Only append once the initial content has been delivered, so
                  // a match on "appended" proves the poll saw a mid-stream write.
                  appended = true;
                  dl.append("appended content");
                }
                if (all.includes("appended content")) {
                  clearTimeout(timeout);
                  req.destroy();
                  resolve(all);
                }
              });
            }
          );
          // A client-side destroy() surfaces as a reset; it is expected here.
          req.on("error", () => {});
        });
        expect(collected).toContain("initial content");
        expect(collected).toContain("appended content");
      } finally {
        dl.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

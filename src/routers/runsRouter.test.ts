import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { createDispatch } from "../db/dispatches";
import { insertEvent } from "../db/events";
import { createFinding } from "../db/findings";
import { createPlaybook } from "../db/playbooks";
import { createRun } from "../db/runs";
import { runMigrations } from "../db/migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runs-router-"));
  return path.join(dir, "test.sqlite");
}

describe("runs router", () => {
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

  async function seedRun(): Promise<number> {
    const event = await insertEvent(
      {
        source: "m",
        type: "t",
        subject_kind: "item",
        subject_ref: "r",
        payload: { title: "Seeded subject", url: "https://example.test/x" },
      },
      db
    );
    const playbook = await createPlaybook(
      { name: "pb", image: "img", ttl_seconds: 60 },
      db
    );
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbook.id },
      db
    );
    const run = await createRun(
      { dispatch_id: dispatch.id, exit_code: 0, result_text: "hi" },
      db
    );
    return run.id;
  }

  describe("GET /api/runs", () => {
    it("returns newest-first run history with outcome and findings, incl. run-less dispatches", async () => {
      const event = await insertEvent(
        {
          source: "m",
          type: "t",
          subject_kind: "workitem",
          subject_ref: "42",
          payload: { title: "Fix the widget", url: "https://example.test/wi/42" },
        },
        db
      );
      const playbook = await createPlaybook(
        { name: "pb", image: "img", ttl_seconds: 60 },
        db
      );
      // A done dispatch with a run + a finding.
      const doneDispatch = await createDispatch(
        { event_id: event.id, playbook_id: playbook.id, status: "done" },
        db
      );
      const run = await createRun(
        {
          dispatch_id: doneDispatch.id,
          started_at: 1000,
          ended_at: 3000,
          exit_code: 0,
          usage: { input_tokens: 7, output_tokens: 3 },
        },
        db
      );
      await createFinding({ run_id: run.id, content: "c" }, db);
      // A dispatch that failed before producing a run.
      const failedDispatch = await createDispatch(
        {
          event_id: event.id,
          playbook_id: playbook.id,
          status: "failed",
          error: "nope",
        },
        db
      );

      const res = await request(app).get("/api/runs");
      expect(res.status).toBe(200);
      expect(res.body.map((r: { dispatch_id: number }) => r.dispatch_id)).toEqual([
        failedDispatch.id,
        doneDispatch.id,
      ]);
      expect(res.body[0]).toMatchObject({
        status: "failed",
        exit_code: null,
        duration_ms: null,
        total_tokens: null,
        findings_count: 0,
        error: "nope",
      });
      expect(res.body[1]).toMatchObject({
        status: "done",
        exit_code: 0,
        duration_ms: 2000,
        total_tokens: 10,
        findings_count: 1,
      });
      // Both rows carry the triggering event's subject, with payload hints.
      for (const row of res.body) {
        expect(row).toMatchObject({
          subject_kind: "workitem",
          subject_ref: "42",
          event_type: "t",
          subject_title: "Fix the widget",
          subject_url: "https://example.test/wi/42",
        });
      }
    });

    it("filters by ?status=", async () => {
      const event = await insertEvent(
        { source: "m", type: "t", subject_kind: "item", subject_ref: "r", payload: {} },
        db
      );
      const playbook = await createPlaybook(
        { name: "pb", image: "img", ttl_seconds: 60 },
        db
      );
      const done = await createDispatch(
        { event_id: event.id, playbook_id: playbook.id, status: "done" },
        db
      );
      await createDispatch(
        { event_id: event.id, playbook_id: playbook.id, status: "failed" },
        db
      );

      const res = await request(app).get("/api/runs?status=done");
      expect(res.status).toBe(200);
      expect(res.body.map((r: { dispatch_id: number }) => r.dispatch_id)).toEqual([
        done.id,
      ]);
    });

    it("400s for an unknown ?status=", async () => {
      const res = await request(app).get("/api/runs?status=bogus");
      expect(res.status).toBe(400);
    });

    it("400s for a malformed ?limit=", async () => {
      const res = await request(app).get("/api/runs?limit=nope");
      expect(res.status).toBe(400);
    });

    it("filters by the q search param, including findings content, and composes with limit", async () => {
      const event = await insertEvent(
        { source: "m", type: "t", subject_kind: "item", subject_ref: "r", payload: {} },
        db
      );
      const playbook = await createPlaybook(
        { name: "pb", image: "img", ttl_seconds: 60 },
        db
      );
      // A dispatch whose run produces a finding containing a unique token.
      const hit = await createDispatch(
        { event_id: event.id, playbook_id: playbook.id, status: "done" },
        db
      );
      const run = await createRun({ dispatch_id: hit.id }, db);
      await createFinding({ run_id: run.id, content: "ticket XYZ-999" }, db);
      // An unrelated dispatch that should not match.
      await createDispatch(
        { event_id: event.id, playbook_id: playbook.id, status: "failed" },
        db
      );

      const res = await request(app).get("/api/runs?q=XYZ-999");
      expect(res.status).toBe(200);
      expect(res.body.map((r: { dispatch_id: number }) => r.dispatch_id)).toEqual([
        hit.id,
      ]);
      // q composes with limit (both applied to the filtered set).
      const limited = await request(app).get("/api/runs?q=XYZ-999&limit=1");
      expect(limited.body).toHaveLength(1);
      expect(limited.body[0].dispatch_id).toBe(hit.id);
    });
  });

  describe("GET /api/runs/:id", () => {
    it("returns a run with its findings embedded", async () => {
      const runId = await seedRun();
      await createFinding(
        { run_id: runId, content: "c", tags: ["x"] },
        db
      );
      const res = await request(app).get(`/api/runs/${runId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(runId);
      expect(res.body.result_text).toBe("hi");
      expect(res.body.findings).toHaveLength(1);
      expect(res.body.findings[0].tags).toEqual(["x"]);
      // Additive subject block traces the run to its triggering event.
      expect(res.body).toMatchObject({
        subject_kind: "item",
        subject_ref: "r",
        event_type: "t",
        subject_title: "Seeded subject",
        subject_url: "https://example.test/x",
      });
    });

    it("404s for a missing run", async () => {
      const res = await request(app).get("/api/runs/9999");
      expect(res.status).toBe(404);
    });

    it("400s for a non-numeric id", async () => {
      const res = await request(app).get("/api/runs/abc");
      expect(res.status).toBe(400);
    });
  });
});

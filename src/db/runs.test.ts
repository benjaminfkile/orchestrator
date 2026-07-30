import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "./db";
import { createDispatch, updateDispatch } from "./dispatches";
import { insertEvent } from "./events";
import { createFinding } from "./findings";
import { createPlaybook } from "./playbooks";
import {
  createRun,
  getRun,
  getRunSubjectFields,
  listRunHistory,
  listRuns,
  updateRun,
} from "./runs";
import { runMigrations } from "./migrate";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runs-"));
  return path.join(dir, "test.sqlite");
}

describe("runs repo", () => {
  let file: string;
  let db: Knex;
  let dispatchId: number;
  let eventId: number;
  let playbookId: number;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);

    const event = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "1",
      },
      db
    );
    eventId = event.id;
    const playbook = await createPlaybook(
      { name: "pb", image: "img", ttl_seconds: 60 },
      db
    );
    playbookId = playbook.id;
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbook.id },
      db
    );
    dispatchId = dispatch.id;
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("opens a run with null completion columns and a default started_at", async () => {
    const before = Date.now();
    const run = await createRun({ dispatch_id: dispatchId }, db);
    const after = Date.now();

    expect(run.id).toBeGreaterThan(0);
    expect(run.dispatch_id).toBe(dispatchId);
    expect(run.exit_code).toBeNull();
    expect(run.result_text).toBeNull();
    expect(run.usage).toBeNull();
    expect(run.log_path).toBeNull();
    expect(run.ended_at).toBeNull();
    expect(run.started_at).toBeGreaterThanOrEqual(before);
    expect(run.started_at).toBeLessThanOrEqual(after);

    const fetched = await getRun(run.id, db);
    expect(fetched).toEqual(run);
  });

  it("stores and reads back parsed usage JSON", async () => {
    const run = await createRun(
      {
        dispatch_id: dispatchId,
        started_at: 1000,
        usage: { input_tokens: 10, output_tokens: 3 },
        log_path: "/tmp/x.log",
      },
      db
    );
    expect(run.usage).toEqual({ input_tokens: 10, output_tokens: 3 });

    const fetched = await getRun(run.id, db);
    expect(fetched?.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  it("stores and reads back parsed collected step output", async () => {
    const run = await createRun(
      {
        dispatch_id: dispatchId,
        collected: { diff: "a\nb\n", log: "done" },
      },
      db
    );
    expect(run.collected).toEqual({ diff: "a\nb\n", log: "done" });

    const fetched = await getRun(run.id, db);
    expect(fetched?.collected).toEqual({ diff: "a\nb\n", log: "done" });
  });

  it("defaults collected to null and can clear it via null", async () => {
    const run = await createRun({ dispatch_id: dispatchId }, db);
    expect(run.collected).toBeNull();

    const updated = await updateRun(
      run.id,
      { collected: { out: "x" } },
      db
    );
    expect(updated?.collected).toEqual({ out: "x" });

    const cleared = await updateRun(run.id, { collected: null }, db);
    expect(cleared?.collected).toBeNull();
  });

  it("returns undefined for a missing run", async () => {
    expect(await getRun(9999, db)).toBeUndefined();
  });

  it("lists runs, optionally filtered by dispatch", async () => {
    const otherEvent = await insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "2",
      },
      db
    );
    const otherPlaybook = await createPlaybook(
      { name: "pb2", image: "img", ttl_seconds: 60 },
      db
    );
    const otherDispatch = await createDispatch(
      { event_id: otherEvent.id, playbook_id: otherPlaybook.id },
      db
    );

    const r1 = await createRun({ dispatch_id: dispatchId }, db);
    const r2 = await createRun({ dispatch_id: otherDispatch.id }, db);
    const r3 = await createRun({ dispatch_id: dispatchId }, db);

    // Newest-first: started_at DESC with id DESC to break ties.
    const all = await listRuns(undefined, db);
    expect(all.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);

    const forDispatch = await listRuns(dispatchId, db);
    expect(forDispatch.map((r) => r.id)).toEqual([r3.id, r1.id]);
  });

  it("updates a run to record completion, including clearing via null", async () => {
    const run = await createRun({ dispatch_id: dispatchId }, db);

    const done = await updateRun(
      run.id,
      {
        exit_code: 0,
        result_text: "ok",
        usage: { output_tokens: 5 },
        log_path: "/tmp/run.log",
        ended_at: 2000,
      },
      db
    );
    expect(done?.exit_code).toBe(0);
    expect(done?.result_text).toBe("ok");
    expect(done?.usage).toEqual({ output_tokens: 5 });
    expect(done?.log_path).toBe("/tmp/run.log");
    expect(done?.ended_at).toBe(2000);

    const cleared = await updateRun(run.id, { usage: null }, db);
    expect(cleared?.usage).toBeNull();
    // Fields not in the patch are untouched.
    expect(cleared?.result_text).toBe("ok");
  });

  it("returns undefined when updating a missing run", async () => {
    expect(await updateRun(9999, { exit_code: 1 }, db)).toBeUndefined();
  });

  describe("listRunHistory", () => {
    it("joins run outcome and findings, and includes run-less dispatches, newest-first", async () => {
      // Dispatch A (from beforeEach): a done run with findings and token usage.
      await updateDispatch(dispatchId, { status: "done" }, db);
      const run = await createRun(
        {
          dispatch_id: dispatchId,
          started_at: 1000,
          ended_at: 4000,
          exit_code: 0,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 4,
          },
        },
        db
      );
      await createFinding({ run_id: run.id, content: "f1" }, db);
      await createFinding({ run_id: run.id, content: "f2" }, db);

      // Dispatch B: failed before ever producing a run.
      const failed = await createDispatch(
        {
          event_id: eventId,
          playbook_id: playbookId,
          status: "failed",
          error: "boom",
        },
        db
      );

      const history = await listRunHistory({}, db);
      // Newest-first: B (higher id) precedes A.
      expect(history.map((h) => h.dispatch_id)).toEqual([failed.id, dispatchId]);

      const [b, a] = history;
      expect(b).toMatchObject({
        dispatch_id: failed.id,
        playbook_id: playbookId,
        status: "failed",
        ended_at: failed.updated_at,
        duration_ms: null,
        exit_code: null,
        total_tokens: null,
        findings_count: 0,
        error: "boom",
      });
      expect(a).toMatchObject({
        dispatch_id: dispatchId,
        status: "done",
        ended_at: 4000,
        duration_ms: 3000,
        exit_code: 0,
        total_tokens: 20,
        findings_count: 2,
        error: null,
      });
    });

    it("falls back to the latest run of a dispatch that has retries", async () => {
      await updateDispatch(dispatchId, { status: "done" }, db);
      await createRun(
        { dispatch_id: dispatchId, started_at: 1000, ended_at: 2000 },
        db
      );
      const latest = await createRun(
        {
          dispatch_id: dispatchId,
          started_at: 5000,
          ended_at: 9000,
          exit_code: 0,
        },
        db
      );
      await createFinding({ run_id: latest.id, content: "only latest" }, db);

      const [row] = await listRunHistory({}, db);
      expect(row.ended_at).toBe(9000);
      expect(row.duration_ms).toBe(4000);
      expect(row.findings_count).toBe(1);
    });

    it("filters by dispatch status", async () => {
      await updateDispatch(dispatchId, { status: "done" }, db);
      const failed = await createDispatch(
        { event_id: eventId, playbook_id: playbookId, status: "failed" },
        db
      );

      const done = await listRunHistory({ status: "done" }, db);
      expect(done.map((h) => h.dispatch_id)).toEqual([dispatchId]);

      const failedRows = await listRunHistory({ status: "failed" }, db);
      expect(failedRows.map((h) => h.dispatch_id)).toEqual([failed.id]);
    });

    it("honours the limit, keeping the newest rows", async () => {
      const second = await createDispatch(
        { event_id: eventId, playbook_id: playbookId },
        db
      );
      const third = await createDispatch(
        { event_id: eventId, playbook_id: playbookId },
        db
      );

      const rows = await listRunHistory({ limit: 2 }, db);
      expect(rows.map((h) => h.dispatch_id)).toEqual([third.id, second.id]);
    });

    it("returns an empty list when there are no dispatches", async () => {
      // Fresh db with no dispatches at all.
      const other = createDb(tempDbFile());
      await runMigrations(other);
      expect(await listRunHistory({}, other)).toEqual([]);
      await other.destroy();
    });

    it("carries the triggering event's subject fields, with payload title/url hints", async () => {
      const richEvent = await insertEvent(
        {
          source: "moduleA",
          type: "thing.changed",
          subject_kind: "workitem",
          subject_ref: "42",
          payload: {
            title: "Fix the widget",
            url: "https://example.test/wi/42",
            work_item_type: "Bug",
          },
        },
        db
      );
      const rich = await createDispatch(
        { event_id: richEvent.id, playbook_id: playbookId },
        db
      );

      const [row] = await listRunHistory({}, db);
      expect(row.dispatch_id).toBe(rich.id);
      expect(row).toMatchObject({
        subject_kind: "workitem",
        subject_ref: "42",
        event_type: "thing.changed",
        subject_title: "Fix the widget",
        subject_url: "https://example.test/wi/42",
        subject_type: "Bug",
      });
    });

    it("yields null title/url when the payload lacks (or mistypes) them, without crashing", async () => {
      // beforeEach's event has no payload at all; add one with non-string hints.
      const oddEvent = await insertEvent(
        {
          source: "moduleA",
          type: "thing.changed",
          subject_kind: "widget",
          subject_ref: "9",
          payload: { title: 123, url: ["not", "a", "string"], other: "x" },
        },
        db
      );
      const odd = await createDispatch(
        { event_id: oddEvent.id, playbook_id: playbookId },
        db
      );

      const rows = await listRunHistory({}, db);
      const oddRow = rows.find((r) => r.dispatch_id === odd.id);
      expect(oddRow).toMatchObject({
        subject_kind: "widget",
        subject_ref: "9",
        event_type: "thing.changed",
        subject_title: null,
        subject_url: null,
      });

      // The payload-less event from beforeEach also yields null hints.
      const baseRow = rows.find((r) => r.dispatch_id === dispatchId);
      expect(baseRow).toMatchObject({
        subject_kind: "widget",
        subject_ref: "1",
        subject_title: null,
        subject_url: null,
      });
    });
  });

  describe("getRunSubjectFields", () => {
    it("resolves the subject fields for a dispatch, reading payload hints", async () => {
      const richEvent = await insertEvent(
        {
          source: "moduleA",
          type: "pr.opened",
          subject_kind: "pr",
          subject_ref: "7",
          payload: { title: "Add feature", url: "https://example.test/pr/7" },
        },
        db
      );
      const rich = await createDispatch(
        { event_id: richEvent.id, playbook_id: playbookId },
        db
      );

      expect(await getRunSubjectFields(rich.id, db)).toEqual({
        subject_kind: "pr",
        subject_ref: "7",
        event_type: "pr.opened",
        subject_title: "Add feature",
        subject_url: "https://example.test/pr/7",
        subject_type: null,
      });
    });

    it("returns an all-null block for an unknown dispatch", async () => {
      expect(await getRunSubjectFields(9999, db)).toEqual({
        subject_kind: null,
        subject_ref: null,
        event_type: null,
        subject_title: null,
        subject_url: null,
        subject_type: null,
      });
    });
  });
});

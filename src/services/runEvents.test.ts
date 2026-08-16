import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db/db";
import { createDispatch, listDispatches } from "../db/dispatches";
import { insertEvent, listEvents } from "../db/events";
import { createFinding } from "../db/findings";
import { runMigrations } from "../db/migrate";
import { createPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import { createRun } from "../db/runs";
import type { DispatchRecord, EventRecord } from "../interfaces";

import {
  emitRunEvent,
  emitRunStartedEvent,
  RUN_COMPLETED_TYPE,
  RUN_FAILED_TYPE,
  RUN_STARTED_TYPE,
} from "./runEvents";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-run-events-"));
  return path.join(dir, "test.sqlite");
}

/** The single orchestrator-sourced callback event emitted during a test. */
async function emittedEvent(db: Knex): Promise<EventRecord> {
  const events = await listEvents({}, db);
  const callbacks = events.filter((e) => e.source === "orchestrator");
  expect(callbacks).toHaveLength(1);
  return callbacks[0];
}

describe("runEvents.emitRunEvent", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  /** Insert an originating event; `payload` defaults to an empty object. */
  async function seedEvent(payload: unknown = {}): Promise<EventRecord> {
    return insertEvent(
      {
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "42",
        payload,
      },
      db
    );
  }

  async function seedPlaybookId(name = "pb"): Promise<number> {
    const pb = await createPlaybook(
      { name, image: "img:latest", ttl_seconds: 60 },
      db
    );
    return pb.id;
  }

  it("emits a run.completed event with the full payload shape", async () => {
    const event = await seedEvent({ chain_depth: 2, title: "T" });
    const playbookId = await seedPlaybookId("investigator");
    const rule = await createRule({ name: "origin-rule" }, db);
    const dispatch = await createDispatch(
      {
        event_id: event.id,
        rule_id: rule.id,
        playbook_id: playbookId,
        status: "done",
      },
      db
    );
    const run = await createRun(
      {
        dispatch_id: dispatch.id,
        exit_code: 0,
        usage: { input_tokens: 10, output_tokens: 5 },
        collected: { summary: "out" },
        started_at: 1000,
        ended_at: 3500,
      },
      db
    );
    await createFinding(
      { run_id: run.id, content: "found A", tags: ["x"] },
      db
    );
    await createFinding({ run_id: run.id, content: "found B", tags: [] }, db);

    await emitRunEvent(dispatch, "done", { db });

    const emitted = await emittedEvent(db);
    expect(emitted.source).toBe("orchestrator");
    expect(emitted.type).toBe(RUN_COMPLETED_TYPE);
    expect(emitted.subject_kind).toBe("widget");
    expect(emitted.subject_ref).toBe("42");
    expect(emitted.dedupe_key).toBeNull();
    expect(emitted.payload).toEqual({
      dispatch_id: dispatch.id,
      run_id: run.id,
      playbook_id: playbookId,
      playbook_name: "investigator",
      rule_id: rule.id,
      status: "done",
      exit_code: 0,
      error: null,
      // listFindings is newest-first, so B (inserted last) leads.
      findings: [
        { content: "found B", tags: [] },
        { content: "found A", tags: ["x"] },
      ],
      findings_count: 2,
      collected: { summary: "out" },
      duration_ms: 2500,
      total_tokens: 15,
      origin: {
        event_id: event.id,
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "42",
      },
      chain_depth: 3,
    });
  });

  it("increments chain_depth from the origin event's payload", async () => {
    const event = await seedEvent({ chain_depth: 4 });
    const playbookId = await seedPlaybookId();
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbookId, status: "done" },
      db
    );
    await createRun(
      { dispatch_id: dispatch.id, exit_code: 0, started_at: 1, ended_at: 2 },
      db
    );

    await emitRunEvent(dispatch, "done", { db });

    const emitted = await emittedEvent(db);
    expect((emitted.payload as { chain_depth: number }).chain_depth).toBe(5);
  });

  it("treats a missing/non-numeric chain_depth as 0 (emits chain_depth 1)", async () => {
    // Payload without a numeric chain_depth: the origin depth defaults to 0.
    const event = await seedEvent({ chain_depth: "nope", other: 1 });
    const playbookId = await seedPlaybookId();
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbookId, status: "done" },
      db
    );
    await createRun(
      { dispatch_id: dispatch.id, exit_code: 0, started_at: 1, ended_at: 2 },
      db
    );

    await emitRunEvent(dispatch, "done", { db });

    const emitted = await emittedEvent(db);
    expect((emitted.payload as { chain_depth: number }).chain_depth).toBe(1);
  });

  it("emits run.failed with null run-derived fields when no run was created", async () => {
    const event = await seedEvent({});
    const playbookId = await seedPlaybookId("p");
    const dispatch = await createDispatch(
      {
        event_id: event.id,
        playbook_id: playbookId,
        status: "failed",
        error: "boom",
      },
      db
    );

    await emitRunEvent(dispatch, "failed", { db });

    const emitted = await emittedEvent(db);
    expect(emitted.type).toBe(RUN_FAILED_TYPE);
    expect(emitted.payload).toMatchObject({
      dispatch_id: dispatch.id,
      run_id: null,
      status: "failed",
      exit_code: null,
      error: "boom",
      findings: [],
      findings_count: 0,
      collected: null,
      duration_ms: null,
      total_tokens: null,
      chain_depth: 1,
    });
  });

  it("summarizes the latest run when a dispatch has several (retries)", async () => {
    const event = await seedEvent({});
    const playbookId = await seedPlaybookId();
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbookId, status: "done" },
      db
    );
    await createRun(
      { dispatch_id: dispatch.id, exit_code: 1, started_at: 1, ended_at: 2 },
      db
    );
    const latest = await createRun(
      { dispatch_id: dispatch.id, exit_code: 0, started_at: 10, ended_at: 40 },
      db
    );

    await emitRunEvent(dispatch, "done", { db });

    const emitted = await emittedEvent(db);
    expect(emitted.payload).toMatchObject({
      run_id: latest.id,
      exit_code: 0,
      duration_ms: 30,
    });
  });

  it("emits run.started with the start-time payload subset (no terminal fields)", async () => {
    const event = await seedEvent({ chain_depth: 2, title: "T" });
    const playbookId = await seedPlaybookId("investigator");
    const rule = await createRule({ name: "origin-rule" }, db);
    const dispatch = await createDispatch(
      {
        event_id: event.id,
        rule_id: rule.id,
        playbook_id: playbookId,
        status: "leasing",
      },
      db
    );

    await emitRunStartedEvent(dispatch, { db });

    const emitted = await emittedEvent(db);
    expect(emitted.source).toBe("orchestrator");
    expect(emitted.type).toBe(RUN_STARTED_TYPE);
    expect(emitted.subject_kind).toBe("widget");
    expect(emitted.subject_ref).toBe("42");
    expect(emitted.dedupe_key).toBeNull();
    // Payload is the terminal shape MINUS the terminal-only fields: no
    // run_id/status/exit_code/error/findings/collected/duration/tokens.
    expect(emitted.payload).toEqual({
      dispatch_id: dispatch.id,
      playbook_id: playbookId,
      playbook_name: "investigator",
      rule_id: rule.id,
      origin: {
        event_id: event.id,
        source: "moduleA",
        type: "thing.changed",
        subject_kind: "widget",
        subject_ref: "42",
      },
      chain_depth: 3,
    });
  });

  it("run.started increments chain_depth like the terminal events", async () => {
    const event = await seedEvent({ chain_depth: 4 });
    const playbookId = await seedPlaybookId();
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbookId, status: "leasing" },
      db
    );

    await emitRunStartedEvent(dispatch, { db });

    const emitted = await emittedEvent(db);
    expect((emitted.payload as { chain_depth: number }).chain_depth).toBe(5);
  });

  it("run.started matches rules against the callback event and enqueues a chained dispatch", async () => {
    const event = await seedEvent({});
    const playbookId = await seedPlaybookId();
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbookId, status: "leasing" },
      db
    );

    const reactionPlaybook = await seedPlaybookId("reaction");
    await createRule(
      {
        name: "on-started",
        match: { source: "orchestrator", type: RUN_STARTED_TYPE },
        dispatch: [{ playbook_id: reactionPlaybook }],
      },
      db
    );

    let kicks = 0;
    await emitRunStartedEvent(dispatch, {
      db,
      dispatcher: { kick: () => (kicks += 1) },
    });

    const chained = (await listDispatches("queued", db)).filter(
      (d: DispatchRecord) => d.playbook_id === reactionPlaybook
    );
    expect(chained).toHaveLength(1);
    expect(kicks).toBe(1);
  });

  it("matches rules against the callback event and enqueues a chained dispatch", async () => {
    const event = await seedEvent({});
    const playbookId = await seedPlaybookId();
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbookId, status: "done" },
      db
    );

    // A rule that reacts to run.completed by dispatching a (second) playbook.
    const reactionPlaybook = await seedPlaybookId("reaction");
    await createRule(
      {
        name: "on-complete",
        match: { source: "orchestrator", type: RUN_COMPLETED_TYPE },
        dispatch: [{ playbook_id: reactionPlaybook }],
      },
      db
    );

    let kicks = 0;
    await emitRunEvent(dispatch, "done", {
      db,
      dispatcher: { kick: () => (kicks += 1) },
    });

    // The callback event drove a new dispatch and the dispatcher was kicked.
    const chained = (await listDispatches("queued", db)).filter(
      (d: DispatchRecord) => d.playbook_id === reactionPlaybook
    );
    expect(chained).toHaveLength(1);
    expect(kicks).toBe(1);
  });
});

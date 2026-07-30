import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDispatch } from "../db/dispatches";
import { insertEvent } from "../db/events";
import { runMigrations } from "../db/migrate";
import { createDb } from "../db/db";
import { createPlaybook } from "../db/playbooks";
import { createRun } from "../db/runs";
import { setSetting } from "../db/settings";

import { evaluateRunBudget } from "./runBudget";

/** Fixed base clock for deterministic windows (2026-07-15T00:00:00Z-ish). */
const T0 = 1_752_537_600_000;

describe("evaluateRunBudget", () => {
  let db: Knex;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runbudget-"));
    db = createDb(path.join(dir, "test.sqlite"));
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Seed one dispatch (needed so a run's FK resolves) and return its id. */
  async function seedDispatch(): Promise<number> {
    const event = await insertEvent(
      {
        source: "m",
        type: "t",
        subject_kind: "k",
        subject_ref: "r",
        payload: {},
      },
      db
    );
    const playbook = await createPlaybook(
      { name: `pb-${event.id}`, image: "img", ttl_seconds: 600, prompt_template: "p" },
      db
    );
    const dispatch = await createDispatch(
      { event_id: event.id, playbook_id: playbook.id },
      db
    );
    return dispatch.id;
  }

  /** Record a completed run started at `startedAt`, optionally with token usage. */
  async function seedRun(
    startedAt: number,
    usage?: Record<string, number>
  ): Promise<void> {
    const dispatchId = await seedDispatch();
    await createRun(
      { dispatch_id: dispatchId, started_at: startedAt, usage: usage ?? null },
      db
    );
  }

  it("returns null (disabled) when neither knob is set — today's behavior", async () => {
    await seedRun(T0);
    await seedRun(T0);
    expect(await evaluateRunBudget({ db, now: () => T0 })).toBeNull();
  });

  it("returns null when run_budget_per_hour is 0 (explicitly disabled)", async () => {
    await setSetting("run_budget_per_hour", "0", db);
    await seedRun(T0);
    expect(await evaluateRunBudget({ db, now: () => T0 })).toBeNull();
  });

  it("does not hold while the window count is below the budget", async () => {
    await setSetting("run_budget_per_hour", "2", db);
    await seedRun(T0); // one run in the trailing 60-minute window
    expect(await evaluateRunBudget({ db, now: () => T0 })).toBeNull();
  });

  it("holds once the window count reaches the budget, exposing budget metadata", async () => {
    await setSetting("run_budget_per_hour", "2", db);
    await seedRun(T0 - 1000);
    await seedRun(T0 - 500);
    const hold = await evaluateRunBudget({ db, now: () => T0 });
    expect(hold).toEqual({
      waiting_reason: "budget",
      window_count: 2,
      budget: 2,
      // Oldest in-window run (T0-1000) leaves after the default 60-min window.
      next_eligible_at: T0 - 1000 + 60 * 60 * 1000,
    });
  });

  it("respects a custom window: a run older than the window is not counted", async () => {
    await setSetting("run_budget_per_hour", "1", db);
    await setSetting("run_budget_window_minutes", "5", db); // 5-minute window
    const fiveMin = 5 * 60 * 1000;
    // A run that started just before the window opened does not count.
    await seedRun(T0 - fiveMin - 1);
    expect(await evaluateRunBudget({ db, now: () => T0 })).toBeNull();
    // One inside the window trips the budget of 1.
    await seedRun(T0 - 1000);
    expect(await evaluateRunBudget({ db, now: () => T0 })).not.toBeNull();
  });

  it("token breaker holds when summed in-window usage exceeds the token budget", async () => {
    await setSetting("token_budget_per_window", "1000", db);
    await seedRun(T0 - 2000, { input_tokens: 400, output_tokens: 400 });
    await seedRun(T0 - 1000, { input_tokens: 300 });
    const hold = await evaluateRunBudget({ db, now: () => T0 });
    expect(hold).toMatchObject({
      waiting_reason: "budget",
      token_breaker: true,
      token_budget: 1000,
      window_tokens: 1100,
      budget: null, // no run-count budget configured
      next_eligible_at: T0 - 2000 + 60 * 60 * 1000,
    });
  });

  it("token breaker does not hold at or below the budget", async () => {
    await setSetting("token_budget_per_window", "1000", db);
    await seedRun(T0 - 1000, { input_tokens: 1000 }); // exactly at budget
    expect(await evaluateRunBudget({ db, now: () => T0 })).toBeNull();
  });

  it("token breaker releases as the window slides past the costly run", async () => {
    await setSetting("token_budget_per_window", "1000", db);
    await setSetting("run_budget_window_minutes", "5", db);
    const fiveMin = 5 * 60 * 1000;
    await seedRun(T0, { input_tokens: 5000 });
    // Immediately over budget.
    expect(await evaluateRunBudget({ db, now: () => T0 })).not.toBeNull();
    // Once the clock advances past the window, the run ages out and it releases.
    expect(
      await evaluateRunBudget({ db, now: () => T0 + fiveMin + 1 })
    ).toBeNull();
  });
});

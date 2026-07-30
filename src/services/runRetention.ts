/**
 * Run-retention pruning: an OPTIONAL, data-driven cap on how much TERMINAL run
 * history the app keeps. Over time the `done`/`failed` dispatch rows (each the
 * unit of a "run") accumulate without bound; this pass trims the oldest of them
 * once their count exceeds `run_retention_max` so the Queue and Runs lists — and
 * the on-disk per-dispatch log files — do not grow forever.
 *
 * What is pruned, oldest-first, for each dispatch beyond the cap:
 *   - the dispatch's runs' findings, then those runs, then the dispatch row
 *     itself (FK order, in a transaction per batch);
 *   - the per-dispatch log file on disk ({@link dispatchLogPath}); a missing
 *     file is not an error.
 *
 * What is NEVER touched: non-terminal (queued/leasing/running/collecting)
 * dispatches, the originating `events` rows, and `notification_log`. Deleting a
 * dispatch removes its run history, but the event that triggered it stays.
 *
 * Per the architecture principle this module is domain-neutral: it counts and
 * deletes opaque terminal rows and never inspects intent.
 */

import fs from "fs";

import type { Knex } from "knex";

import { getDb } from "../db/db";
import type { DispatchStatus } from "../interfaces";
import { log, type Logger } from "../log";

import { publish as publishChange } from "./changeBus";
import { dispatchLogPath } from "./dispatchLog";

/** app_settings key: max TERMINAL dispatches to keep (0/negative = pruning off). */
export const RUN_RETENTION_MAX_SETTING = "run_retention_max";

/** Retention cap when `run_retention_max` is unset, empty, or unparseable. */
export const DEFAULT_RUN_RETENTION_MAX = 2000;

/** The terminal dispatch statuses this pass considers for pruning. */
const TERMINAL_STATUSES: readonly DispatchStatus[] = ["done", "failed"];

/** How many dispatches to delete per transaction, bounding a single batch. */
const PRUNE_BATCH_SIZE = 500;

/**
 * Read the retention cap. Absent / empty / non-numeric ("garbage") falls back to
 * {@link DEFAULT_RUN_RETENTION_MAX}; a parseable value is floored and returned
 * as-is, so 0 or a negative number is a deliberate "disable pruning" signal that
 * {@link pruneRunRetention} honors by doing nothing.
 */
export async function readRetentionCap(db: Knex = getDb()): Promise<number> {
  const row = await db<{ key: string; value: string }>("app_settings")
    .where({ key: RUN_RETENTION_MAX_SETTING })
    .first();
  if (row === undefined || row.value.trim() === "") {
    return DEFAULT_RUN_RETENTION_MAX;
  }
  const parsed = Number(row.value);
  if (!Number.isFinite(parsed)) return DEFAULT_RUN_RETENTION_MAX;
  return Math.floor(parsed);
}

/** Injected collaborators for {@link pruneRunRetention}. */
export interface RunRetentionDeps {
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /**
   * Base directory holding the per-dispatch log files; forwarded to
   * {@link dispatchLogPath}. Defaults there to the OS user-data dir; tests point
   * it at a temp directory.
   */
  logBaseDir?: string;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
}

/** Outcome of a retention pass. */
export interface RunRetentionResult {
  /** The effective cap read from settings (<= 0 means pruning is disabled). */
  cap: number;
  /** How many terminal dispatches (and their run history) were pruned. */
  prunedDispatches: number;
}

/**
 * FK-safe deletion of a set of dispatches and all their run history, shared by
 * the retention pass and the playbook-delete cascade so both use one order and
 * one log-file policy.
 *
 * For each batch of at most {@link PRUNE_BATCH_SIZE} ids: inside a single
 * transaction delete the dispatches' runs' findings, then those runs, then the
 * dispatch rows (FK order); after the transaction commits, best-effort remove
 * each dispatch's on-disk log file (the filesystem is not transactional — a
 * missing file is expected and never an error, any other unlink failure is
 * logged, not thrown). Returns the number of dispatch rows deleted.
 *
 * The caller decides WHICH dispatches to pass (retention picks the oldest
 * terminal ones beyond the cap; playbook-delete picks a playbook's terminal
 * ones) — this helper is domain-neutral and never inspects status or intent.
 */
export async function deleteDispatchesWithHistory(
  ids: number[],
  deps: RunRetentionDeps = {}
): Promise<number> {
  const db = deps.db ?? getDb();
  const logger = (deps.logger ?? log).child({ component: "run-retention" });

  let deleted = 0;
  for (let i = 0; i < ids.length; i += PRUNE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + PRUNE_BATCH_SIZE);
    // FK-safe cascade inside one transaction per batch: findings -> runs ->
    // dispatch. Either the whole batch commits or none of it does.
    await db.transaction(async (trx) => {
      const runRows = await trx<{ id: number }>("runs")
        .whereIn("dispatch_id", chunk)
        .select("id");
      const runIds = runRows.map((r) => r.id);
      if (runIds.length > 0) {
        await trx("findings").whereIn("run_id", runIds).del();
      }
      await trx("runs").whereIn("dispatch_id", chunk).del();
      await trx("dispatches").whereIn("id", chunk).del();
    });
    deleted += chunk.length;

    // The DB rows are gone; now drop each dispatch's log file. This is outside
    // the transaction (the filesystem is not transactional) and best-effort: a
    // missing file is expected (stepless/never-logged dispatches) and never an
    // error, and any other unlink failure is logged, not thrown.
    for (const id of chunk) {
      const filePath = dispatchLogPath(id, deps.logBaseDir);
      try {
        fs.rmSync(filePath, { force: true });
      } catch (err) {
        logger.warn("failed to remove pruned dispatch log", {
          dispatchId: id,
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // Deletions change the run history the SPA is showing: publish so an open
  // Queue/Runs page drops the pruned/cascaded rows without a manual refresh.
  // (The repo-layer publishes cover creates/updates; deletes happen only here.)
  if (deleted > 0) {
    publishChange("dispatches");
    publishChange("runs");
  }
  return deleted;
}

/**
 * Prune terminal run history down to the `run_retention_max` cap, oldest-first.
 *
 * A no-op when the cap is <= 0 (disabled) or the terminal-dispatch count is at
 * or under the cap. Otherwise it deletes the `count - cap` oldest terminal
 * dispatches (by `created_at`, then `id`) — each dispatch's findings, then its
 * runs, then the dispatch row, in FK order inside a per-batch transaction — and
 * best-effort removes each pruned dispatch's log file from disk.
 */
export async function pruneRunRetention(
  deps: RunRetentionDeps = {}
): Promise<RunRetentionResult> {
  const db = deps.db ?? getDb();
  const logger = (deps.logger ?? log).child({ component: "run-retention" });

  const cap = await readRetentionCap(db);
  if (cap <= 0) return { cap, prunedDispatches: 0 };

  const countRow = await db("dispatches")
    .whereIn("status", [...TERMINAL_STATUSES])
    .count<{ n: number | string }>({ n: "*" })
    .first();
  const total = Number(countRow?.n ?? 0);
  if (total <= cap) return { cap, prunedDispatches: 0 };

  const excess = total - cap;
  // The `excess` OLDEST terminal dispatches: created_at ascending, id ascending
  // to break ties — the mirror of the newest-first Runs list, so the newest
  // `cap` rows are exactly the ones kept.
  const victims = await db<{ id: number }>("dispatches")
    .whereIn("status", [...TERMINAL_STATUSES])
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(excess)
    .select("id");
  const ids = victims.map((v) => v.id);

  // Delegate the FK-safe cascade + log-file removal to the shared helper so the
  // playbook-delete path and this pass never drift in deletion order or policy.
  const pruned = await deleteDispatchesWithHistory(ids, {
    db,
    logBaseDir: deps.logBaseDir,
    logger: deps.logger,
  });

  logger.info("pruned terminal run history", {
    cap,
    total,
    prunedDispatches: pruned,
  });
  return { cap, prunedDispatches: pruned };
}

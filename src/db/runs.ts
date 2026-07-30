import type { Knex } from "knex";

import type {
  DispatchStatus,
  EventSubjectFields,
  NewRun,
  RunHistoryRow,
  RunRecord,
  RunUpdate,
} from "../interfaces";
import { publish as publishChange } from "../services/changeBus";

import { getDb } from "./db";
import { deriveSubjectFields } from "./events";
import { likeExprSql, likePattern, searchTerms } from "./search";

/** The four usage fields summed into `total_tokens`, matching the executor. */
const USAGE_TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * Sum the token fields of a parsed `usage` object. Returns null when `usage` is
 * absent/not an object, else the sum of the non-negative finite token counts
 * (an object with none of the fields sums to 0).
 */
export function sumUsageTokens(usage: unknown): number | null {
  if (usage === null || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  let total = 0;
  for (const field of USAGE_TOKEN_FIELDS) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      total += value;
    }
  }
  return total;
}

/** Raw row shape as stored on disk: usage is JSON-encoded TEXT (or null). */
interface RunRow {
  id: number;
  dispatch_id: number;
  exit_code: number | null;
  result_text: string | null;
  usage: string | null;
  collected: string | null;
  log_path: string | null;
  started_at: number;
  ended_at: number | null;
}

/** Decode an on-disk row into a typed {@link RunRecord} with parsed usage. */
function fromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    dispatch_id: row.dispatch_id,
    exit_code: row.exit_code,
    result_text: row.result_text,
    usage: row.usage === null ? null : JSON.parse(row.usage),
    collected: row.collected === null ? null : JSON.parse(row.collected),
    log_path: row.log_path,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

/**
 * Open a run and return the stored record. `started_at` defaults to the current
 * time; the completion columns (`exit_code`, `result_text`, `usage`,
 * `log_path`, `ended_at`) fall back to null.
 */
export async function createRun(
  run: NewRun,
  db: Knex = getDb()
): Promise<RunRecord> {
  const [row] = await db<RunRow>("runs")
    .insert({
      dispatch_id: run.dispatch_id,
      exit_code: run.exit_code ?? null,
      result_text: run.result_text ?? null,
      usage:
        run.usage === undefined || run.usage === null
          ? null
          : JSON.stringify(run.usage),
      collected:
        run.collected === undefined || run.collected === null
          ? null
          : JSON.stringify(run.collected),
      log_path: run.log_path ?? null,
      started_at: run.started_at ?? Date.now(),
      ended_at: run.ended_at ?? null,
    })
    .returning("*");
  // Signal the live SPA that a run was created. Fire-and-forget; coalesced.
  publishChange("runs");
  return fromRow(row);
}

/** Fetch a single run by id, or `undefined` if none exists. */
export async function getRun(
  id: number,
  db: Knex = getDb()
): Promise<RunRecord | undefined> {
  const row = await db<RunRow>("runs").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/**
 * List runs newest-first (`started_at` DESC — a run's creation time — with `id`
 * DESC to break ties). Pass `dispatchId` to filter to a single dispatch's runs.
 */
export async function listRuns(
  dispatchId?: number,
  db: Knex = getDb()
): Promise<RunRecord[]> {
  let query = db<RunRow>("runs")
    .orderBy("started_at", "desc")
    .orderBy("id", "desc");
  if (dispatchId !== undefined) query = query.where({ dispatch_id: dispatchId });
  const rows = await query;
  return rows.map(fromRow);
}

/**
 * A summary of the runs whose `started_at` falls at or after `sinceMs` — the
 * trailing-window aggregate the dispatcher's run-budget gate counts against:
 *   - `count`: how many runs started in the window (the run-budget measure)
 *   - `tokenSum`: the sum of every in-window run's usage tokens (reusing
 *     {@link sumUsageTokens}), for the optional token circuit breaker
 *   - `oldestStartedAt`: the earliest `started_at` in the window, or null when
 *     the window is empty; `oldestStartedAt + windowMs` is when the window next
 *     slides far enough to drop a run (the gate's `next_eligible_at`).
 * Usage is a JSON-encoded TEXT column, so tokens are summed in JS, mirroring
 * {@link listRunHistory}.
 */
export async function getRunBudgetWindow(
  sinceMs: number,
  db: Knex = getDb()
): Promise<{ count: number; tokenSum: number; oldestStartedAt: number | null }> {
  const rows = await db<RunRow>("runs")
    .where("started_at", ">=", sinceMs)
    .select("started_at", "usage");
  let tokenSum = 0;
  let oldestStartedAt: number | null = null;
  for (const row of rows) {
    if (oldestStartedAt === null || row.started_at < oldestStartedAt) {
      oldestStartedAt = row.started_at;
    }
    const usage = row.usage === null ? null : JSON.parse(row.usage);
    tokenSum += sumUsageTokens(usage) ?? 0;
  }
  return { count: rows.length, tokenSum, oldestStartedAt };
}

/**
 * A dispatch row as needed to build run history, newest first, LEFT-JOINed with
 * its triggering event so each row can carry the generic subject display fields
 * ({@link deriveSubjectFields}). The `event_*`/`subject_*` columns are nullable
 * because the join tolerates a (in practice impossible) event-less dispatch.
 */
interface HistoryDispatchRow {
  id: number;
  playbook_id: number;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  event_type: string | null;
  subject_kind: string | null;
  subject_ref: string | null;
  event_payload: string | null;
}

/**
 * The dispatch/event-level searchable expressions for a run-history `q` filter:
 * the playbook name (from the join added only when searching), the dispatch's
 * status/error, the event's subject columns and type, and the `title` read
 * generically out of the event payload JSON. These are trusted, hard-coded SQL
 * expressions — the user's terms flow only through bound patterns. The run
 * `result_text`/`collected` and findings `content` are searched via EXISTS
 * subqueries (below) because joining them would multiply the one-row-per-
 * dispatch result.
 */
const RUN_HISTORY_SEARCH_EXPRESSIONS = [
  "playbooks.name",
  "dispatches.status",
  "dispatches.error",
  "events.subject_kind",
  "events.subject_ref",
  "events.type",
  "json_extract(events.payload, '$.title')",
] as const;

/**
 * AND a `q` free-text filter onto the run-history dispatch query. Each
 * whitespace-separated term must appear (as an escaped, case-insensitive
 * substring) in one of the dispatch/event columns, in the playbook name, in any
 * of the dispatch's runs' `result_text`/`collected` (JSON TEXT searched raw), or
 * in any finding produced by those runs. The run and finding matches use EXISTS
 * subqueries so the result stays one row per dispatch (a join would duplicate
 * rows). The filter is applied before the `limit`, so paging walks the FILTERED
 * set. An empty/whitespace `q` leaves the query untouched.
 */
function applyRunHistorySearch(
  query: Knex.QueryBuilder<HistoryDispatchRow>,
  q: string | undefined,
  db: Knex
): Knex.QueryBuilder<HistoryDispatchRow> {
  const terms = searchTerms(q);
  if (terms.length === 0) return query;
  // Join the playbook only when searching by name; the FK is unique so this
  // adds no rows, and no columns are selected from it.
  let out = query.leftJoin("playbooks", "dispatches.playbook_id", "playbooks.id");
  for (const term of terms) {
    const pattern = likePattern(term);
    out = out.where((b) => {
      for (const expr of RUN_HISTORY_SEARCH_EXPRESSIONS) {
        b.orWhereRaw(likeExprSql(expr), [pattern]);
      }
      // A run of this dispatch whose result text or collected JSON matches.
      b.orWhereExists(
        db
          .select(db.raw("1"))
          .from("runs")
          .whereRaw("runs.dispatch_id = dispatches.id")
          .andWhere((rb) => {
            rb.orWhereRaw(likeExprSql("runs.result_text"), [pattern]);
            rb.orWhereRaw(likeExprSql("runs.collected"), [pattern]);
          })
      );
      // A finding produced by any run of this dispatch whose content matches.
      b.orWhereExists(
        db
          .select(db.raw("1"))
          .from("runs")
          .join("findings", "findings.run_id", "runs.id")
          .whereRaw("runs.dispatch_id = dispatches.id")
          .andWhereRaw(likeExprSql("findings.content"), [pattern])
      );
    });
  }
  return out;
}

/**
 * List run history, one row PER DISPATCH (a dispatch is the unit of a run),
 * newest first. Each dispatch's latest run is left-joined so dispatches that
 * failed before producing a run still appear, with the run-derived fields null
 * and `findings_count` 0.
 *
 * Runs three queries rather than N per-row fetches: the dispatches, then the
 * runs for those dispatches (latest kept per dispatch), then the findings
 * counts for those runs. `usage` is a JSON-encoded TEXT column, so token totals
 * are summed in JS rather than in SQL.
 */
export async function listRunHistory(
  opts: { status?: DispatchStatus; limit?: number; q?: string } = {},
  db: Knex = getDb()
): Promise<RunHistoryRow[]> {
  const limit = opts.limit ?? 200;
  // Left-join the triggering event so each row can carry the generic subject
  // fields; the join is by the existing `event_id`, so no schema change or new
  // index is needed (the FK id is the primary key on `events`). Columns are
  // table-qualified because the two tables share names (`id`, `subject_*`, …).
  let dispatchQuery = db<HistoryDispatchRow>("dispatches")
    .leftJoin("events", "dispatches.event_id", "events.id")
    .select(
      "dispatches.id as id",
      "dispatches.playbook_id as playbook_id",
      "dispatches.status as status",
      "dispatches.error as error",
      "dispatches.created_at as created_at",
      "dispatches.updated_at as updated_at",
      "events.type as event_type",
      "events.subject_kind as subject_kind",
      "events.subject_ref as subject_ref",
      "events.payload as event_payload"
    )
    .orderBy("dispatches.created_at", "desc")
    .orderBy("dispatches.id", "desc")
    .limit(limit);
  if (opts.status !== undefined) {
    dispatchQuery = dispatchQuery.where("dispatches.status", opts.status);
  }
  dispatchQuery = applyRunHistorySearch(dispatchQuery, opts.q, db);
  const dispatches = await dispatchQuery;
  if (dispatches.length === 0) return [];

  const dispatchIds = dispatches.map((d) => d.id);
  const runRows = await db<RunRow>("runs")
    .whereIn("dispatch_id", dispatchIds)
    .orderBy("id", "asc");
  // Keep the latest run per dispatch (retries add rows); ascending order means
  // the last write wins.
  const latestRunByDispatch = new Map<number, RunRow>();
  for (const row of runRows) latestRunByDispatch.set(row.dispatch_id, row);

  const runIds = [...latestRunByDispatch.values()].map((r) => r.id);
  const findingsCountByRun = new Map<number, number>();
  if (runIds.length > 0) {
    const counts = await db("findings")
      .whereIn("run_id", runIds)
      .groupBy("run_id")
      .select("run_id")
      .count<{ run_id: number; n: number | string }[]>({ n: "*" });
    for (const c of counts) {
      findingsCountByRun.set(Number(c.run_id), Number(c.n));
    }
  }

  return dispatches.map((d) => {
    const run = latestRunByDispatch.get(d.id);
    const endedAt = run?.ended_at ?? d.updated_at;
    return {
      dispatch_id: d.id,
      playbook_id: d.playbook_id,
      status: d.status as DispatchStatus,
      created_at: d.created_at,
      ended_at: endedAt,
      duration_ms: run ? endedAt - run.started_at : null,
      exit_code: run?.exit_code ?? null,
      total_tokens: run ? sumUsageTokens(fromRow(run).usage) : null,
      findings_count: run ? findingsCountByRun.get(run.id) ?? 0 : 0,
      error: d.error,
      ...deriveSubjectFields({
        type: d.event_type,
        subject_kind: d.subject_kind,
        subject_ref: d.subject_ref,
        payload: d.event_payload,
      }),
    };
  });
}

/**
 * The generic subject display fields of the event that triggered a dispatch,
 * resolved by joining `dispatches` → `events` on the existing `event_id`. Backs
 * the additive subject block on the single-run response; returns an all-null
 * block when the dispatch (or its event) cannot be found. See
 * {@link deriveSubjectFields}.
 */
export async function getRunSubjectFields(
  dispatchId: number,
  db: Knex = getDb()
): Promise<EventSubjectFields> {
  const row = await db("dispatches")
    .leftJoin("events", "dispatches.event_id", "events.id")
    .where("dispatches.id", dispatchId)
    .select(
      "events.type as event_type",
      "events.subject_kind as subject_kind",
      "events.subject_ref as subject_ref",
      "events.payload as event_payload"
    )
    .first();
  return deriveSubjectFields(
    row
      ? {
          type: row.event_type,
          subject_kind: row.subject_kind,
          subject_ref: row.subject_ref,
          payload: row.event_payload,
        }
      : undefined
  );
}

/**
 * Apply a partial update to a run — typically to record its completion. Every
 * field present in the patch is written, so a nullable column can be explicitly
 * cleared by passing `null`. Returns the updated record, or `undefined` if no
 * run with `id` exists.
 */
export async function updateRun(
  id: number,
  patch: RunUpdate,
  db: Knex = getDb()
): Promise<RunRecord | undefined> {
  const changes: Partial<RunRow> = {};
  if ("exit_code" in patch) changes.exit_code = patch.exit_code ?? null;
  if ("result_text" in patch) changes.result_text = patch.result_text ?? null;
  if ("usage" in patch) {
    changes.usage =
      patch.usage === undefined || patch.usage === null
        ? null
        : JSON.stringify(patch.usage);
  }
  if ("collected" in patch) {
    changes.collected =
      patch.collected === undefined || patch.collected === null
        ? null
        : JSON.stringify(patch.collected);
  }
  if ("log_path" in patch) changes.log_path = patch.log_path ?? null;
  if ("ended_at" in patch) changes.ended_at = patch.ended_at ?? null;
  if (Object.keys(changes).length === 0) return getRun(id, db);
  const count = await db<RunRow>("runs").where({ id }).update(changes);
  if (count === 0) return undefined;
  publishChange("runs");
  return getRun(id, db);
}

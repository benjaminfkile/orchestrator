import type { Knex } from "knex";

import type {
  DispatchRecord,
  DispatchStatus,
  DispatchUpdate,
  EventSubjectFields,
  NewDispatch,
} from "../interfaces";
import { publish as publishChange } from "../services/changeBus";

import { getDb } from "./db";
import { deriveSubjectFields } from "./events";
import { applySearchFilter, searchTerms } from "./search";

/** Raw row shape as stored on disk. */
interface DispatchRow {
  id: number;
  event_id: number;
  rule_id: number | null;
  playbook_id: number;
  status: string;
  lease_id: string | null;
  wisp_contract_id: string | null;
  attempts: number;
  error: string | null;
  released_at: number | null;
  // sqlite stores booleans as 0/1; treat any truthy as true.
  release_pending: number | boolean | null;
  created_at: number;
  updated_at: number;
}

/** Decode an on-disk row into a typed {@link DispatchRecord}. */
function fromRow(row: DispatchRow): DispatchRecord {
  return {
    id: row.id,
    event_id: row.event_id,
    rule_id: row.rule_id,
    playbook_id: row.playbook_id,
    status: row.status as DispatchStatus,
    lease_id: row.lease_id,
    wisp_contract_id: row.wisp_contract_id,
    attempts: row.attempts,
    error: row.error,
    released_at: row.released_at ?? null,
    release_pending: Boolean(row.release_pending),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A dispatch decoded with the generic subject fields of its triggering event. */
export type DispatchWithSubject = DispatchRecord & EventSubjectFields;

/**
 * The non-terminal lifecycle states — a dispatch still waiting to run or in
 * flight. These are exactly the statuses that belong on the Queue view; the
 * terminal `done`/`failed` pair is the Runs history's territory. Kept here (not
 * in the router) so both the repo query and the router validation share one
 * source of truth.
 */
export const ACTIVE_DISPATCH_STATUSES: readonly DispatchStatus[] = [
  "queued",
  "leasing",
  "running",
  "collecting",
];

/**
 * A dispatch row LEFT-JOINed with its triggering event's subject columns. The
 * `event_*`/`subject_*` columns are nullable because the join tolerates a (in
 * practice impossible) event-less dispatch; `event_payload` is the on-disk
 * JSON-encoded TEXT.
 */
interface DispatchSubjectRow extends DispatchRow {
  event_type: string | null;
  subject_kind: string | null;
  subject_ref: string | null;
  event_payload: string | null;
}

/**
 * The columns selected for a subject-joined dispatch read, table-qualified and
 * aliased because `dispatches` and `events` share column names (`id`, …). The
 * join is by the existing `event_id` FK (a primary-key lookup on `events`), so
 * no schema change or new index is needed.
 */
const DISPATCH_SUBJECT_COLUMNS = [
  "dispatches.id as id",
  "dispatches.event_id as event_id",
  "dispatches.rule_id as rule_id",
  "dispatches.playbook_id as playbook_id",
  "dispatches.status as status",
  "dispatches.lease_id as lease_id",
  "dispatches.wisp_contract_id as wisp_contract_id",
  "dispatches.attempts as attempts",
  "dispatches.error as error",
  "dispatches.released_at as released_at",
  "dispatches.release_pending as release_pending",
  "dispatches.created_at as created_at",
  "dispatches.updated_at as updated_at",
  "events.type as event_type",
  "events.subject_kind as subject_kind",
  "events.subject_ref as subject_ref",
  "events.payload as event_payload",
] as const;

/** Decode a subject-joined row into a record plus its derived subject fields. */
function fromSubjectRow(row: DispatchSubjectRow): DispatchWithSubject {
  return {
    ...fromRow(row),
    ...deriveSubjectFields({
      type: row.event_type,
      subject_kind: row.subject_kind,
      subject_ref: row.subject_ref,
      payload: row.event_payload,
    }),
  };
}

/**
 * Insert a new dispatch and return the stored record. `status` defaults to
 * `queued` and `attempts` to 0; the lease/contract/error columns fall back to
 * null. Timestamps are set to the current time.
 */
export async function createDispatch(
  dispatch: NewDispatch,
  db: Knex = getDb()
): Promise<DispatchRecord> {
  const now = Date.now();
  const [row] = await db<DispatchRow>("dispatches")
    .insert({
      event_id: dispatch.event_id,
      rule_id: dispatch.rule_id ?? null,
      playbook_id: dispatch.playbook_id,
      status: dispatch.status ?? "queued",
      lease_id: dispatch.lease_id ?? null,
      wisp_contract_id: dispatch.wisp_contract_id ?? null,
      attempts: dispatch.attempts ?? 0,
      error: dispatch.error ?? null,
      released_at: dispatch.released_at ?? null,
      release_pending: dispatch.release_pending ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .returning("*");
  // Signal the live SPA that the dispatch set changed. Every dispatch mutation
  // funnels through this repo, so publishing here catches all call sites
  // (dispatcher/executor/retry/reconcile); coalescing collapses the burst.
  publishChange("dispatches");
  return fromRow(row);
}

/** Fetch a single dispatch by id, or `undefined` if none exists. */
export async function getDispatch(
  id: number,
  db: Knex = getDb()
): Promise<DispatchRecord | undefined> {
  const row = await db<DispatchRow>("dispatches").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/**
 * List dispatches newest-first (`created_at` DESC, `id` DESC to break ties).
 * Pass `status` to filter to a single lifecycle state.
 */
export async function listDispatches(
  status?: DispatchStatus,
  db: Knex = getDb()
): Promise<DispatchRecord[]> {
  let query = db<DispatchRow>("dispatches")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc");
  if (status !== undefined) query = query.where({ status });
  const rows = await query;
  return rows.map(fromRow);
}

/**
 * Fetch a single dispatch by id with its triggering event's generic subject
 * fields joined in, or `undefined` if none exists. Additive superset of
 * {@link getDispatch}; backs the dispatch/run detail responses.
 */
export async function getDispatchWithSubject(
  id: number,
  db: Knex = getDb()
): Promise<DispatchWithSubject | undefined> {
  const row = await db<DispatchSubjectRow>("dispatches")
    .leftJoin("events", "dispatches.event_id", "events.id")
    .select(...DISPATCH_SUBJECT_COLUMNS)
    .where("dispatches.id", id)
    .first();
  return row ? fromSubjectRow(row) : undefined;
}

/** Filters for {@link listDispatchesWithSubject}. */
export interface DispatchListFilter {
  /** Restrict to a single lifecycle state. */
  status?: DispatchStatus;
  /**
   * Restrict to the non-terminal ({@link ACTIVE_DISPATCH_STATUSES}) states — the
   * Queue view's filter. Combines with `status` (both are applied), though the
   * two are used independently in practice.
   */
  active?: boolean;
  /**
   * Free-text search: whitespace-separated terms ANDed across the dispatch
   * status/error, the triggering event's subject fields (kind/ref/type/title),
   * and the playbook name. Empty = no filter; composes with the other filters.
   */
  q?: string;
}

/**
 * The searchable expressions for a subject-joined dispatch `q` filter: the
 * dispatch's own text, its event's subject columns, its event type, the
 * `title` read generically out of the event payload JSON, and the playbook's
 * name (from the join added only when searching). These are trusted, hard-coded
 * SQL expressions — the user's terms flow only through bound patterns.
 */
const DISPATCH_SEARCH_EXPRESSIONS = [
  "dispatches.status",
  "dispatches.error",
  "events.subject_kind",
  "events.subject_ref",
  "events.type",
  "json_extract(events.payload, '$.title')",
  "playbooks.name",
] as const;

/**
 * List dispatches newest-first (`created_at` DESC, `id` DESC to break ties),
 * optionally filtered, with each row's triggering-event subject fields joined
 * in. Additive superset of {@link listDispatches}; backs the dispatch list /
 * Queue view so a waiting dispatch is identifiable by its subject. Pass
 * `active: true` to return only the non-terminal (queued/leasing/running/
 * collecting) work the Queue shows; the terminal history lives on the Runs page.
 */
export async function listDispatchesWithSubject(
  filter: DispatchListFilter = {},
  db: Knex = getDb()
): Promise<DispatchWithSubject[]> {
  let query = db<DispatchSubjectRow>("dispatches")
    .leftJoin("events", "dispatches.event_id", "events.id")
    .select(...DISPATCH_SUBJECT_COLUMNS)
    .orderBy("dispatches.created_at", "desc")
    .orderBy("dispatches.id", "desc");
  if (filter.status !== undefined) {
    query = query.where("dispatches.status", filter.status);
  }
  if (filter.active) {
    query = query.whereIn("dispatches.status", [...ACTIVE_DISPATCH_STATUSES]);
  }
  if (searchTerms(filter.q).length > 0) {
    // Join the playbook only when searching by name; the FK is unique so this
    // adds no rows (a deleted playbook LEFT-JOINs to a null name). No columns
    // are selected from it, so the response shape is unchanged.
    query = query.leftJoin("playbooks", "dispatches.playbook_id", "playbooks.id");
    query = applySearchFilter(query, filter.q, DISPATCH_SEARCH_EXPRESSIONS);
  }
  const rows = await query;
  return rows.map(fromSubjectRow);
}

/**
 * Count dispatches whose `created_at` is at or after `sinceMs`. Used to enforce
 * the trailing-window rate cap on dispatch creation.
 */
export async function countDispatchesCreatedSince(
  sinceMs: number,
  db: Knex = getDb()
): Promise<number> {
  const row = await db<DispatchRow>("dispatches")
    .where("created_at", ">=", sinceMs)
    .count<{ n: number }>({ n: "*" })
    .first();
  return Number(row?.n ?? 0);
}

/**
 * Atomically claim the oldest `queued` dispatch, flipping it to `leasing`, and
 * return it — or `null` when the queue is empty.
 *
 * The select-oldest and the status flip run inside a single transaction, so
 * concurrent callers can never claim the same row and rows are always handed
 * out strictly oldest-first (FIFO). The conditional `WHERE status = 'queued'`
 * on the UPDATE is the actual guard: if a racing claim grabbed the row first,
 * the UPDATE matches nothing and we retry with the next-oldest. better-sqlite3
 * runs on a single connection, so the transaction fully serializes writers.
 */
export async function claimNextQueuedDispatch(
  db: Knex = getDb()
): Promise<DispatchRecord | null> {
  return db.transaction(async (trx) => {
    // Loop to tolerate a lost race on the conditional UPDATE, though on a
    // single-connection sqlite the transaction already serializes claimers.
    for (;;) {
      const oldest = await trx<DispatchRow>("dispatches")
        .where({ status: "queued" })
        .orderBy("id", "asc")
        .first();
      if (!oldest) return null;
      const count = await trx<DispatchRow>("dispatches")
        .where({ id: oldest.id, status: "queued" })
        .update({ status: "leasing", updated_at: Date.now() });
      if (count === 0) continue;
      const claimed = await trx<DispatchRow>("dispatches")
        .where({ id: oldest.id })
        .first();
      // The claim flipped queued -> leasing: a status transition to broadcast.
      if (claimed) publishChange("dispatches");
      return claimed ? fromRow(claimed) : null;
    }
  });
}

/**
 * Apply a partial update to a dispatch, bumping `updated_at`. Every field —
 * including the nullable lease/contract/error columns — is written when present
 * in the patch, so a field can be explicitly cleared by passing `null`. Returns
 * the updated record, or `undefined` if no dispatch with `id` exists.
 */
export async function updateDispatch(
  id: number,
  patch: DispatchUpdate,
  db: Knex = getDb()
): Promise<DispatchRecord | undefined> {
  const changes: Partial<DispatchRow> = { updated_at: Date.now() };
  if (patch.status !== undefined) changes.status = patch.status;
  if ("lease_id" in patch) changes.lease_id = patch.lease_id ?? null;
  if ("wisp_contract_id" in patch) {
    changes.wisp_contract_id = patch.wisp_contract_id ?? null;
  }
  if (patch.attempts !== undefined) changes.attempts = patch.attempts;
  if ("error" in patch) changes.error = patch.error ?? null;
  if ("released_at" in patch) changes.released_at = patch.released_at ?? null;
  if (patch.release_pending !== undefined) {
    changes.release_pending = patch.release_pending ? 1 : 0;
  }
  const count = await db<DispatchRow>("dispatches").where({ id }).update(changes);
  if (count === 0) return undefined;
  publishChange("dispatches");
  return getDispatch(id, db);
}

/**
 * Return a dispatch to the `queued` state so it can be reclaimed — used to
 * retry after a transient failure. Clears the stale lease/contract handles and
 * bumps `updated_at`. Returns the updated record, or `undefined` if no dispatch
 * with `id` exists.
 */
export async function resetToQueued(
  id: number,
  db: Knex = getDb()
): Promise<DispatchRecord | undefined> {
  const count = await db<DispatchRow>("dispatches").where({ id }).update({
    status: "queued",
    lease_id: null,
    wisp_contract_id: null,
    updated_at: Date.now(),
  });
  if (count === 0) return undefined;
  publishChange("dispatches");
  return getDispatch(id, db);
}

/**
 * List dispatches whose lease is still owed to wisper — a non-null `lease_id`
 * with `released_at` still null — regardless of the dispatch's lifecycle state.
 * Terminal (done/failed) rows are included by design: a successful run whose
 * release DELETE failed strands a real lease on the host, and the sweep must
 * keep retrying it until wisper acknowledges.
 */
export async function listDispatchesWithPendingRelease(
  db: Knex = getDb()
): Promise<DispatchRecord[]> {
  const rows = await db<DispatchRow>("dispatches")
    .whereNotNull("lease_id")
    .whereNull("released_at")
    .orderBy("id", "asc");
  return rows.map(fromRow);
}

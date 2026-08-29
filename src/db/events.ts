import type { Knex } from "knex";

import type {
  EventRecord,
  EventSubjectFields,
  ListEventsOptions,
  NewEvent,
} from "../interfaces";

import { getDb } from "./db";
import { applySearchFilter } from "./search";

/** Raw row shape as stored on disk: payload is JSON-encoded TEXT. */
interface EventRow {
  id: number;
  source: string;
  type: string;
  subject_kind: string;
  subject_ref: string;
  payload: string;
  dedupe_key: string | null;
  ts: number;
  last_dispatched_at: number | null;
  cleared_at: number | null;
}

/**
 * The raw event columns needed to derive {@link EventSubjectFields}. Typed with
 * nullable columns because a LEFT JOIN with no matching event yields nulls; the
 * `payload` is the on-disk JSON-encoded TEXT (or SQL NULL when unjoined).
 */
export interface EventSubjectSource {
  type: string | null;
  subject_kind: string | null;
  subject_ref: string | null;
  payload: string | null;
}

/** Read a string-valued key off an opaque parsed payload, else null. */
function payloadString(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Derive the generic {@link EventSubjectFields} from an event's raw columns.
 * `subject_kind`/`subject_ref`/`event_type` are copied straight off the event.
 * `subject_title`/`subject_url` are read GENERICALLY from the opaque payload —
 * `payload.title`/`payload.url` when each happens to be a string, else null;
 * the payload is never assumed to have a shape. A missing `source` (no event
 * joined) yields an all-null block. No value is ever branched on.
 */
export function deriveSubjectFields(
  source: EventSubjectSource | undefined | null
): EventSubjectFields {
  if (!source) {
    return {
      subject_kind: null,
      subject_ref: null,
      event_type: null,
      subject_title: null,
      subject_url: null,
      subject_type: null,
    };
  }
  const payload =
    source.payload === null || source.payload === undefined
      ? null
      : JSON.parse(source.payload);
  return {
    subject_kind: source.subject_kind,
    subject_ref: source.subject_ref,
    event_type: source.type,
    subject_title: payloadString(payload, "title"),
    subject_url: payloadString(payload, "url"),
    subject_type: payloadString(payload, "work_item_type"),
  };
}

/** Decode an on-disk row into a typed {@link EventRecord} with parsed payload. */
function fromRow(row: EventRow): EventRecord {
  return {
    id: row.id,
    source: row.source,
    type: row.type,
    subject_kind: row.subject_kind,
    subject_ref: row.subject_ref,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    dedupe_key: row.dedupe_key,
    ts: row.ts,
    last_dispatched_at: row.last_dispatched_at,
    cleared_at: row.cleared_at,
  };
}

/**
 * Insert a new event and return the stored record. `ts` defaults to the current
 * time; `payload` is JSON-serialized; lifecycle columns start null.
 */
export async function insertEvent(
  event: NewEvent,
  db: Knex = getDb()
): Promise<EventRecord> {
  const ts = event.ts ?? Date.now();
  const [row] = await db<EventRow>("events")
    .insert({
      source: event.source,
      type: event.type,
      subject_kind: event.subject_kind,
      subject_ref: event.subject_ref,
      payload: JSON.stringify(event.payload ?? null),
      dedupe_key: event.dedupe_key ?? null,
      ts,
      last_dispatched_at: null,
      cleared_at: null,
    })
    .returning("*");
  return fromRow(row);
}

/**
 * Stamp `last_dispatched_at` on an event, recording that at least one dispatch
 * was created for it. Returns true when a row was updated.
 */
export async function markEventDispatched(
  id: number,
  at: number,
  db: Knex = getDb()
): Promise<boolean> {
  const count = await db<EventRow>("events")
    .where({ id })
    .update({ last_dispatched_at: at });
  return count > 0;
}

/** Fetch a single event by id, or `undefined` if none exists. */
export async function getEventById(
  id: number,
  db: Knex = getDb()
): Promise<EventRecord | undefined> {
  const row = await db<EventRow>("events").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/**
 * Return the most recent un-cleared event sharing `dedupe_key`, or `undefined`
 * if none exists. Used by the manual-mint endpoint to surface the existing row
 * a cooldown suppression collapsed into (the same row {@link emitEvent}'s
 * dedupe lookup consulted).
 */
export async function getLatestUnclearedEventByDedupeKey(
  dedupe_key: string,
  db: Knex = getDb()
): Promise<EventRecord | undefined> {
  const row = await db<EventRow>("events")
    .where({ dedupe_key })
    .whereNull("cleared_at")
    .orderBy("ts", "desc")
    .orderBy("id", "desc")
    .first();
  return row ? fromRow(row) : undefined;
}

/** The distinct facet values currently present in the events table. */
export interface EventFacets {
  /** Every distinct `source`, ascending. */
  sources: string[];
  /** Every distinct `type`, ascending. */
  types: string[];
}

/**
 * The distinct `source` and `type` values recorded so far, each sorted
 * ascending. Backs the facets endpoint that lets the UI suggest the values a
 * user would otherwise have to guess when filtering events or writing rules.
 * An empty table yields empty arrays.
 */
export async function getEventFacets(db: Knex = getDb()): Promise<EventFacets> {
  const sourceRows = await db<EventRow>("events")
    .distinct("source")
    .orderBy("source", "asc");
  const typeRows = await db<EventRow>("events")
    .distinct("type")
    .orderBy("type", "asc");
  return {
    sources: sourceRows.map((r) => r.source),
    types: typeRows.map((r) => r.type),
  };
}

/** The columns a `q` search scans on an event row; payload is raw JSON TEXT. */
const EVENT_SEARCH_COLUMNS = [
  "events.source",
  "events.type",
  "events.subject_kind",
  "events.subject_ref",
  "events.payload",
] as const;

/**
 * List events newest-first. Pass `cursor` (an event id) to page: only events
 * with an id strictly less than the cursor are returned. `limit` defaults to 50.
 * `q` is a free-text filter (see {@link ListEventsOptions}); it composes with
 * the cursor so paging walks the FILTERED set.
 */
export async function listEvents(
  options: ListEventsOptions = {},
  db: Knex = getDb()
): Promise<EventRecord[]> {
  const limit = options.limit ?? 50;
  let query = db<EventRow>("events").orderBy("id", "desc").limit(limit);
  if (options.cursor !== undefined) {
    query = query.where("id", "<", options.cursor);
  }
  query = applySearchFilter(query, options.q, EVENT_SEARCH_COLUMNS);
  const rows = await query;
  return rows.map(fromRow);
}

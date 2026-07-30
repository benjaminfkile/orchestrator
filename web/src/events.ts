// Typed data-access helpers for the Events page. Wraps the generic `apiFetch`
// in a named, strongly-typed call so the page stays declarative and tests can
// mock this module wholesale. `GET /api/events` returns full event records
// newest-first, cursor-paginated by id via the `before` query parameter.

import { apiFetch } from "./api";

/** An event record as returned by `GET /api/events`. Mirrors the backend
 * `EventRecord`; `payload` is already parsed from its stored JSON. */
export interface EventRecord {
  id: number;
  source: string;
  type: string;
  subject_kind: string;
  subject_ref: string;
  payload: unknown;
  dedupe_key: string | null;
  ts: number;
  last_dispatched_at: number | null;
  cleared_at: number | null;
}

/** Pagination controls for {@link listEvents}. */
export interface ListEventsParams {
  /** Maximum number of events to return. The backend defaults to 50. */
  limit?: number;
  /** Return only events with an id strictly less than this cursor. */
  before?: number;
  /** Free-text search; each whitespace term must match (backend `q` param). */
  q?: string;
}

/**
 * List events newest-first. Pass `before` (the id of the oldest event already
 * loaded) to fetch the next page, and `q` to filter server-side (each whitespace
 * term must match somewhere in the event, ANDed). Results are ordered by id
 * descending.
 */
export function listEvents(params: ListEventsParams = {}): Promise<EventRecord[]> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.before !== undefined) query.set("before", String(params.before));
  if (params.q !== undefined && params.q.trim() !== "") query.set("q", params.q);
  const suffix = query.toString();
  return apiFetch<EventRecord[]>(`/events${suffix ? `?${suffix}` : ""}`);
}

/** Fetch a single event by id (`GET /api/events/:id`). Rejects with an
 * {@link ApiError} whose `status` is 404 when the event is absent. */
export function getEventById(id: number): Promise<EventRecord> {
  return apiFetch<EventRecord>(`/events/${id}`);
}

/** Distinct event `source`/`type` values, as returned by `GET /api/events/facets`.
 * Both arrays are sorted ascending and back the source/type pickers. */
export interface EventFacets {
  sources: string[];
  types: string[];
}

/** Fetch the distinct known event sources and types for the filter/rule pickers. */
export function getEventFacets(): Promise<EventFacets> {
  return apiFetch<EventFacets>("/events/facets");
}

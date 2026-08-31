// Typed data-access helpers for the Queue dashboard. These wrap the generic
// `apiFetch` in named, strongly-typed calls so pages stay declarative and tests
// can mock this module wholesale. The dispatch list endpoint returns raw
// records keyed by `event_id`/`playbook_id`; the Queue page joins those against
// the events and playbooks lists (also fetched here) to show human-readable
// event types and playbook names.

import { API_BASE, ApiError, apiFetch } from "./api";

/**
 * Lifecycle states of a dispatch, mirrored from the backend `DispatchStatus`
 * union. Order matters: it drives the tile row and the filter dropdown.
 * `cancelled` is a terminal state reached only via
 * `POST /api/dispatches/:id/cancel`. Like `failed`, it is retryable and
 * belongs to the Runs history, not the Queue.
 */
export const DISPATCH_STATUSES = [
  "queued",
  "leasing",
  "running",
  "collecting",
  "done",
  "failed",
  "cancelled",
] as const;

export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/**
 * The non-terminal lifecycle states — a dispatch still waiting or in flight.
 * These are exactly the statuses the Queue page shows; the terminal
 * `done`/`failed` pair belongs to the Runs history. Mirrors the backend's
 * `ACTIVE_DISPATCH_STATUSES`.
 */
export const ACTIVE_DISPATCH_STATUSES = [
  "queued",
  "leasing",
  "running",
  "collecting",
] as const;

export type ActiveDispatchStatus = (typeof ACTIVE_DISPATCH_STATUSES)[number];

/**
 * The generic, domain-neutral display fields describing the SUBJECT that
 * triggered a run, surfaced additively by the backend wherever runs and
 * dispatches are read. `subject_kind`/`subject_ref`/`event_type` come straight
 * off the triggering event; `subject_title`/`subject_url`/`subject_type` are read
 * generically from its opaque payload (`payload.title`/`payload.url`/
 * `payload.work_item_type` when each is a string, else null). Every field is
 * nullable — no code branches on their values; they are display hints only.
 * `subject_type` is a presentation hint the {@link SubjectCell} maps to an icon.
 */
export interface SubjectFields {
  subject_kind: string | null;
  subject_ref: string | null;
  event_type: string | null;
  subject_title: string | null;
  subject_url: string | null;
  subject_type: string | null;
}

/**
 * The reason a queued dispatch is being HELD by the optional run-budget gate,
 * attached additively by the backend to each queued dispatch while the gate is
 * holding. Absent on any dispatch merely awaiting the next dispatcher tick, and
 * absent entirely when no budget is configured — so a queued dispatch carrying a
 * `waiting_reason` is one the budget is actively deferring.
 */
export interface WaitingReason {
  waiting_reason: "budget";
  /** Runs started within the trailing budget window right now. */
  window_count: number;
  /** The run-count budget, or null when only the token breaker is active. */
  budget: number | null;
  /** When the oldest in-window run ages out — the soonest a claim could succeed. */
  next_eligible_at: number | null;
  /** True when the token circuit breaker (not the run count) tripped. */
  token_breaker?: boolean;
  /** The token budget, present only when the token breaker tripped. */
  token_budget?: number;
  /** The summed in-window usage tokens, present only when the token breaker tripped. */
  window_tokens?: number;
}

/**
 * A dispatch row as returned by `GET /api/dispatches`. The {@link WaitingReason}
 * fields are present only on a queued dispatch the run-budget gate is holding.
 * The {@link SubjectFields} are present on the list/detail responses but not on
 * the retry response (which echoes the bare updated record), so they are
 * optional here.
 */
export interface Dispatch extends Partial<WaitingReason>, Partial<SubjectFields> {
  id: number;
  event_id: number;
  rule_id: number | null;
  playbook_id: number;
  status: DispatchStatus;
  lease_id: string | null;
  wisp_contract_id: string | null;
  attempts: number;
  error: string | null;
  released_at: number | null;
  release_pending: boolean;
  created_at: number;
  updated_at: number;
}

/** The slice of an event the Queue page needs to label a dispatch. */
export interface EventSummary {
  id: number;
  type: string;
}

/**
 * Summed token counts recorded for a run. Mirrors the executor's `UsageTotals`;
 * every field is optional so a partial or legacy usage blob still renders. The
 * index signature lets the detail page surface any extra counters verbatim.
 */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: number | undefined;
}

/** A finding produced by a run, as embedded in the dispatch detail response. */
export interface Finding {
  id: number;
  run_id: number;
  content: string;
  tags: string[];
  visibility: string;
}

/**
 * One execution attempt of a dispatch, with its findings embedded. `usage` is
 * already parsed from its stored JSON; the completion columns are null until the
 * run ends.
 */
export interface Run {
  id: number;
  dispatch_id: number;
  exit_code: number | null;
  result_text: string | null;
  usage: TokenUsage | null;
  collected: Record<string, string> | null;
  log_path: string | null;
  started_at: number;
  ended_at: number | null;
  findings: Finding[];
}

/** A dispatch plus every run it has produced (retries add rows), each with its
 * own findings — the shape of `GET /api/dispatches/:id`. */
export interface DispatchDetail extends Dispatch {
  runs: Run[];
}

/** The slice of an event the Runs detail page shows in its trigger card. */
export interface EventDetail {
  id: number;
  source: string;
  type: string;
  subject_kind: string;
  subject_ref: string;
  payload: unknown;
  ts: number;
}

/** The slice of a playbook the Runs detail page shows in its summary card. */
export interface PlaybookDetail {
  id: number;
  name: string;
  image: string;
  runner: string;
  output_kind: string;
}

/** The slice of a playbook the Queue page needs to label a dispatch. */
export interface PlaybookSummary {
  id: number;
  name: string;
}

/**
 * One row of the run-history list from `GET /api/runs`: a dispatch (the unit of
 * a run) with its latest run's outcome left-joined in. Dispatches that failed
 * before producing a run still appear, with the run-derived fields
 * (`duration_ms`, `exit_code`, `total_tokens`) null and `findings_count` 0. The
 * Runs page joins the playbook name separately, mirroring the Queue page. Each
 * row also carries the {@link SubjectFields} tracing it to its triggering event.
 */
export interface RunHistoryEntry extends SubjectFields {
  dispatch_id: number;
  playbook_id: number;
  status: DispatchStatus;
  created_at: number;
  /** Run's `ended_at` when a run exists, else the dispatch's `updated_at`. */
  ended_at: number;
  /** `ended_at - started_at` when a run exists, else null. */
  duration_ms: number | null;
  exit_code: number | null;
  /** Sum of the run's usage token fields when present, else null. */
  total_tokens: number | null;
  findings_count: number;
  error: string | null;
}

/**
 * List dispatches, newest-first (ordered by the backend). Pass `status` to
 * filter to a single lifecycle state, or `active: true` to return only the
 * non-terminal (queued/leasing/running/collecting) work — the filter the Queue
 * page uses so it never shows terminal history.
 */
export function listDispatches(opts?: {
  status?: DispatchStatus;
  active?: boolean;
  /** Free-text search; each whitespace term must match (backend `q` param). */
  q?: string;
}): Promise<Dispatch[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.active) params.set("active", "1");
  if (opts?.q && opts.q.trim() !== "") params.set("q", opts.q);
  const query = params.toString();
  return apiFetch<Dispatch[]>(`/dispatches${query ? `?${query}` : ""}`);
}

/**
 * Requeue a failed or cancelled dispatch. Resolves to the updated record (now
 * `queued` with attempts reset); rejects with an `ApiError` (409) if the
 * dispatch is not in the `failed` or `cancelled` state.
 */
export function retryDispatch(id: number): Promise<Dispatch> {
  return apiFetch<Dispatch>(`/dispatches/${id}/retry`, { method: "POST" });
}

/**
 * Cancel a non-terminal dispatch. A queued dispatch is marked `cancelled`
 * directly and the response carries the updated row; an in-flight dispatch is
 * aborted through the dispatcher's per-dispatch signal and the response
 * carries the CURRENT row (still e.g. `running`); the caller polls the
 * dispatch record to see it flip to `cancelled`. Rejects with an `ApiError`
 * (409) when the dispatch is already terminal (done/failed/cancelled).
 */
export function cancelDispatch(id: number): Promise<Dispatch> {
  return apiFetch<Dispatch>(`/dispatches/${id}/cancel`, { method: "POST" });
}

/**
 * Manually queue an existing playbook against an existing event, creating a
 * rule-less dispatch (no rule matching). Resolves to the created record (with
 * subject fields joined in); rejects with an `ApiError` (404) if either the
 * event or the playbook is unknown.
 */
export function createDispatch(
  eventId: number,
  playbookId: number,
): Promise<Dispatch> {
  return apiFetch<Dispatch>(`/dispatches`, {
    method: "POST",
    body: { event_id: eventId, playbook_id: playbookId },
  });
}

/**
 * Re-run a dispatch: create a fresh, rule-less dispatch of the SAME playbook
 * against the SAME triggering event. The event/playbook ids are resolved from
 * the dispatch record first (run-history rows don't carry the event id), so this
 * works from any surface that knows only a dispatch id. Resolves to the newly
 * created dispatch; rejects with an `ApiError` if the dispatch, its event, or its
 * playbook is unknown.
 */
export async function rerunDispatch(dispatchId: number): Promise<Dispatch> {
  const detail = await getDispatch(dispatchId);
  return createDispatch(detail.event_id, detail.playbook_id);
}

/** Fetch the recent events used to resolve each dispatch's event type. */
export function listEvents(): Promise<EventSummary[]> {
  return apiFetch<EventSummary[]>(`/events?limit=500`);
}

/** Fetch all playbooks used to resolve each dispatch's playbook name. */
export function listPlaybooks(): Promise<PlaybookSummary[]> {
  return apiFetch<PlaybookSummary[]>(`/playbooks`);
}

/**
 * List run history, one row per dispatch, newest first. Optionally filtered to a
 * single dispatch status and/or a free-text `q` (each whitespace term must match
 * somewhere in the row, ANDed); the backend orders and (optionally) caps the rows.
 */
export function listRuns(opts?: {
  status?: DispatchStatus;
  q?: string;
}): Promise<RunHistoryEntry[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.q && opts.q.trim() !== "") params.set("q", opts.q);
  const query = params.toString();
  return apiFetch<RunHistoryEntry[]>(`/runs${query ? `?${query}` : ""}`);
}

/**
 * Fetch a single dispatch with its runs (each with findings) embedded — the one
 * request the Runs detail page needs to render its timeline and result panels.
 * Rejects with an `ApiError` (404) when the dispatch does not exist.
 */
export function getDispatch(id: number): Promise<DispatchDetail> {
  return apiFetch<DispatchDetail>(`/dispatches/${id}`);
}

/** Fetch the event that triggered a dispatch, for the trigger summary card. */
export function getEvent(id: number): Promise<EventDetail> {
  return apiFetch<EventDetail>(`/events/${id}`);
}

/** Fetch the playbook a dispatch runs, for the playbook summary card. */
export function getPlaybook(id: number): Promise<PlaybookDetail> {
  return apiFetch<PlaybookDetail>(`/playbooks/${id}`);
}

/** Callbacks and controls for {@link streamDispatchLog}. */
export interface StreamLogOptions {
  /** Invoked with each decoded text chunk as it arrives on the wire. */
  onChunk: (text: string) => void;
  /** Aborts the underlying request when signalled (e.g. on unmount). */
  signal?: AbortSignal;
}

/**
 * Stream a dispatch's log file. `GET /api/dispatches/:id/log` is a chunked
 * `text/plain` response that emits the current file contents, then appended
 * bytes, until the dispatch reaches a terminal status or the client
 * disconnects. Each decoded chunk is handed to `onChunk`; the returned promise
 * resolves when the stream closes normally.
 *
 * Rejects with an `ApiError` on a non-2xx status (notably 404 before the log
 * file exists) and re-throws an `AbortError` when the caller aborts, so callers
 * can distinguish cancellation from a real failure.
 */
export async function streamDispatchLog(
  id: number,
  opts: StreamLogOptions,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/dispatches/${id}/log`, {
      signal: opts.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(message, 0);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* leave body as raw text */
    }
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `log stream failed with status ${res.status}`;
    throw new ApiError(message, res.status, body);
  }

  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        if (text) opts.onChunk(text);
      }
    }
    const tail = decoder.decode();
    if (tail) opts.onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}

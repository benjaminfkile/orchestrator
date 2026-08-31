/**
 * Run-lifecycle callback events.
 *
 * The dispatcher feeds two kinds of generic events back into the orchestrator's
 * own pipeline ({@link emitEvent}) so user-configured rules can react to a
 * dispatch's lifecycle: {@link emitRunStartedEvent} fires once when a claimed
 * dispatch begins executing, and {@link emitRunEvent} fires once when it reaches
 * a TERMINAL state (`done`/`failed`). Both are callbacks built entirely from
 * existing machinery — no new tables and no new transport.
 *
 * Per the architecture principle this module is domain-neutral: `run.started`,
 * `run.completed`, and `run.failed` are pipeline-stage strings describing the
 * dispatch's lifecycle, never a branch on user intent. All meaning lives in the
 * rules a user writes against these event types.
 *
 * Chain safety: each emitted event carries a `chain_depth` one greater than the
 * originating event's, and the intake's `dispatch_max_chain_depth` gate refuses
 * to create dispatches once that depth reaches the cap — so a rule that reacts to
 * a run by dispatching another run cannot loop forever.
 */

import type { Knex } from "knex";

import { getDb } from "../db/db";
import { getEventById } from "../db/events";
import { listFindings } from "../db/findings";
import { getPlaybook } from "../db/playbooks";
import { listRuns, sumUsageTokens } from "../db/runs";
import type { DispatchRecord } from "../interfaces";
import { log, type Logger } from "../log";

import { emitEvent, type Kickable } from "./eventIntake";

/** Event `source` every run-lifecycle callback is recorded under. */
export const RUN_EVENT_SOURCE = "orchestrator";
/** Event `type` emitted when a claimed dispatch begins executing. */
export const RUN_STARTED_TYPE = "run.started";
/** Event `type` emitted when a dispatch finishes successfully. */
export const RUN_COMPLETED_TYPE = "run.completed";
/** Event `type` emitted when a dispatch fails terminally (no retry pending). */
export const RUN_FAILED_TYPE = "run.failed";
/**
 * Event `type` emitted when a dispatch ends via operator cancel: either the
 * queued-cancel fast path in the router or the in-flight cancel driven through
 * the executor's abort seam. Distinct from {@link RUN_FAILED_TYPE} so a rule
 * can act on user aborts specifically (e.g. skip a "run failed" notifier).
 */
export const RUN_CANCELLED_TYPE = "run.cancelled";

/** Injected collaborators for {@link emitRunEvent}. */
export interface EmitRunEventDeps {
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /**
   * Dispatcher woken once the callback event enqueues a chained dispatch. Passing
   * the running dispatcher here lets a chained playbook start promptly rather than
   * waiting for the safety interval.
   */
  dispatcher?: Kickable;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
}

/**
 * Read a finite numeric `chain_depth` off an event's opaque payload, else null.
 * The payload is never assumed to have a shape — a non-object payload, a missing
 * key, or a non-finite value all yield null.
 */
function readChainDepth(payload: unknown): number | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).chain_depth;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build and emit the run-lifecycle callback event for a dispatch that has reached
 * its terminal state.
 *
 * `status` is the terminal dispatch status: `done` → a `run.completed` event,
 * `failed` → a `run.failed` event, `cancelled` → a `run.cancelled` event. The
 * event copies the originating event's `subject_kind`/`subject_ref`, carries a
 * null `dedupe_key`, and its payload summarizes the run (latest run id,
 * findings, collected output, token/duration totals) alongside the `origin` of
 * the triggering event and the incremented `chain_depth`.
 *
 * The event is emitted through the normal intake ({@link emitEvent}) so rules
 * match it and any resulting dispatch is enqueued and the dispatcher kicked — but
 * the caller is responsible for NOT invoking this for a failure that is about to
 * be retried. This function may throw (a DB read failure, say); the dispatcher
 * wraps the call so an emit failure never breaks the drain loop.
 */
export async function emitRunEvent(
  dispatch: DispatchRecord,
  status: "done" | "failed" | "cancelled",
  deps: EmitRunEventDeps = {}
): Promise<void> {
  const db = deps.db ?? getDb();
  const logger = deps.logger ?? log;

  const event = await getEventById(dispatch.event_id, db);
  if (!event) {
    // The originating event is the source of the subject and origin block; with
    // it gone there is nothing meaningful to emit. This is not expected (events
    // are never deleted), so surface it and skip rather than emit a hollow event.
    logger.warn("skipping run event: originating event not found", {
      dispatchId: dispatch.id,
      eventId: dispatch.event_id,
    });
    return;
  }

  const playbook = await getPlaybook(dispatch.playbook_id, db);

  // The latest run for this dispatch (retries append rows; listRuns returns
  // newest-first, so the head is newest), or null when the dispatch failed
  // before any run opened.
  const runs = await listRuns(dispatch.id, db);
  const run = runs.length > 0 ? runs[0] : null;

  let findings: { content: string; tags: string[] }[] = [];
  if (run) {
    const rows = await listFindings(run.id, db);
    findings = rows.map((f) => ({ content: f.content, tags: f.tags }));
  }

  const durationMs =
    run && run.ended_at !== null ? run.ended_at - run.started_at : null;

  const originDepth = readChainDepth(event.payload) ?? 0;

  const type =
    status === "done"
      ? RUN_COMPLETED_TYPE
      : status === "cancelled"
        ? RUN_CANCELLED_TYPE
        : RUN_FAILED_TYPE;

  const payload = {
    dispatch_id: dispatch.id,
    run_id: run ? run.id : null,
    playbook_id: dispatch.playbook_id,
    playbook_name: playbook ? playbook.name : null,
    rule_id: dispatch.rule_id,
    status,
    exit_code: run ? run.exit_code : null,
    error: dispatch.error,
    findings,
    findings_count: findings.length,
    collected: run ? run.collected : null,
    duration_ms: durationMs,
    total_tokens: run ? sumUsageTokens(run.usage) : null,
    origin: {
      event_id: event.id,
      source: event.source,
      type: event.type,
      subject_kind: event.subject_kind,
      subject_ref: event.subject_ref,
    },
    chain_depth: originDepth + 1,
  };

  await emitEvent(
    {
      source: RUN_EVENT_SOURCE,
      type,
      subject_kind: event.subject_kind,
      subject_ref: event.subject_ref,
      dedupe_key: null,
      payload,
    },
    db,
    { dispatcher: deps.dispatcher, logger }
  );
}

/**
 * Build and emit the run-lifecycle callback event for a dispatch that has just
 * begun executing (the dispatcher has claimed the row and it has transitioned
 * out of `queued`). Produces a `run.started` event whose payload MIRRORS
 * {@link emitRunEvent}'s shape minus the terminal-only fields (no `status`,
 * `exit_code`, `error`, `findings`/`findings_count`, `collected`, `duration_ms`,
 * `total_tokens`) and with no `run_id` — a run row is only created on success,
 * so nothing exists to reference at start time.
 *
 * The event copies the originating event's `subject_kind`/`subject_ref`, carries
 * a null `dedupe_key`, and its `chain_depth` is incremented from the origin's
 * so the intake's `dispatch_max_chain_depth` gate treats a rule matching
 * `run.started` exactly like one matching `run.completed`/`run.failed` — a rule
 * that dispatches on `run.started` cannot loop forever.
 *
 * The event is emitted through the normal intake ({@link emitEvent}) so rules
 * match it and any resulting dispatch is enqueued and the dispatcher kicked.
 * A caller MUST wrap this so an emit failure never breaks the drain loop; a
 * missing playbook row degrades to `playbook_name: null` (never fatal).
 */
export async function emitRunStartedEvent(
  dispatch: DispatchRecord,
  deps: EmitRunEventDeps = {}
): Promise<void> {
  const db = deps.db ?? getDb();
  const logger = deps.logger ?? log;

  const event = await getEventById(dispatch.event_id, db);
  if (!event) {
    // The originating event is the source of the subject and origin block; with
    // it gone there is nothing meaningful to emit. This is not expected (events
    // are never deleted), so surface it and skip rather than emit a hollow event.
    logger.warn("skipping run.started event: originating event not found", {
      dispatchId: dispatch.id,
      eventId: dispatch.event_id,
    });
    return;
  }

  const playbook = await getPlaybook(dispatch.playbook_id, db);
  const originDepth = readChainDepth(event.payload) ?? 0;

  const payload = {
    dispatch_id: dispatch.id,
    playbook_id: dispatch.playbook_id,
    playbook_name: playbook ? playbook.name : null,
    rule_id: dispatch.rule_id,
    origin: {
      event_id: event.id,
      source: event.source,
      type: event.type,
      subject_kind: event.subject_kind,
      subject_ref: event.subject_ref,
    },
    chain_depth: originDepth + 1,
  };

  await emitEvent(
    {
      source: RUN_EVENT_SOURCE,
      type: RUN_STARTED_TYPE,
      subject_kind: event.subject_kind,
      subject_ref: event.subject_ref,
      dedupe_key: null,
      payload,
    },
    db,
    { dispatcher: deps.dispatcher, logger }
  );
}

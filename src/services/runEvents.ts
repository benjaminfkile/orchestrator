/**
 * Run-lifecycle callback events.
 *
 * When a dispatch reaches a TERMINAL state the dispatcher calls {@link emitRunEvent}
 * to feed a generic event back into the orchestrator's own pipeline
 * ({@link emitEvent}), so user-configured rules can react to a run's outcome and
 * dispatch further playbooks. This is a callback mechanism built entirely from
 * existing machinery — it introduces no new tables and no new transport.
 *
 * Per the architecture principle this module is domain-neutral: `run.completed`
 * and `run.failed` are pipeline-stage strings describing the dispatch's terminal
 * status, never a branch on user intent. All meaning lives in the rules a user
 * writes against these event types.
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
/** Event `type` emitted when a dispatch finishes successfully. */
export const RUN_COMPLETED_TYPE = "run.completed";
/** Event `type` emitted when a dispatch fails terminally (no retry pending). */
export const RUN_FAILED_TYPE = "run.failed";

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
 * `failed` → a `run.failed` event. The event copies the originating event's
 * `subject_kind`/`subject_ref`, carries a null `dedupe_key`, and its payload
 * summarizes the run (latest run id, findings, collected output, token/duration
 * totals) alongside the `origin` of the triggering event and the incremented
 * `chain_depth`.
 *
 * The event is emitted through the normal intake ({@link emitEvent}) so rules
 * match it and any resulting dispatch is enqueued and the dispatcher kicked — but
 * the caller is responsible for NOT invoking this for a failure that is about to
 * be retried. This function may throw (a DB read failure, say); the dispatcher
 * wraps the call so an emit failure never breaks the drain loop.
 */
export async function emitRunEvent(
  dispatch: DispatchRecord,
  status: "done" | "failed",
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

  const type = status === "done" ? RUN_COMPLETED_TYPE : RUN_FAILED_TYPE;

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

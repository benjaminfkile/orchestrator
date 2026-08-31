import fs from "fs";

import express from "express";

import {
  createDispatch,
  getDispatch,
  getDispatchWithSubject,
  listDispatchesWithSubject,
  updateDispatch,
} from "../db/dispatches";
import { getEventById } from "../db/events";
import { listFindings } from "../db/findings";
import { getPlaybook } from "../db/playbooks";
import { listRuns } from "../db/runs";
import type { DispatchRecord, DispatchStatus } from "../interfaces";
import { log } from "../log";
import { getRuntime } from "../runtime";
import { dispatchLogPath } from "../services/dispatchLog";
import { emitRunEvent } from "../services/runEvents";
import { evaluateRunBudget, type BudgetWait } from "../services/runBudget";

import { streamDispatchLog } from "./dispatchLogStream";
import {
  handler,
  HttpError,
  parseIdParam,
  parseSearchQuery,
  rejectUnknownKeys,
  requireBody,
  requireInt,
} from "./http";

/**
 * `/api/dispatches`: read the dispatch queue and retry/cancel work.
 *
 *   GET /               list, newest-first; `?status=` filters to one state,
 *                       `?active=1` filters to the non-terminal (queued/leasing/
 *                       running/collecting) work the Queue shows, `?q=` free-text
 *                       searches (status, error, subject fields, event type,
 *                       playbook name) — all compose
 *   GET /:id            one dispatch with its runs (each with findings) embedded
 *   GET /:id/log        tail the dispatch's log file as chunked text/plain:
 *                       current content, then appended bytes, until the dispatch
 *                       is done|failed|cancelled or the client disconnects; 404 if
 *                       the dispatch or its log file does not exist yet
 *   POST /               manually queue an existing playbook against an existing
 *                       event, creating a rule-less dispatch (no rule matching);
 *                       body `{event_id, playbook_id}`, 404 if either is unknown
 *   POST /:id/retry     requeue a `failed` OR `cancelled` dispatch, resetting
 *                       attempts, and kick the dispatcher; 409 otherwise
 *   POST /:id/cancel    abort a non-terminal dispatch: a queued row is marked
 *                       `cancelled` directly; an in-flight one is aborted through
 *                       the dispatcher's per-dispatch signal so its lease still
 *                       releases via the normal finally path. 409 when the
 *                       dispatch is already terminal (done/failed/cancelled)
 */
const dispatchesRouter = express.Router();

/** The only statuses a dispatch may hold — used to validate `?status=`. */
export const DISPATCH_STATUSES: readonly DispatchStatus[] = [
  "queued",
  "leasing",
  "running",
  "collecting",
  "done",
  "failed",
  "cancelled",
];

/**
 * The terminal dispatch statuses. `cancel` refuses any of these with 409, and
 * `retry` accepts only `failed`/`cancelled` (a `done` dispatch is retried by
 * re-running from scratch, which is a `POST /api/dispatches`: see the router
 * comment above and the web UI's Re-run action).
 */
const TERMINAL_DISPATCH_STATUSES: readonly DispatchStatus[] = [
  "done",
  "failed",
  "cancelled",
];

/**
 * Annotate the queued dispatches in `dispatches` with the budget hold, when one
 * is active. A queued dispatch held by the run-budget gate carries the
 * {@link BudgetWait} fields (`waiting_reason: "budget"`, `window_count`,
 * `budget`, `next_eligible_at`, …) so the UI can distinguish it from one merely
 * awaiting the next dispatcher tick; every other dispatch is returned untouched.
 *
 * The gate is evaluated at most once (only when at least one dispatch is
 * `queued`), and additively — the wire shape gains fields but loses none, so a
 * client that ignores them sees exactly today's response. When the gate is off
 * or not holding, nothing is added.
 */
async function withWaitingReason<T extends DispatchRecord>(
  dispatches: T[]
): Promise<(T | (T & BudgetWait))[]> {
  if (!dispatches.some((d) => d.status === "queued")) return dispatches;
  const hold = await evaluateRunBudget();
  if (!hold) return dispatches;
  return dispatches.map((d) => (d.status === "queued" ? { ...d, ...hold } : d));
}

/** Validate an optional `?status=` filter against the known statuses. */
export function parseStatusQuery(raw: unknown): DispatchStatus | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !DISPATCH_STATUSES.includes(raw as DispatchStatus)) {
    throw new HttpError(
      400,
      `status must be one of: ${DISPATCH_STATUSES.join(", ")}`
    );
  }
  return raw as DispatchStatus;
}

dispatchesRouter.get(
  "/",
  handler(async (req, res) => {
    const status = parseStatusQuery(req.query.status);
    // `?active=1` narrows the list to the non-terminal work the Queue shows;
    // absent, the full history is returned (the Runs page and other callers
    // depend on the unfiltered behavior).
    const active = req.query.active === "1";
    const q = parseSearchQuery(req.query.q);
    res
      .status(200)
      .json(
        await withWaitingReason(
          await listDispatchesWithSubject({ status, active, q })
        )
      );
  })
);

dispatchesRouter.get(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const dispatch = await getDispatchWithSubject(id);
    if (!dispatch) {
      res.status(404).json({ error: "dispatch not found" });
      return;
    }
    // Embed every run of this dispatch (retries add rows), each with its own
    // findings, so the detail view needs a single request.
    const runs = await listRuns(id);
    const runsWithFindings = await Promise.all(
      runs.map(async (run) => ({
        ...run,
        findings: await listFindings(run.id),
      }))
    );
    // Surface the budget hold on a queued dispatch (additive, same as the list).
    const [annotated] = await withWaitingReason([dispatch]);
    res.status(200).json({ ...annotated, runs: runsWithFindings });
  })
);

dispatchesRouter.get(
  "/:id/log",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const dispatch = await getDispatch(id);
    if (!dispatch) {
      res.status(404).json({ error: "dispatch not found" });
      return;
    }
    // Tail timings and the log base dir default to production values; tests
    // inject a temp base dir and small intervals through the runtime.
    const tail = getRuntime().logTail ?? {};
    const logPath = dispatchLogPath(id, tail.baseDir);
    if (!fs.existsSync(logPath)) {
      res.status(404).json({ error: "log not available" });
      return;
    }
    await streamDispatchLog(req, res, {
      id,
      logPath,
      pollIntervalMs: tail.pollIntervalMs ?? 500,
      statusIntervalMs: tail.statusIntervalMs ?? 2000,
    });
  })
);

dispatchesRouter.post(
  "/",
  handler(async (req, res) => {
    // Manually queue a playbook against an event with no originating rule. The
    // core stays domain-neutral: this deals only in opaque event/playbook ids —
    // no rule matching runs, so the pair is dispatched exactly as given.
    const body = requireBody(req.body);
    rejectUnknownKeys(body, ["event_id", "playbook_id"], "dispatch");
    const eventId = requireInt(body.event_id, "event_id", 1, Number.MAX_SAFE_INTEGER);
    const playbookId = requireInt(
      body.playbook_id,
      "playbook_id",
      1,
      Number.MAX_SAFE_INTEGER
    );

    if (!(await getEventById(eventId))) {
      throw new HttpError(404, "event not found");
    }
    if (!(await getPlaybook(playbookId))) {
      throw new HttpError(404, "playbook not found");
    }

    // Deliberately bypass the per-event dispatch cap (`dispatch_max_per_event`),
    // which only guards the automatic rule-intake path against a single event
    // fanning out into many dispatches; a manual creation is an explicit,
    // one-at-a-time act. The dispatch still lands as an ordinary row, so it stays
    // fully visible to budget accounting — the run-budget gate counts started
    // runs and the per-hour cap counts created rows regardless of origin.
    const created = await createDispatch({
      event_id: eventId,
      playbook_id: playbookId,
      rule_id: null,
      status: "queued",
      attempts: 0,
    });

    // Wake the dispatcher so the queued work is picked up promptly; a no-op when
    // leasing is unconfigured (no dispatcher wired).
    getRuntime().dispatcher?.kick();

    // Return the same shape the GET endpoints emit (subject fields joined in).
    res.status(201).json(await getDispatchWithSubject(created.id));
  })
);

dispatchesRouter.post(
  "/:id/retry",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const dispatch = await getDispatch(id);
    if (!dispatch) {
      res.status(404).json({ error: "dispatch not found" });
      return;
    }
    // A `cancelled` dispatch is retryable through the same path as a `failed`
    // one: it is terminal (no lease still owed while release_pending is
    // false), never auto-retried by the dispatcher's retry policy, and an
    // operator may explicitly requeue it here. A `done` dispatch is retried
    // by re-running from scratch (POST /api/dispatches).
    if (dispatch.status !== "failed" && dispatch.status !== "cancelled") {
      throw new HttpError(
        409,
        `only a failed or cancelled dispatch can be retried (status is ${dispatch.status})`
      );
    }
    // A failed dispatch still holding an UNRELEASED lease belongs to the
    // release sweep: requeueing it would null the lease handle and hide the
    // lease from the sweep's predicate (the exact leak resetToQueued and the
    // dispatcher's requeue guard were fixed to prevent). Refuse until the
    // sweep (or a manual release) resolves it — it runs every minute.
    if (dispatch.lease_id !== null && dispatch.released_at === null) {
      throw new HttpError(
        409,
        "this dispatch's lease release is still pending; the release sweep " +
          "must resolve it before a retry (typically within a minute)"
      );
    }
    // Return it to the head of its own history: queued, attempt counter reset,
    // stale lease/contract/error and release tracking cleared so it runs
    // fresh (a stale released_at from the prior attempt would hide the NEW
    // attempt's lease from the release sweep).
    const updated = await updateDispatch(id, {
      status: "queued",
      attempts: 0,
      lease_id: null,
      wisp_contract_id: null,
      released_at: null,
      release_pending: false,
      error: null,
    });
    // Wake the dispatcher so the requeued work is picked up promptly; it is a
    // no-op when leasing is unconfigured (no dispatcher wired).
    getRuntime().dispatcher?.kick();
    res.status(200).json(updated);
  })
);

dispatchesRouter.post(
  "/:id/cancel",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const dispatch = await getDispatch(id);
    if (!dispatch) {
      res.status(404).json({ error: "dispatch not found" });
      return;
    }
    if (TERMINAL_DISPATCH_STATUSES.includes(dispatch.status)) {
      throw new HttpError(
        409,
        `only a non-terminal dispatch can be cancelled (status is ${dispatch.status})`
      );
    }

    // A queued dispatch has never been claimed, so the executor has no
    // controller for it: just mark it `cancelled` directly and emit
    // `run.cancelled` from here. No lease is owed (no createLease has run),
    // so `release_pending` stays false and the sweep is not involved.
    if (dispatch.status === "queued") {
      const updated = await updateDispatch(id, {
        status: "cancelled",
        error: "cancelled",
      });
      // Fire `run.cancelled` so any rule matching cancellation reacts (the
      // executor is what emits terminal events for in-flight cancels, but a
      // queued cancel never enters the executor). Best-effort: an emission
      // failure must not fail the API call.
      if (updated) {
        try {
          await emitRunEvent(updated, "cancelled", {
            dispatcher: getRuntime().dispatcher,
          });
        } catch (err) {
          log.error("failed to emit run.cancelled event for queued cancel", {
            dispatchId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      res.status(200).json(updated);
      return;
    }

    // An in-flight dispatch (leasing/running/collecting): route through the
    // dispatcher's per-dispatch abort controller so its in-flight wisper
    // calls tear down. The executor's finally block still releases the
    // lease, and its recordFailure writes status `cancelled` (not `failed`)
    // then the dispatcher emits `run.cancelled`. If no dispatcher is wired
    // (leasing unconfigured, an unusual state for an in-flight row but
    // possible in tests) or no controller is registered (a claim we cannot
    // see; a race with the terminal transition), 409 is the honest answer.
    const cancelled = getRuntime().dispatcher?.cancel?.(id) ?? false;
    if (!cancelled) {
      throw new HttpError(
        409,
        "no in-flight dispatch to cancel; the run may have just finished, please retry"
      );
    }
    // The abort fires asynchronously; return the CURRENT row (still e.g.
    // `running`). Clients poll the dispatch record to see it flip to
    // `cancelled` (typically within a moment); the run detail page already
    // does this.
    res.status(200).json(dispatch);
  })
);

export default dispatchesRouter;

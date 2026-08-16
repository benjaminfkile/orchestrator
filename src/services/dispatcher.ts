/**
 * The dispatcher: a single-flight FIFO loop that drains the dispatch queue.
 *
 * One loop pass repeatedly claims the oldest `queued` dispatch
 * ({@link claimNextQueuedDispatch}) and runs it end-to-end ({@link runDispatch}),
 * strictly one at a time, until the queue is empty — then it idles. Concurrency
 * is exactly 1: the `dispatch_concurrency` setting is read, but any value above 1
 * is clamped to 1 with a warning (real concurrency is reserved for later).
 *
 * Two things wake the loop: {@link Dispatcher.kick} schedules an immediate pass
 * (called when a new dispatch is enqueued), and a safety interval
 * (`dispatcher_interval_seconds`, default {@link DEFAULT_INTERVAL_SECONDS}) ticks
 * a pass on its own so nothing is ever stranded if a kick is missed. Kicks are
 * coalesced: a kick arriving while a pass is in flight sets a re-run flag rather
 * than starting a second, overlapping pass.
 *
 * Retry policy: {@link runDispatch} never throws for an ordinary failure — it
 * returns a `failed` record tagged `retryable`. When a failure is retryable (the
 * run timed out, or a retryable {@link WisperApiError} tore it down) the
 * dispatcher increments `attempts`; while `attempts < dispatch_max_attempts`
 * (default {@link DEFAULT_MAX_ATTEMPTS}) it returns the dispatch to `queued` for
 * another try, otherwise it leaves it `failed`. A non-retryable failure — a
 * non-zero agent exit, a missing secret, an auth failure — is terminal
 * immediately and never requeued.
 *
 * Per the architecture principle this module is domain-neutral: it moves opaque
 * dispatch rows through their lifecycle and never inspects intent.
 */

import type { Knex } from "knex";

import { getDb } from "../db/db";
import {
  claimNextQueuedDispatch,
  resetToQueued,
  updateDispatch,
} from "../db/dispatches";
import { getSetting } from "../db/settings";
import {
  DEFAULT_SWEEP_BACKOFF_MS,
  runDispatch,
  sweepPendingReleases,
  type EnvResolver,
} from "../executor/executor";
import type { DispatchRecord } from "../interfaces";
import { log, type Logger } from "../log";
import type { WisperClient } from "../wisper/client";

import { evaluateRunBudget } from "./runBudget";
import { emitRunEvent, emitRunStartedEvent } from "./runEvents";
import { pruneRunRetention } from "./runRetention";

/** The `app_settings` key for the (currently clamped) worker count. */
export const CONCURRENCY_SETTING = "dispatch_concurrency";
/** The `app_settings` key for the safety-interval period, in seconds. */
export const INTERVAL_SETTING = "dispatcher_interval_seconds";
/** The `app_settings` key for the per-dispatch retry ceiling. */
export const MAX_ATTEMPTS_SETTING = "dispatch_max_attempts";

/** Safety-interval period when `dispatcher_interval_seconds` is unset. */
export const DEFAULT_INTERVAL_SECONDS = 30;
/** Retry ceiling when `dispatch_max_attempts` is unset. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * Period, in seconds, of the periodic release sweep the dispatcher arms while
 * it is running. Matches the executor's per-lease backoff so a stranded lease
 * gets one retry per sweep tick without hot-looping.
 */
export const DEFAULT_SWEEP_INTERVAL_SECONDS = 60;

/** Injected collaborators for a {@link Dispatcher}. */
export interface DispatcherDeps {
  /**
   * Wisper client the dispatches run in, or `null` when leasing is unconfigured.
   * A null client leaves the dispatcher idle: it never claims work (which would
   * only strand rows in `leasing`) and {@link Dispatcher.start} logs a warning.
   */
  wisper: WisperClient | null;
  /**
   * Resolver for playbook `env_requirements`. Defaults to one that resolves
   * nothing — a playbook needing a secret then fails terminally with a clear
   * "missing required secret" until a real secrets store is wired in.
   */
  resolveEnv?: EnvResolver;
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Base directory for per-dispatch log files; forwarded to the executor. */
  logBaseDir?: string;
  /** Body of the prompt's "## Working environment" section; forwarded on. */
  workingEnvironment?: string;
  /**
   * Per-call exec/release timeout in ms (and the streaming idle window),
   * forwarded to the executor. Defaults there to {@link DEFAULT_EXEC_TIMEOUT_MS}
   * when unset; boot threads the configured `WISPER_EXEC_TIMEOUT_MS`.
   */
  execTimeoutMs?: number;
  /**
   * Wall clock used by the run-budget gate and stamped as each run's
   * `started_at`, injectable for deterministic tests; defaults to `Date.now`.
   * Sharing one clock keeps the gate's trailing-window count consistent with the
   * run timestamps it counts.
   */
  now?: () => number;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a positive, finite numeric setting, falling back to `fallback` when the
 * key is unset or its value does not parse to a positive number.
 */
async function readPositiveNumberSetting(
  key: string,
  fallback: number,
  db: Knex
): Promise<number> {
  const raw = await getSetting(key, undefined, db);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** As {@link readPositiveNumberSetting}, floored to an integer. */
async function readPositiveIntSetting(
  key: string,
  fallback: number,
  db: Knex
): Promise<number> {
  return Math.floor(await readPositiveNumberSetting(key, fallback, db));
}

/**
 * The single-flight queue drainer. Construct one per process, wire
 * {@link Dispatcher.start}/{@link Dispatcher.stop} into the app lifecycle, and
 * call {@link Dispatcher.kick} whenever a dispatch is enqueued.
 */
export class Dispatcher {
  private readonly db: Knex;
  private readonly wisper: WisperClient | null;
  private readonly resolveEnv: EnvResolver;
  private readonly logger: Logger;
  private readonly logBaseDir?: string;
  private readonly workingEnvironment?: string;
  private readonly execTimeoutMs?: number;
  private readonly now: () => number;

  /** Safety-interval handle; undefined while stopped. */
  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Handle for the periodic {@link sweepPendingReleases} timer; undefined
   * while stopped or when leasing is unconfigured. Runs alongside the
   * dispatcher loop so a lease whose in-line release failed keeps being
   * retried until wisper acknowledges.
   */
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Set by stop(): no new pass starts and no new dispatch is claimed. A freshly
   * constructed dispatcher is not stopped, so a direct {@link Dispatcher.kick}
   * (without a preceding {@link Dispatcher.start}) still drives a pass.
   */
  private stopped = false;
  /** True while a drain pass is running; the single-flight guard. */
  private looping = false;
  /** A kick arrived mid-pass; the current pass runs once more when it ends. */
  private rerun = false;
  /** Resolves when the in-flight pass (if any) settles; awaited by stop(). */
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(deps: DispatcherDeps) {
    this.db = deps.db ?? getDb();
    this.wisper = deps.wisper;
    this.resolveEnv = deps.resolveEnv ?? (() => undefined);
    this.logger = (deps.logger ?? log).child({ component: "dispatcher" });
    this.logBaseDir = deps.logBaseDir;
    this.workingEnvironment = deps.workingEnvironment;
    this.execTimeoutMs = deps.execTimeoutMs;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Begin dispatching: read settings, arm the safety interval, and kick an
   * immediate first pass. With no wisper client the dispatcher stays idle. Safe
   * to call again after {@link Dispatcher.stop}.
   */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.wisper) {
      this.logger.warn("dispatcher idle: wisper is not configured");
      return;
    }

    // Concurrency is exactly 1 for now; read the setting but clamp anything
    // higher, warning so a misconfiguration is visible. Reserved for later.
    const concurrency = await readPositiveIntSetting(
      CONCURRENCY_SETTING,
      1,
      this.db
    );
    if (concurrency > 1) {
      this.logger.warn(
        "dispatch_concurrency > 1 is not supported yet; clamping to 1",
        { requested: concurrency }
      );
    }

    const intervalSeconds = await readPositiveNumberSetting(
      INTERVAL_SETTING,
      DEFAULT_INTERVAL_SECONDS,
      this.db
    );
    this.timer = setInterval(() => this.kick(), intervalSeconds * 1000);
    // Never let the safety interval hold the process open on its own.
    this.timer.unref?.();

    // Arm the periodic release sweep so a lease whose in-line release failed
    // keeps being retried while the dispatcher is running. Best-effort: a
    // sweep failure logs and moves on — it must never break the drain loop.
    this.sweepTimer = setInterval(
      () => void this.runSweep(),
      DEFAULT_SWEEP_INTERVAL_SECONDS * 1000
    );
    this.sweepTimer.unref?.();

    this.logger.info("dispatcher started", { intervalSeconds });
    this.kick();
  }

  /**
   * Run one release-sweep pass. Wrapped so a failure never propagates out of
   * the timer callback: release sweeping is housekeeping and must never crash
   * the process the way an unhandled rejection would.
   */
  private async runSweep(): Promise<void> {
    if (this.stopped || !this.wisper) return;
    try {
      await sweepPendingReleases({
        wisper: this.wisper,
        db: this.db,
        logger: this.logger,
        execTimeoutMs: this.execTimeoutMs,
        backoffMs: DEFAULT_SWEEP_BACKOFF_MS,
        now: this.now,
      });
    } catch (err) {
      this.logger.error("release sweep failed", { error: errorMessage(err) });
    }
  }

  /**
   * Stop dispatching and drain the in-flight dispatch. Clears the safety
   * interval, blocks any further pass or claim, then awaits the current pass so
   * the dispatch already running is allowed to finish (never aborted mid-run).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await this.loopPromise;
    this.logger.info("dispatcher stopped");
  }

  /**
   * Schedule an immediate drain pass. Coalesced and single-flight: a kick while a
   * pass is already running just flags a re-run; otherwise it starts the pass.
   * A no-op once stopped or when leasing is unconfigured.
   */
  kick(): void {
    if (this.stopped || !this.wisper) return;
    if (this.looping) {
      this.rerun = true;
      return;
    }
    this.loopPromise = this.runLoop();
  }

  /**
   * Resolve once the in-flight pass (if any) has settled. A test aid for driving
   * the loop deterministically without waiting on the safety interval.
   */
  async whenSettled(): Promise<void> {
    await this.loopPromise;
  }

  /** Run drain passes back-to-back while kicks keep arriving mid-pass. */
  private async runLoop(): Promise<void> {
    this.looping = true;
    try {
      do {
        this.rerun = false;
        await this.drainToEmpty();
      } while (this.rerun && !this.stopped);
    } finally {
      this.looping = false;
    }
  }

  /** Claim-and-run the oldest queued dispatch repeatedly until the queue drains. */
  private async drainToEmpty(): Promise<void> {
    for (;;) {
      if (this.stopped) return;

      // Run-budget gate: before claiming, check whether the (optional) budget is
      // holding new runs. When it is, claim NOTHING this pass — the over-budget
      // work stays queued and drains FIFO as the window slides. This is normal
      // operation, so it logs at debug, not warn. The gate is a no-op (returns
      // null immediately) until a budget is configured.
      let hold;
      try {
        hold = await evaluateRunBudget({ db: this.db, now: this.now });
      } catch (err) {
        // A gate read failure must not strand the queue; log and skip the gate
        // this pass rather than block all dispatching on a transient DB error.
        this.logger.error("run-budget gate evaluation failed", {
          error: errorMessage(err),
        });
        hold = null;
      }
      if (hold) {
        this.logger.debug("run-budget gate holding; claiming nothing", {
          window_count: hold.window_count,
          budget: hold.budget,
          next_eligible_at: hold.next_eligible_at,
          token_breaker: hold.token_breaker ?? false,
        });
        return;
      }

      let dispatch: DispatchRecord | null;
      try {
        dispatch = await claimNextQueuedDispatch(this.db);
      } catch (err) {
        this.logger.error("failed to claim next dispatch", {
          error: errorMessage(err),
        });
        return;
      }
      if (!dispatch) return; // queue empty → idle

      try {
        await this.processDispatch(dispatch);
      } catch (err) {
        // runDispatch only rejects for a vanished id or a bookkeeping DB write
        // failure. Log and end this pass rather than spin; the safety interval
        // (and startup reconciliation on the next boot) recovers the row.
        this.logger.error("dispatch processing errored", {
          dispatchId: dispatch.id,
          error: errorMessage(err),
        });
        return;
      }
    }
  }

  /** Run one claimed dispatch and apply the retry/terminal policy to its result. */
  private async processDispatch(dispatch: DispatchRecord): Promise<void> {
    // Guarded already by kick()/drainToEmpty, but keep the type honest.
    if (!this.wisper) return;

    // The dispatch has been claimed (queued → leasing) and is about to execute.
    // Feed a `run.started` event back into the pipeline so a rule can notify
    // (or chain) when a long-running dispatch actually begins. Skipped/dropped
    // dispatches never reach this point, so nothing bogus is emitted.
    await this.emitStartedEvent(dispatch);

    const outcome = await runDispatch(dispatch.id, {
      wisper: this.wisper,
      resolveEnv: this.resolveEnv,
      db: this.db,
      logger: this.logger,
      logBaseDir: this.logBaseDir,
      workingEnvironment: this.workingEnvironment,
      execTimeoutMs: this.execTimeoutMs,
      now: this.now,
    });

    if (outcome.status !== "failed") {
      // done — the terminal success. Feed a `run.completed` event back into the
      // pipeline so rules can react to the outcome.
      await this.emitTerminalEvent(outcome, "done");
      return;
    }

    if (!outcome.retryable) {
      this.logger.info("dispatch failed (terminal)", {
        dispatchId: dispatch.id,
        error: outcome.error,
      });
      // A non-retryable failure is terminal now: emit `run.failed`.
      await this.emitTerminalEvent(outcome, "failed");
      return;
    }

    // Retryable: count this attempt, then requeue while attempts are left.
    const attempts = outcome.attempts + 1;
    const maxAttempts = await readPositiveIntSetting(
      MAX_ATTEMPTS_SETTING,
      DEFAULT_MAX_ATTEMPTS,
      this.db
    );
    await updateDispatch(dispatch.id, { attempts }, this.db);
    if (attempts < maxAttempts) {
      // resetToQueued clears the stale lease/contract handles and returns the row
      // to `queued`; it keeps `attempts`, so the counter survives the retry.
      // A failure that will be retried is NOT terminal, so no event is emitted.
      await resetToQueued(dispatch.id, this.db);
      this.logger.warn("dispatch failed (retryable); requeued", {
        dispatchId: dispatch.id,
        attempts,
        maxAttempts,
        error: outcome.error,
      });
    } else {
      this.logger.warn("dispatch failed (retryable); retries exhausted", {
        dispatchId: dispatch.id,
        attempts,
        maxAttempts,
        error: outcome.error,
      });
      // Retries exhausted → this failure is now terminal: emit `run.failed`.
      await this.emitTerminalEvent(outcome, "failed");
    }
  }

  /**
   * Emit the `run.started` callback event ({@link emitRunStartedEvent}) for a
   * just-claimed dispatch, passing this dispatcher as the kick target so any
   * rule-driven chained dispatch is picked up promptly.
   *
   * Emission MUST NEVER break the drain loop: any failure here (a DB read error,
   * a rule-engine throw) is caught and logged, and the run still proceeds.
   */
  private async emitStartedEvent(dispatch: DispatchRecord): Promise<void> {
    try {
      await emitRunStartedEvent(dispatch, {
        db: this.db,
        dispatcher: this,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.error("failed to emit run.started event", {
        dispatchId: dispatch.id,
        error: errorMessage(err),
      });
    }
  }

  /**
   * Emit the run-lifecycle callback event ({@link emitRunEvent}) for a dispatch
   * that has reached its terminal `done`/`failed` state, passing this dispatcher
   * as the kick target so a chained dispatch starts promptly.
   *
   * Emission MUST NEVER break the drain loop: any failure here (a DB read error,
   * a rule-engine throw) is caught and logged, and the pass continues.
   */
  private async emitTerminalEvent(
    dispatch: DispatchRecord,
    status: "done" | "failed"
  ): Promise<void> {
    try {
      await emitRunEvent(dispatch, status, {
        db: this.db,
        dispatcher: this,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.error("failed to emit run lifecycle event", {
        dispatchId: dispatch.id,
        status,
        error: errorMessage(err),
      });
    }

    // Terminal bookkeeping is done; bound the run history. Best-effort: a
    // retention failure MUST NEVER break the drain loop or the dispatch that
    // just completed, so it is caught and logged, never rethrown.
    await this.pruneRetention();
  }

  /**
   * Prune terminal run history down to the `run_retention_max` cap. Wrapped so a
   * failure is contained: retention is housekeeping, never on the critical path
   * of dispatching.
   */
  private async pruneRetention(): Promise<void> {
    try {
      await pruneRunRetention({
        db: this.db,
        logBaseDir: this.logBaseDir,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.error("run retention prune failed", {
        error: errorMessage(err),
      });
    }
  }
}

/**
 * The run-budget gate: an OPTIONAL, data-driven brake on how many agent runs the
 * dispatcher STARTS per rolling time window. It protects a capped Claude
 * subscription from a burst of events launching many runs back to back.
 *
 * The gate is purely additive to the queue: over-budget dispatches simply stay
 * `queued` (the existing waiting list) and drain FIFO as the window slides —
 * this module invents no new tables or statuses. It counts runs by their
 * `started_at`, so it measures runs the dispatcher STARTED, not runs created.
 *
 * Two independent controls, both off by default:
 *   - the PRIMARY run-count gate (`run_budget_per_hour` over a
 *     `run_budget_window_minutes` window): hold once the window already holds
 *     that many started runs.
 *   - a SECONDARY, reactive token circuit breaker (`token_budget_per_window`):
 *     hold once the summed usage tokens of the in-window runs exceed the budget.
 *     A run's cost is only known when it ENDS, so this is a backstop that trips
 *     after the fact, never the primary control.
 *
 * Per the architecture principle this module is domain-neutral: it counts opaque
 * run rows and never inspects intent.
 */

import type { Knex } from "knex";

import { getDb } from "../db/db";
import { getRunBudgetWindow } from "../db/runs";
import { getSetting } from "../db/settings";

/** app_settings key: max agent runs STARTED per rolling window (0/unset = off). */
export const RUN_BUDGET_PER_HOUR_SETTING = "run_budget_per_hour";
/** app_settings key: the rolling window, in minutes, the run budget counts over. */
export const RUN_BUDGET_WINDOW_MINUTES_SETTING = "run_budget_window_minutes";
/** app_settings key: optional trailing-window token circuit breaker (0/unset = off). */
export const TOKEN_BUDGET_PER_WINDOW_SETTING = "token_budget_per_window";

/** Window length when `run_budget_window_minutes` is unset or unparseable. */
export const DEFAULT_RUN_BUDGET_WINDOW_MINUTES = 60;

/** Milliseconds in one minute; the window setting is expressed in minutes. */
const MINUTE_MS = 60 * 1000;

/**
 * The observable reason a queued dispatch is being HELD by the budget gate
 * rather than merely awaiting the next dispatcher tick. Surfaced additively on
 * the dispatches API and logged (at debug) when the dispatcher claims nothing.
 */
export interface BudgetWait {
  /** The single waiting reason this gate produces. */
  waiting_reason: "budget";
  /** Runs started within the trailing window right now. */
  window_count: number;
  /** The run-count budget (`run_budget_per_hour`), or null when only the token breaker is active. */
  budget: number | null;
  /**
   * When the oldest in-window run leaves the window (`oldestStartedAt +
   * windowMs`) — the soonest a claim could next succeed. Null when the window is
   * somehow empty (nothing to age out).
   */
  next_eligible_at: number | null;
  /** True when the token circuit breaker (not the run count) is what tripped. */
  token_breaker?: boolean;
  /** The token budget, present only when the token breaker tripped. */
  token_budget?: number;
  /** The summed in-window usage tokens, present only when the token breaker tripped. */
  window_tokens?: number;
}

/**
 * Read a setting as a non-negative integer, treating unset / empty / garbage /
 * non-positive as `0`. Used for the two "0 = disabled" budget knobs.
 */
async function readOptionalNonNegativeInt(
  key: string,
  db: Knex
): Promise<number> {
  const raw = await getSetting(key, undefined, db);
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * Read a strictly-positive integer setting, falling back to `fallback` when the
 * key is unset or does not parse to a positive number. Used for the window
 * length, which must always be positive.
 */
async function readPositiveInt(
  key: string,
  fallback: number,
  db: Knex
): Promise<number> {
  const raw = await getSetting(key, undefined, db);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Injected collaborators for {@link evaluateRunBudget}. */
export interface RunBudgetDeps {
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /** Wall clock, injectable for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Decide whether the run-budget gate should HOLD claiming right now.
 *
 * Returns a {@link BudgetWait} describing the hold, or `null` when the
 * dispatcher is free to claim the next queued dispatch. `null` is returned
 * immediately when BOTH knobs are off (the default), so the gate adds nothing to
 * today's behavior until a budget is configured.
 *
 * The run-count gate is checked first (the primary control); the token breaker
 * is the secondary backstop. Either tripping holds all claiming until the window
 * slides enough to drop the oldest started run.
 */
export async function evaluateRunBudget(
  deps: RunBudgetDeps = {}
): Promise<BudgetWait | null> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now;

  const runBudget = await readOptionalNonNegativeInt(
    RUN_BUDGET_PER_HOUR_SETTING,
    db
  );
  const tokenBudget = await readOptionalNonNegativeInt(
    TOKEN_BUDGET_PER_WINDOW_SETTING,
    db
  );
  // Both disabled → the gate is entirely off; skip the DB read.
  if (runBudget <= 0 && tokenBudget <= 0) return null;

  const windowMinutes = await readPositiveInt(
    RUN_BUDGET_WINDOW_MINUTES_SETTING,
    DEFAULT_RUN_BUDGET_WINDOW_MINUTES,
    db
  );
  const windowMs = windowMinutes * MINUTE_MS;
  const sinceMs = now() - windowMs;
  const { count, tokenSum, oldestStartedAt } = await getRunBudgetWindow(
    sinceMs,
    db
  );
  const nextEligibleAt =
    oldestStartedAt === null ? null : oldestStartedAt + windowMs;

  // PRIMARY: hold once the window already holds `runBudget` started runs.
  if (runBudget > 0 && count >= runBudget) {
    return {
      waiting_reason: "budget",
      window_count: count,
      budget: runBudget,
      next_eligible_at: nextEligibleAt,
    };
  }

  // SECONDARY (reactive backstop): hold once summed in-window usage exceeds the
  // token budget. A run's cost is only known when it ends, so this trips after
  // the fact and releases as the window drains.
  if (tokenBudget > 0 && tokenSum > tokenBudget) {
    return {
      waiting_reason: "budget",
      window_count: count,
      budget: runBudget > 0 ? runBudget : null,
      next_eligible_at: nextEligibleAt,
      token_breaker: true,
      token_budget: tokenBudget,
      window_tokens: tokenSum,
    };
  }

  return null;
}

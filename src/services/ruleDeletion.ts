/**
 * Rule deletion with a safe treatment of the dispatch history that references it.
 *
 * `dispatches.rule_id` is a nullable FK to `rules.id`. A rule with any dispatch
 * row referencing it therefore CANNOT be deleted while `PRAGMA foreign_keys` is
 * ON without either widening the FK to `ON DELETE SET NULL` or nulling those
 * columns first. This service takes the second, explicit-in-a-transaction path:
 * the router does not have to translate a raw SQLite FK error, and the run
 * history stays readable (a dispatch's `rule_id` simply becomes null once the
 * originating rule is gone).
 *
 * Two rules make the delete safe:
 *
 *   1. A rule with ANY in-flight (non-terminal) dispatch is NEVER deleted. The
 *      caller surfaces that as a 409 so a run is never yanked mid-flight. This
 *      mirrors {@link deletePlaybookWithHistory}.
 *   2. Otherwise a single transaction sets `dispatches.rule_id` to null on the
 *      remaining (terminal) rows that reference the rule, then deletes the rule
 *      row. Because step 1 rules out non-terminal referrers, the null-out only
 *      touches finished history.
 *
 * Per the architecture principle this module stays domain-neutral: it counts and
 * nulls opaque rows and never inspects a rule's intent.
 */

import type { Knex } from "knex";

import { getDb } from "../db/db";
import { ACTIVE_DISPATCH_STATUSES } from "../db/dispatches";
import { log, type Logger } from "../log";

/** Injected collaborators for {@link deleteRuleWithHistory}. */
export interface DeleteRuleDeps {
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
}

/** The result of a delete attempt, so the router can map it to a status code. */
export type DeleteRuleOutcome =
  | { outcome: "deleted"; nullifiedDispatches: number }
  | { outcome: "not_found" }
  | { outcome: "in_flight"; inFlight: number };

/**
 * Delete a rule and null out `dispatches.rule_id` on the terminal history that
 * referenced it.
 *
 *   - `not_found` when no rule has `ruleId` (-> 404).
 *   - `in_flight` when the rule has any non-terminal dispatch; nothing is
 *     deleted (-> 409). `inFlight` is the count for the caller's message.
 *   - `deleted` after the terminal dispatches' `rule_id` is nulled and the rule
 *     row is removed (-> 204). `nullifiedDispatches` is the count of rows the
 *     null-out touched.
 */
export async function deleteRuleWithHistory(
  ruleId: number,
  deps: DeleteRuleDeps = {}
): Promise<DeleteRuleOutcome> {
  const db = deps.db ?? getDb();
  const logger = (deps.logger ?? log).child({ component: "rule-delete" });

  const rule = await db<{ id: number }>("rules").where({ id: ruleId }).first();
  if (!rule) return { outcome: "not_found" };

  const inFlightRow = await db("dispatches")
    .where({ rule_id: ruleId })
    .whereIn("status", [...ACTIVE_DISPATCH_STATUSES])
    .count<{ n: number | string }>({ n: "*" })
    .first();
  const inFlight = Number(inFlightRow?.n ?? 0);
  if (inFlight > 0) {
    return { outcome: "in_flight", inFlight };
  }

  const nullifiedDispatches = await db.transaction(async (trx) => {
    const nulled = await trx("dispatches")
      .where({ rule_id: ruleId })
      .update({ rule_id: null, updated_at: Date.now() });
    await trx("rules").where({ id: ruleId }).delete();
    return nulled;
  });

  logger.info("deleted rule and nulled referencing dispatches", {
    ruleId,
    nullifiedDispatches,
  });
  return { outcome: "deleted", nullifiedDispatches };
}

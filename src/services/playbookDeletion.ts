/**
 * Playbook deletion with an informed-consent cascade.
 *
 * Deleting a playbook removes not just the playbook row but all of its run
 * history — the `dispatches.playbook_id` foreign key would otherwise block the
 * delete outright. Two rules make the cascade safe:
 *
 *   1. A playbook with ANY in-flight (non-terminal) dispatch is NEVER deleted —
 *      the caller surfaces that as a 409 so a run is never yanked mid-flight.
 *   2. Otherwise every terminal dispatch, its runs, those runs' findings, and
 *      each dispatch's on-disk log file are removed via the SAME FK-safe helper
 *      the retention pass uses ({@link deleteDispatchesWithHistory}), then the
 *      playbook row itself is deleted.
 *
 * Referencing rules are NOT a barrier: a rule whose dispatch target names a
 * now-deleted playbook simply becomes dangling, and the dispatch path
 * fail-closes on the unknown id (see the router doc comment). The `/usage`
 * counts let the UI warn about exactly this before the user confirms.
 *
 * Per the architecture principle this module stays domain-neutral: it counts and
 * deletes opaque rows and never inspects a playbook's or event's intent.
 */

import type { Knex } from "knex";

import { getDb } from "../db/db";
import {
  deletePlaybook,
  getPlaybook,
  getPlaybookHistoryCounts,
  terminalDispatchIdsForPlaybook,
  type PlaybookHistoryCounts,
} from "../db/playbooks";
import { rulesReferencingPlaybook } from "../db/rules";
import { log, type Logger } from "../log";

import { deleteDispatchesWithHistory } from "./runRetention";

/** A rule that would be left with a dangling dispatch target by a delete. */
export interface ReferencingRule {
  id: number;
  name: string;
}

/**
 * A playbook's run-history footprint plus the enabled rules that reference it —
 * everything the delete dialog needs to warn the user about what a cascade
 * removes and which rules stop dispatching afterward.
 */
export interface PlaybookUsage extends PlaybookHistoryCounts {
  referencing_rules: ReferencingRule[];
}

/**
 * Gather what deleting `playbookId` would affect: the run-history counts, the
 * in-flight count, and the ENABLED rules whose dispatch targets reference it
 * (their targets become dangling after a delete). Disabled rules are omitted —
 * they cannot dispatch, so a dangling target on them is inert.
 */
export async function getPlaybookUsage(
  playbookId: number,
  db: Knex = getDb()
): Promise<PlaybookUsage> {
  const counts = await getPlaybookHistoryCounts(playbookId, db);
  const referencing_rules = (await rulesReferencingPlaybook(playbookId, db))
    .filter((rule) => rule.enabled)
    .map((rule) => ({ id: rule.id, name: rule.name }));
  return { ...counts, referencing_rules };
}

/** Injected collaborators for {@link deletePlaybookWithHistory}. */
export interface DeletePlaybookDeps {
  /** Knex handle; defaults to the process singleton. */
  db?: Knex;
  /** Base dir the per-dispatch log files live under; defaults to the user-data dir. */
  logBaseDir?: string;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
}

/** The result of a delete attempt, so the router can map it to a status code. */
export type DeletePlaybookOutcome =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "in_flight"; inFlight: number };

/**
 * Delete a playbook and cascade its terminal run history.
 *
 *   - `not_found` when no playbook has `playbookId` (→ 404).
 *   - `in_flight` when the playbook has any non-terminal dispatch; nothing is
 *     deleted (→ 409). `inFlight` is the count for the caller's message.
 *   - `deleted` after the terminal dispatches (+ runs, findings, log files) and
 *     the playbook row are removed (→ 204).
 */
export async function deletePlaybookWithHistory(
  playbookId: number,
  deps: DeletePlaybookDeps = {}
): Promise<DeletePlaybookOutcome> {
  const db = deps.db ?? getDb();
  const logger = (deps.logger ?? log).child({ component: "playbook-delete" });

  const playbook = await getPlaybook(playbookId, db);
  if (!playbook) return { outcome: "not_found" };

  const counts = await getPlaybookHistoryCounts(playbookId, db);
  if (counts.in_flight > 0) {
    return { outcome: "in_flight", inFlight: counts.in_flight };
  }

  const ids = await terminalDispatchIdsForPlaybook(playbookId, db);
  const removed = await deleteDispatchesWithHistory(ids, {
    db,
    logBaseDir: deps.logBaseDir,
    logger: deps.logger,
  });
  await deletePlaybook(playbookId, db);

  logger.info("deleted playbook and cascaded run history", {
    playbookId,
    dispatches: removed,
  });
  return { outcome: "deleted" };
}

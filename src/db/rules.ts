import type { Knex } from "knex";

import type {
  NewRule,
  RuleDispatchTarget,
  RuleMatch,
  RuleNotifyTarget,
  RuleRecord,
  RuleUpdate,
} from "../interfaces";

import { getDb } from "./db";

/** Raw row shape as stored on disk: JSON columns are TEXT, enabled is 0/1. */
interface RuleRow {
  id: number;
  name: string;
  enabled: number;
  match: string;
  dispatch: string;
  notify: string;
  created_at: number;
  updated_at: number;
}

/** Decode an on-disk row into a typed {@link RuleRecord}. */
function fromRow(row: RuleRow): RuleRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    match: JSON.parse(row.match) as RuleMatch,
    dispatch: JSON.parse(row.dispatch) as RuleDispatchTarget[],
    notify: JSON.parse(row.notify) as RuleNotifyTarget[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Insert a new rule and return the stored record. `enabled` defaults to true,
 * `match` to `{}`, and `dispatch`/`notify` to `[]`; timestamps are set to the
 * current time.
 */
export async function createRule(
  rule: NewRule,
  db: Knex = getDb()
): Promise<RuleRecord> {
  const now = Date.now();
  const [row] = await db<RuleRow>("rules")
    .insert({
      name: rule.name,
      enabled: (rule.enabled ?? true) ? 1 : 0,
      match: JSON.stringify(rule.match ?? {}),
      dispatch: JSON.stringify(rule.dispatch ?? []),
      notify: JSON.stringify(rule.notify ?? []),
      created_at: now,
      updated_at: now,
    })
    .returning("*");
  return fromRow(row);
}

/** Fetch a single rule by id, or `undefined` if none exists. */
export async function getRule(
  id: number,
  db: Knex = getDb()
): Promise<RuleRecord | undefined> {
  const row = await db<RuleRow>("rules").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/** List all rules newest-first (`created_at` DESC, `id` DESC to break ties). */
export async function listRules(db: Knex = getDb()): Promise<RuleRecord[]> {
  const rows = await db<RuleRow>("rules")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc");
  return rows.map(fromRow);
}

/**
 * Apply a partial update to a rule, bumping `updated_at`. Returns the updated
 * record, or `undefined` if no rule with `id` exists.
 */
export async function updateRule(
  id: number,
  patch: RuleUpdate,
  db: Knex = getDb()
): Promise<RuleRecord | undefined> {
  const changes: Partial<RuleRow> = { updated_at: Date.now() };
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.enabled !== undefined) changes.enabled = patch.enabled ? 1 : 0;
  if (patch.match !== undefined) changes.match = JSON.stringify(patch.match);
  if (patch.dispatch !== undefined) {
    changes.dispatch = JSON.stringify(patch.dispatch);
  }
  if (patch.notify !== undefined) {
    changes.notify = JSON.stringify(patch.notify);
  }
  const count = await db<RuleRow>("rules").where({ id }).update(changes);
  if (count === 0) return undefined;
  return getRule(id, db);
}

/**
 * Return every rule whose dispatch targets reference `playbookId`. Used to warn,
 * before a playbook is deleted, which rules would be left with a dangling target
 * (the delete cascades regardless; a dangling target then fail-closes at dispatch
 * creation — see {@link getPlaybookUsage}).
 */
export async function rulesReferencingPlaybook(
  playbookId: number,
  db: Knex = getDb()
): Promise<RuleRecord[]> {
  const rules = await listRules(db);
  return rules.filter((rule) =>
    rule.dispatch.some((target) => target.playbook_id === playbookId)
  );
}

/** Delete a rule by id. Returns true when a row was removed. */
export async function deleteRule(
  id: number,
  db: Knex = getDb()
): Promise<boolean> {
  const count = await db<RuleRow>("rules").where({ id }).delete();
  return count > 0;
}

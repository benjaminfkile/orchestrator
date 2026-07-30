import type { Knex } from "knex";

import type {
  NewNotifier,
  NotifierRecord,
  NotifierUpdate,
} from "../interfaces";

import { getDb } from "./db";

/** Raw row shape as stored on disk: config is JSON-encoded TEXT, enabled is 0/1. */
interface NotifierRow {
  id: number;
  name: string;
  config: string;
  title_template: string;
  body_template: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** Decode an on-disk row into a typed {@link NotifierRecord}. */
function fromRow(row: NotifierRow): NotifierRecord {
  return {
    id: row.id,
    name: row.name,
    config: JSON.parse(row.config) as Record<string, unknown>,
    title_template: row.title_template,
    body_template: row.body_template,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Insert a new notifier and return the stored record. `config` defaults to `{}`,
 * the templates to `""`, and `enabled` to true; timestamps are set to the
 * current time.
 */
export async function createNotifier(
  notifier: NewNotifier,
  db: Knex = getDb()
): Promise<NotifierRecord> {
  const now = Date.now();
  const [row] = await db<NotifierRow>("notifiers")
    .insert({
      name: notifier.name,
      config: JSON.stringify(notifier.config ?? {}),
      title_template: notifier.title_template ?? "",
      body_template: notifier.body_template ?? "",
      enabled: (notifier.enabled ?? true) ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .returning("*");
  return fromRow(row);
}

/** Fetch a single notifier by id, or `undefined` if none exists. */
export async function getNotifier(
  id: number,
  db: Knex = getDb()
): Promise<NotifierRecord | undefined> {
  const row = await db<NotifierRow>("notifiers").where({ id }).first();
  return row ? fromRow(row) : undefined;
}

/** List all notifiers newest-first (`created_at` DESC, `id` DESC to break ties). */
export async function listNotifiers(
  db: Knex = getDb()
): Promise<NotifierRecord[]> {
  const rows = await db<NotifierRow>("notifiers")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc");
  return rows.map(fromRow);
}

/**
 * Apply a partial update to a notifier, bumping `updated_at`. Returns the updated
 * record, or `undefined` if no notifier with `id` exists.
 */
export async function updateNotifier(
  id: number,
  patch: NotifierUpdate,
  db: Knex = getDb()
): Promise<NotifierRecord | undefined> {
  const changes: Partial<NotifierRow> = { updated_at: Date.now() };
  if (patch.name !== undefined) changes.name = patch.name;
  if (patch.config !== undefined) changes.config = JSON.stringify(patch.config);
  if (patch.title_template !== undefined) {
    changes.title_template = patch.title_template;
  }
  if (patch.body_template !== undefined) {
    changes.body_template = patch.body_template;
  }
  if (patch.enabled !== undefined) changes.enabled = patch.enabled ? 1 : 0;
  const count = await db<NotifierRow>("notifiers").where({ id }).update(changes);
  if (count === 0) return undefined;
  return getNotifier(id, db);
}

/** Delete a notifier by id. Returns true when a row was removed. */
export async function deleteNotifier(
  id: number,
  db: Knex = getDb()
): Promise<boolean> {
  const count = await db<NotifierRow>("notifiers").where({ id }).delete();
  return count > 0;
}

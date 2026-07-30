import type { Knex } from "knex";

import type {
  ListNotificationsOptions,
  NewNotificationLog,
  NotificationLogRecord,
  NotificationStatus,
} from "../interfaces";

import { getDb } from "./db";
import { applySearchFilter } from "./search";

/** Raw row shape as stored on disk. */
interface NotificationLogRow {
  id: number;
  notifier_id: number | null;
  event_id: number | null;
  title: string;
  body: string;
  status: string;
  error: string | null;
  read_at: number | null;
  created_at: number;
}

/** Decode an on-disk row into a typed {@link NotificationLogRecord}. */
function fromRow(row: NotificationLogRow): NotificationLogRecord {
  return {
    id: row.id,
    notifier_id: row.notifier_id,
    event_id: row.event_id,
    title: row.title,
    body: row.body,
    status: row.status as NotificationStatus,
    error: row.error,
    read_at: row.read_at,
    created_at: row.created_at,
  };
}

/**
 * Append a notification-log row and return the stored record. `notifier_id`,
 * `event_id`, and `error` fall back to null; `read_at` starts null and
 * `created_at` is set to the current time.
 */
export async function insertNotification(
  entry: NewNotificationLog,
  db: Knex = getDb()
): Promise<NotificationLogRecord> {
  const [row] = await db<NotificationLogRow>("notification_log")
    .insert({
      notifier_id: entry.notifier_id ?? null,
      event_id: entry.event_id ?? null,
      title: entry.title,
      body: entry.body,
      status: entry.status,
      error: entry.error ?? null,
      read_at: null,
      created_at: Date.now(),
    })
    .returning("*");
  return fromRow(row);
}

/** Fetch a single notification by id, or `undefined` if none exists. */
export async function getNotification(
  id: number,
  db: Knex = getDb()
): Promise<NotificationLogRecord | undefined> {
  const row = await db<NotificationLogRow>("notification_log")
    .where({ id })
    .first();
  return row ? fromRow(row) : undefined;
}

/** The columns a `q` search scans on a notification row. */
const NOTIFICATION_SEARCH_COLUMNS = [
  "notification_log.title",
  "notification_log.body",
  "notification_log.status",
  "notification_log.error",
] as const;

/**
 * List notifications newest-first. Pass `cursor` (a row id) to page: only rows
 * with an id strictly less than the cursor are returned. `unreadOnly` restricts
 * to rows whose `read_at` is null; `limit` defaults to 50. `q` is a free-text
 * filter (see {@link ListNotificationsOptions}); it composes with the cursor and
 * `unreadOnly`, so paging walks the FILTERED set.
 */
export async function listNotifications(
  options: ListNotificationsOptions = {},
  db: Knex = getDb()
): Promise<NotificationLogRecord[]> {
  const limit = options.limit ?? 50;
  let query = db<NotificationLogRow>("notification_log")
    .orderBy("id", "desc")
    .limit(limit);
  if (options.cursor !== undefined) {
    query = query.where("id", "<", options.cursor);
  }
  if (options.unreadOnly) {
    query = query.whereNull("read_at");
  }
  query = applySearchFilter(query, options.q, NOTIFICATION_SEARCH_COLUMNS);
  const rows = await query;
  return rows.map(fromRow);
}

/** Count notifications whose `read_at` is still null. */
export async function countUnread(db: Knex = getDb()): Promise<number> {
  const row = await db<NotificationLogRow>("notification_log")
    .whereNull("read_at")
    .count<{ n: number }>({ n: "*" })
    .first();
  return Number(row?.n ?? 0);
}

/**
 * Mark a single notification read, stamping `read_at` if it is not already set.
 * Returns the updated record, or `undefined` if no row with `id` exists. A row
 * already marked read is returned unchanged (its original `read_at` is kept).
 */
export async function markNotificationRead(
  id: number,
  db: Knex = getDb()
): Promise<NotificationLogRecord | undefined> {
  const existing = await getNotification(id, db);
  if (!existing) return undefined;
  if (existing.read_at !== null) return existing;
  await db<NotificationLogRow>("notification_log")
    .where({ id })
    .update({ read_at: Date.now() });
  return getNotification(id, db);
}

/**
 * Mark every unread notification read, stamping `read_at` on each. Returns the
 * number of rows updated.
 */
export async function markAllNotificationsRead(
  db: Knex = getDb()
): Promise<number> {
  return db<NotificationLogRow>("notification_log")
    .whereNull("read_at")
    .update({ read_at: Date.now() });
}

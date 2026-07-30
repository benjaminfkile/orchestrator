import type { Knex } from "knex";

import { getDb } from "./db";

interface SettingRow {
  key: string;
  value: string;
}

/**
 * Read a value from the `app_settings` table, returning `fallback` when the key
 * is absent.
 */
export async function getSetting(
  key: string,
  fallback?: string,
  db: Knex = getDb()
): Promise<string | undefined> {
  const row = await db<SettingRow>("app_settings").where({ key }).first();
  return row ? row.value : fallback;
}

/**
 * Read every setting as a plain `{key: value}` map, key-ascending on disk but
 * order-insensitive as an object. Empty when no settings are stored.
 */
export async function getAllSettings(
  db: Knex = getDb()
): Promise<Record<string, string>> {
  const rows = await db<SettingRow>("app_settings").orderBy("key", "asc");
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/** Insert or update a value in the `app_settings` table. */
export async function setSetting(
  key: string,
  value: string,
  db: Knex = getDb()
): Promise<void> {
  await db<SettingRow>("app_settings")
    .insert({ key, value })
    .onConflict("key")
    .merge();
}

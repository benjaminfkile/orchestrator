import type { Knex } from "knex";

import { getDb } from "./db";

/** Raw row shape as stored on disk: `config` is a JSON object serialized to TEXT. */
interface ModuleConfigRow {
  module_id: string;
  config: string;
  updated_at: number;
}

/**
 * Anything the persisted config can notify after a write. A {@link
 * import("../modules/registry").ModuleRegistry} satisfies this structurally, so
 * it can be passed straight through without the db layer importing the registry.
 */
export interface ModuleConfigNotifier {
  onConfigChanged(moduleId: string): void | Promise<void>;
}

/**
 * Read a module's persisted config, parsed from JSON, or `undefined` when no row
 * exists for `moduleId`. The stored value is opaque to the core — its shape is
 * defined entirely by the owning module.
 */
export async function getModuleConfig(
  moduleId: string,
  db: Knex = getDb()
): Promise<unknown | undefined> {
  const row = await db<ModuleConfigRow>("module_config")
    .where({ module_id: moduleId })
    .first();
  return row ? (JSON.parse(row.config) as unknown) : undefined;
}

/** A parsed `module_config` row: the module id paired with its opaque config. */
export interface ModuleConfigEntry {
  module_id: string;
  config: unknown;
}

/**
 * Read every persisted module config, parsed from JSON, ordered by `module_id`
 * ascending. Used by the config exporter, which reads module config generically
 * rather than through any single module.
 */
export async function listModuleConfigs(
  db: Knex = getDb()
): Promise<ModuleConfigEntry[]> {
  const rows = await db<ModuleConfigRow>("module_config").orderBy(
    "module_id",
    "asc"
  );
  return rows.map((row) => ({
    module_id: row.module_id,
    config: JSON.parse(row.config) as unknown,
  }));
}

/**
 * Insert or update a module's config, serializing it to JSON and stamping
 * `updated_at`. When a `notifier` is supplied it is invoked after the write
 * settles so the module can re-derive its producer triggers from the new config;
 * a notifier that throws propagates to the caller.
 */
export async function setModuleConfig(
  moduleId: string,
  config: unknown,
  db: Knex = getDb(),
  notifier?: ModuleConfigNotifier
): Promise<void> {
  await db<ModuleConfigRow>("module_config")
    .insert({
      module_id: moduleId,
      config: JSON.stringify(config ?? {}),
      updated_at: Date.now(),
    })
    .onConflict("module_id")
    .merge();
  if (notifier) {
    await notifier.onConfigChanged(moduleId);
  }
}

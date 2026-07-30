import type { Knex } from "knex";

import { getDb } from "./db";

/**
 * Bring the database schema up to date. Idempotent: knex records applied
 * migrations, so a second call with no pending migrations is a no-op.
 */
export async function runMigrations(db: Knex = getDb()): Promise<void> {
  await db.migrate.latest();
}

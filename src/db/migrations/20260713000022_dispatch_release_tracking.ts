import type { Knex } from "knex";

/**
 * Track lease release state on dispatches so a failed release is never
 * abandoned. Two additive columns:
 *
 *   - `released_at`     — bigInteger, nullable. Timestamp (ms) when the lease
 *                         was successfully released. `null` means: either no
 *                         lease was ever created, or the release has not yet
 *                         succeeded. The periodic sweep queries dispatches
 *                         with `lease_id IS NOT NULL AND released_at IS NULL`
 *                         so a stuck release keeps trying.
 *   - `release_pending` — boolean, defaults false. Set to true when the
 *                         in-line finally-block retries were exhausted, so
 *                         the sweep knows to keep retrying. Cleared when the
 *                         sweep finally succeeds. (`released_at IS NULL` is
 *                         the actual sweep predicate; the flag is a display
 *                         hint and a way for the UI to surface leases stuck
 *                         needing release attention.)
 *
 * Adding nullable columns to sqlite does not rebuild the table, so no
 * foreign-key toggle is needed here.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("dispatches", (table) => {
    table.bigInteger("released_at").nullable();
    table.boolean("release_pending").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("dispatches", (table) => {
    table.dropColumn("released_at");
    table.dropColumn("release_pending");
  });
}

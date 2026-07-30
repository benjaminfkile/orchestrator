import type { Knex } from "knex";

/**
 * Drop the `kind` column from `notifiers` and `notification_log`. A notification
 * is now JUST a notification: there are no delivery kinds. Every fired notifier
 * always records one in-app log row AND best-effort raises a desktop toast, so
 * the mechanism no longer needs selecting per row.
 *
 * Existing rows survive: SQLite's column drop (via knex `dropColumn`) rebuilds
 * the table preserving all other columns and their data.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("notifiers", (table) => {
    table.dropColumn("kind");
  });
  await knex.schema.alterTable("notification_log", (table) => {
    table.dropColumn("kind");
  });
}

export async function down(knex: Knex): Promise<void> {
  // Restore the columns non-nullably. On a fresh rollback the tables are empty,
  // so a defaulted `kind` keeps the schema valid; the value carries no meaning.
  await knex.schema.alterTable("notifiers", (table) => {
    table.text("kind").notNullable().defaultTo("inbox");
  });
  await knex.schema.alterTable("notification_log", (table) => {
    table.text("kind").notNullable().defaultTo("inbox");
  });
}

import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // notifiers: user-built outbound sinks. `kind` selects a delivery mechanism
  // (e.g. "inbox"); `config` is an opaque JSON blob whose shape is defined by the
  // kind. The title/body templates are rendered against the triggering event with
  // the shared executor template engine. All intent lives in the name/templates —
  // no code branches on their content.
  await knex.schema.createTable("notifiers", (table) => {
    table.increments("id").primary();
    table.text("name").notNullable().unique();
    table.text("kind").notNullable();
    // config is a JSON object serialized to TEXT; the repo layer parses it.
    table.text("config").notNullable().defaultTo("{}");
    table.text("title_template").notNullable().defaultTo("");
    table.text("body_template").notNullable().defaultTo("");
    table.boolean("enabled").notNullable().defaultTo(true);
    table.bigInteger("created_at").notNullable();
    table.bigInteger("updated_at").notNullable();
  });

  // notification_log: the append-only delivery record backing the web inbox.
  // notifier_id/event_id are nullable and intentionally carry NO foreign-key
  // constraint: the log is a historical record that must survive deletion of the
  // originating notifier or event, so the ids are soft references only.
  await knex.schema.createTable("notification_log", (table) => {
    table.increments("id").primary();
    table.integer("notifier_id").nullable();
    table.integer("event_id").nullable();
    table.text("kind").notNullable();
    table.text("title").notNullable();
    table.text("body").notNullable();
    // status is 'delivered' | 'failed'. Kept as TEXT (no CHECK) so the repo layer
    // stays the source of truth for allowed values.
    table.text("status").notNullable();
    table.text("error").nullable();
    // read_at is null until the inbox marks the row read.
    table.bigInteger("read_at").nullable();
    table.bigInteger("created_at").notNullable();

    // (id) is the primary key; index read_at to make the unread filter/count cheap.
    table.index(["read_at"], "notification_log_read_at_idx");
  });

  // rules gain a notify list ([{notifier_id}] JSON) alongside dispatch. A rule may
  // carry dispatch targets, notify targets, or both.
  await knex.schema.alterTable("rules", (table) => {
    table.text("notify").notNullable().defaultTo("[]");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("rules", (table) => {
    table.dropColumn("notify");
  });
  await knex.schema.dropTableIfExists("notification_log");
  await knex.schema.dropTableIfExists("notifiers");
}

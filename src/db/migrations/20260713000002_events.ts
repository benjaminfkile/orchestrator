import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("events", (table) => {
    table.increments("id").primary();
    table.text("source").notNullable();
    table.text("type").notNullable();
    table.text("subject_kind").notNullable();
    table.text("subject_ref").notNullable();
    // payload is JSON serialized to TEXT; the repo layer parses it on read.
    table.text("payload").notNullable();
    table.text("dedupe_key").nullable();
    table.bigInteger("ts").notNullable();
    table.bigInteger("last_dispatched_at").nullable();
    table.bigInteger("cleared_at").nullable();

    table.index(["dedupe_key"], "events_dedupe_key_idx");
    table.index(["ts"], "events_ts_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("events");
}

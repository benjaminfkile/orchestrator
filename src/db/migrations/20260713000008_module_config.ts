import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("module_config", (table) => {
    table.text("module_id").primary();
    // config is an opaque JSON object serialized to TEXT; the repo layer parses
    // it on read. Defaults to an empty object so a row always holds valid JSON.
    table.text("config").notNullable().defaultTo("{}");
    table.bigInteger("updated_at").notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("module_config");
}

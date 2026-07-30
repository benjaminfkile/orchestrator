import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("rules", (table) => {
    table.increments("id").primary();
    table.text("name").notNullable();
    table.boolean("enabled").notNullable().defaultTo(true);
    // match is a JSON object ({source?, type?, criteria?}) serialized to TEXT;
    // the repo layer parses it on read.
    table.text("match").notNullable().defaultTo("{}");
    // dispatch is a JSON array ([{playbook_id, bindings?}]) serialized to TEXT.
    table.text("dispatch").notNullable().defaultTo("[]");
    table.bigInteger("created_at").notNullable();
    table.bigInteger("updated_at").notNullable();

    table.index(["enabled"], "rules_enabled_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("rules");
}

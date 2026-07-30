import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("playbooks", (table) => {
    table.increments("id").primary();
    table.text("name").notNullable().unique();
    table.text("image").notNullable();
    table.integer("ttl_seconds").notNullable();
    // resources is a JSON object ({cpus, memory_mb, pids}) serialized to TEXT.
    table.text("resources").notNullable().defaultTo("{}");
    table.text("network").notNullable().defaultTo("open");
    table.text("userdata_template").notNullable().defaultTo("");
    table.text("prompt_template").notNullable().defaultTo("");
    table.text("model").nullable();
    // allowed_tools is a JSON array of tool names serialized to TEXT, or null.
    table.text("allowed_tools").nullable();
    // env_requirements is a JSON array of required env var names.
    table.text("env_requirements").notNullable().defaultTo("[]");
    // steps is a JSON array of pre/post exec step descriptors.
    table.text("steps").notNullable().defaultTo("[]");
    table.text("output_kind").notNullable().defaultTo("findings");
    table.bigInteger("created_at").notNullable();
    table.bigInteger("updated_at").notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("playbooks");
}

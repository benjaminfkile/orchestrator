import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("runs", (table) => {
    table.increments("id").primary();
    table
      .integer("dispatch_id")
      .notNullable()
      .references("id")
      .inTable("dispatches");
    table.integer("exit_code").nullable();
    table.text("result_text").nullable();
    // usage is a JSON object (token/cost counters) serialized to TEXT, or null;
    // the repo layer parses it on read.
    table.text("usage").nullable();
    table.text("log_path").nullable();
    table.bigInteger("started_at").notNullable();
    table.bigInteger("ended_at").nullable();

    table.index(["dispatch_id"], "runs_dispatch_id_idx");
  });

  await knex.schema.createTable("findings", (table) => {
    table.increments("id").primary();
    table.integer("run_id").notNullable().references("id").inTable("runs");
    table.text("content").notNullable();
    // tags is a JSON array of strings serialized to TEXT.
    table.text("tags").notNullable().defaultTo("[]");
    table.text("visibility").notNullable().defaultTo("all");

    table.index(["run_id"], "findings_run_id_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("findings");
  await knex.schema.dropTableIfExists("runs");
}

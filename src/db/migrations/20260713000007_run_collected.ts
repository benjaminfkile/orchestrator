import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("runs", (table) => {
    // collected is a JSON object mapping a collect step's label to its captured
    // stdout, serialized to TEXT, or null when no collect step ran; the repo
    // layer parses it on read.
    table.text("collected").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("runs", (table) => {
    table.dropColumn("collected");
  });
}

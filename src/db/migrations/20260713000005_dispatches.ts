import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("dispatches", (table) => {
    table.increments("id").primary();
    table
      .integer("event_id")
      .notNullable()
      .references("id")
      .inTable("events");
    // rule_id is nullable: a dispatch may be created without an originating rule.
    table.integer("rule_id").nullable().references("id").inTable("rules");
    table
      .integer("playbook_id")
      .notNullable()
      .references("id")
      .inTable("playbooks");
    // status is one of queued|leasing|running|collecting|done|failed. Kept as a
    // TEXT column (no CHECK) so new states can be added without a migration; the
    // repo layer is the source of truth for the allowed values.
    table.text("status").notNullable().defaultTo("queued");
    table.text("lease_id").nullable();
    table.text("wisp_contract_id").nullable();
    table.integer("attempts").notNullable().defaultTo(0);
    table.text("error").nullable();
    table.bigInteger("created_at").notNullable();
    table.bigInteger("updated_at").notNullable();

    // (status, id) backs the FIFO claim: find the oldest row in a given status.
    table.index(["status", "id"], "dispatches_status_id_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("dispatches");
}

import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("playbooks", (table) => {
    // granted_capabilities is a JSON array of { capability_id, config? }
    // descriptors serialized to TEXT. Each entry names a registered capability
    // the playbook may invoke at dispatch time; the shape is opaque to the core.
    table.text("granted_capabilities").notNullable().defaultTo("[]");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("playbooks", (table) => {
    table.dropColumn("granted_capabilities");
  });
}

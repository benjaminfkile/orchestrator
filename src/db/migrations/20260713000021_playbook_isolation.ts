import type { Knex } from "knex";

/**
 * Give playbooks an optional per-playbook lease isolation level. The column is a
 * nullable TEXT: `null` means "let the wisper server apply its default"
 * ("shared"). Its value is an infrastructure knob (like `network`), never domain
 * intent — the core does not branch on it. In `v1` mode a non-null value is
 * checked against the selected host's advertised isolation levels before leasing
 * and sent to `POST /v1/leases`; `dev` mode ignores it. Adding a nullable column
 * does not rebuild the table, so no foreign-key toggle is needed here.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("playbooks", (table) => {
    table.text("isolation").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("playbooks", (table) => {
    table.dropColumn("isolation");
  });
}

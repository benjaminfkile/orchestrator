import type { Knex } from "knex";

/**
 * Give playbooks an optional per-playbook host selector. The column is a nullable
 * TEXT: `null` means "use the configured default host" (`WISPER_HOST_ID`). Its
 * value is opaque to the core — in `v1` mode it is resolved against the wisper
 * catalog (matching a host's id OR name) at dispatch time; in `dev` mode it is
 * used verbatim as the dev hostId. Adding a nullable column does not rebuild the
 * table, so no foreign-key toggle is needed here.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("playbooks", (table) => {
    table.text("host").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("playbooks", (table) => {
    table.dropColumn("host");
  });
}

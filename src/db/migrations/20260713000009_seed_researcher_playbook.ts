import type { Knex } from "knex";

// No-op. The former `researcher` playbook seed shipped only ready-to-use
// example content, not schema; product installs must start empty. Any leftover
// pristine `researcher` row from an install that previously ran this seed is
// removed by the 026 seed-content cleanup migration. This stub is retained
// so its name stays valid in the knex_migrations history of any database that
// already applied it.
export async function up(_knex: Knex): Promise<void> {}
export async function down(_knex: Knex): Promise<void> {}

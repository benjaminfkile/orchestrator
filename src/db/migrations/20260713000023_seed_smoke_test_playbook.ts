import type { Knex } from "knex";

// No-op. The former smoke-test seed shipped ready-to-use example content
// (playbook, dispatch rules, desktop notifier); product installs must start
// empty. The example content now lives in the explicit `npm run seed:smoke-test`
// command (see `scripts/seed-smoke-test.ts`). Any leftover pristine rows
// already inserted by an earlier run of this migration are removed by the 026
// seed-content cleanup migration. This stub is retained so its name stays
// valid in the knex_migrations history of any database that already applied it.
export async function up(_knex: Knex): Promise<void> {}
export async function down(_knex: Knex): Promise<void> {}

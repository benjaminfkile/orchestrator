import type { Knex } from "knex";

// No-op. This was a follow-up patch to the smoke-test seed row inserted by 023;
// with the seed itself removed there is nothing to patch. The example content
// lives in `scripts/seed-smoke-test.ts` and is installed by `npm run
// seed:smoke-test`. Any leftover pristine smoke-test row is removed by the
// 026 cleanup migration. This stub is retained so its name stays valid in
// the knex_migrations history of any database that already applied it.
export async function up(_knex: Knex): Promise<void> {}
export async function down(_knex: Knex): Promise<void> {}

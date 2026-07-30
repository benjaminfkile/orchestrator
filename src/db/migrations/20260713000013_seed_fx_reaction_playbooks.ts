import type { Knex } from "knex";

// No-op. Team-specific playbooks and rules are intentionally NOT committed to
// version control — they live only in the running instance, installed from a
// local (gitignored) setup script. This migration is retained as an empty stub
// so its name stays valid in the knex_migrations history of any database that
// already applied it.
export async function up(_knex: Knex): Promise<void> {}
export async function down(_knex: Knex): Promise<void> {}

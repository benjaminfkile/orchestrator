import type { Knex } from "knex";

/**
 * Clean up seed content that older versions of this app inserted into product
 * databases via migrations 009 (the `researcher` playbook) and 023/024/025
 * (the `smoke-test-clone-and-claude-linux` playbook, its dispatch and notify
 * rules, and the `desktop` notifier). Those migrations are now no-op stubs;
 * the smoke-test content lives in `scripts/seed-smoke-test.ts` and is
 * installed only by the explicit `npm run seed:smoke-test` command.
 *
 * A product install must come up empty. This migration deletes each seeded
 * row by its well-known name, but ONLY when the row is still byte-identical
 * to the seed: `updated_at === created_at` means the row has never been
 * written back through the repo layer, which bumps `updated_at` on every
 * write, so the user has not renamed or edited it. Any customized copy is
 * left untouched.
 *
 * Deletion order (a user-edited rule that still points at a removed playbook
 * or notifier is kept as-is; event intake fails closed on such a reference):
 *
 *   1. Seeded RULES first (their `notify` targets reference the notifier by
 *      `notifier_id`, their `dispatch` targets reference the playbook by
 *      `playbook_id`, both as JSON; no FK, but removing the rules first
 *      leaves nothing pointing at the sinks we are about to drop).
 *   2. Seeded NOTIFIER (`desktop`) if pristine.
 *   3. Seeded PLAYBOOKS (`smoke-test-clone-and-claude-linux`, and the
 *      long-superseded `researcher`) if pristine AND no `dispatches` row
 *      references them (the FK from `dispatches.playbook_id` to
 *      `playbooks.id` would otherwise trip).
 *
 * Rerunning the migration (e.g. after `down` then `latest()`) is a no-op:
 * anything that was deleted stays gone; anything the user has since edited
 * fails the pristine guard and is preserved.
 */

const RESEARCHER_NAME = "researcher";
const SMOKE_TEST_PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const DESKTOP_NOTIFIER_NAME = "desktop";

/** Every rule name the historical seed migrations inserted. */
const SEEDED_RULE_NAMES: readonly string[] = [
  "smoke test: ado.workitem.created",
  "smoke test: ado.workitem.updated",
  "smoke test: ado.workitem.tagged",
  "smoke test: ado.workitem.assigned",
  "smoke test: ado.workitem.state_changed",
  "smoke test: ado.workitem.area_changed",
  "smoke test: ado.workitem.iteration_changed",
  "Smoke test started",
  "Smoke test finished",
  "Smoke test failed",
];

interface TimestampedRow {
  id: number;
  created_at: number;
  updated_at: number;
}

/** True when the row's timestamps match, i.e. it has never been re-written. */
function isPristine(row: TimestampedRow | undefined): row is TimestampedRow {
  return !!row && row.updated_at === row.created_at;
}

async function deletePristineRules(knex: Knex): Promise<void> {
  for (const name of SEEDED_RULE_NAMES) {
    const row = await knex("rules").where({ name }).first<TimestampedRow>();
    if (!isPristine(row)) continue;
    await knex("rules").where({ id: row.id }).delete();
  }
}

async function deletePristineNotifier(knex: Knex): Promise<void> {
  const row = await knex("notifiers")
    .where({ name: DESKTOP_NOTIFIER_NAME })
    .first<TimestampedRow>();
  if (!isPristine(row)) return;
  await knex("notifiers").where({ id: row.id }).delete();
}

async function deletePristinePlaybook(
  knex: Knex,
  name: string
): Promise<void> {
  const row = await knex("playbooks").where({ name }).first<TimestampedRow>();
  if (!isPristine(row)) return;
  const referenced = await knex("dispatches")
    .where({ playbook_id: row.id })
    .first();
  if (referenced) return;
  await knex("playbooks").where({ id: row.id }).delete();
}

export async function up(knex: Knex): Promise<void> {
  await deletePristineRules(knex);
  await deletePristineNotifier(knex);
  await deletePristinePlaybook(knex, SMOKE_TEST_PLAYBOOK_NAME);
  await deletePristinePlaybook(knex, RESEARCHER_NAME);
}

export async function down(_knex: Knex): Promise<void> {
  // Deleted seed rows are not recreated on rollback: the seed no longer ships
  // in a migration at all, and re-inserting stale copies here would defeat
  // the whole point of removing them. Users who want the example content
  // back run `npm run seed:smoke-test`.
}

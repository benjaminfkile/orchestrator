import type { Knex } from "knex";

/**
 * Make the runner a playbook-level data choice. Replaces the claude-code-specific
 * `model` / `allowed_tools` columns with a generic pair:
 *
 *   - `runner`: the id of the registered runner that owns building the agent-step
 *     command and parsing its output. Defaults to `claude-code`, the sole runner
 *     at the time of this migration, so existing rows keep their behavior.
 *   - `runner_config`: an opaque JSON blob interpreted ONLY by the owning runner.
 *     For the claude-code runner it carries the same `{ model, allowed_tools }` the
 *     dropped columns held, so the effective invocation is byte-identical.
 *
 * Existing rows are backfilled before the old columns are dropped: each row's
 * `runner_config` becomes the JSON of `{ model, allowed_tools }` with null/absent
 * fields omitted (so a row that set neither ends up with `{}`), keeping the
 * claude-code runner's `narrowConfig` result identical to what it read from the
 * columns.
 */

/**
 * Run OUTSIDE knex's per-migration transaction. Dropping the claude-code columns
 * makes knex's SQLite driver REBUILD the playbooks table (create new -> copy ->
 * DROP old -> rename). On any real database with dispatches rows referencing
 * playbooks, that DROP trips `playbooks`'s foreign key (dispatches.playbook_id)
 * while `PRAGMA foreign_keys` is ON. The rebuild must therefore toggle the pragma
 * OFF around itself -- but `PRAGMA foreign_keys` is a NO-OP inside a transaction,
 * so this migration opts out of the wrapping transaction to make the toggle take.
 */
export const config = { transaction: false };

/** True for a non-null string. */
function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function up(knex: Knex): Promise<void> {
  // Disable FK enforcement for the duration of the rebuild. Effective only
  // because this migration runs outside a transaction (see `config` above).
  await knex.raw("PRAGMA foreign_keys = OFF");
  try {
    // Add the new columns with their table defaults first, so every existing row
    // is valid the instant the columns exist (runner=claude-code, runner_config={}).
    await knex.schema.alterTable("playbooks", (table) => {
      table.text("runner").notNullable().defaultTo("claude-code");
      // runner_config is an opaque JSON object serialized to TEXT, interpreted only
      // by the owning runner. Empty object == "no config".
      table.text("runner_config").notNullable().defaultTo("{}");
    });

    // Backfill: fold each row's model/allowed_tools into runner_config, omitting
    // null/absent fields. allowed_tools is stored as JSON TEXT (or null).
    const rows = await knex<{
      id: number;
      model: string | null;
      allowed_tools: string | null;
    }>("playbooks").select("id", "model", "allowed_tools");
    for (const row of rows) {
      const config: Record<string, unknown> = {};
      if (isNonEmpty(row.model)) {
        config.model = row.model;
      }
      if (isNonEmpty(row.allowed_tools)) {
        config.allowed_tools = JSON.parse(row.allowed_tools) as unknown;
      }
      await knex("playbooks")
        .where({ id: row.id })
        .update({ runner_config: JSON.stringify(config) });
    }

    // The claude-code specifics now live entirely in runner_config; drop the
    // columns. This is the table rebuild whose DROP would fail with FK on.
    await knex.schema.alterTable("playbooks", (table) => {
      table.dropColumn("model");
      table.dropColumn("allowed_tools");
    });

    // With FK enforcement off during the rebuild a corrupted copy could slip
    // through silently; verify integrity before this migration is recorded as
    // applied so a bad rebuild can never be committed.
    const violations = await knex.raw("PRAGMA foreign_key_check");
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error(
        `playbook_runner migration left foreign key violations: ${JSON.stringify(
          violations
        )}`
      );
    }
  } finally {
    await knex.raw("PRAGMA foreign_keys = ON");
  }
}

export async function down(knex: Knex): Promise<void> {
  // Same rebuild hazard as up(): dropping runner/runner_config rebuilds the
  // table, so toggle FK enforcement off around the whole body.
  await knex.raw("PRAGMA foreign_keys = OFF");
  try {
    // Restore the claude-code columns and unpack the claude-code runner's config
    // back into them. Rows using a different runner (none exist at this migration)
    // simply produce null columns.
    await knex.schema.alterTable("playbooks", (table) => {
      table.text("model").nullable();
      table.text("allowed_tools").nullable();
    });

    const rows = await knex<{
      id: number;
      runner: string;
      runner_config: string;
    }>("playbooks").select("id", "runner", "runner_config");
    for (const row of rows) {
      if (row.runner !== "claude-code") continue;
      const config = JSON.parse(row.runner_config) as Record<string, unknown>;
      const model = typeof config.model === "string" ? config.model : null;
      const allowed_tools = Array.isArray(config.allowed_tools)
        ? JSON.stringify(config.allowed_tools)
        : null;
      await knex("playbooks")
        .where({ id: row.id })
        .update({ model, allowed_tools });
    }

    await knex.schema.alterTable("playbooks", (table) => {
      table.dropColumn("runner");
      table.dropColumn("runner_config");
    });
  } finally {
    await knex.raw("PRAGMA foreign_keys = ON");
  }
}

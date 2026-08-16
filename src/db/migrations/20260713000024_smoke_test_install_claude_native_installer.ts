import type { Knex } from "knex";

/**
 * Follow-up to migration 023: replace the seeded
 * `smoke-test-clone-and-claude-linux` playbook's `install claude code` step
 * with a live-tested command that also works on minimal images that ship no
 * `node`/`npm`.
 *
 * The 023 seed assumed npm was already on PATH (the shipped runner image
 * carries node). Live-testing against a bare `dev-box` image on 2026-08-16
 * showed the assumption doesn't hold on every image and the naked
 * `npm install -g @anthropic-ai/claude-code` silently cannot run there.
 * The live-tested shape below:
 *
 *   1. exits fast if `claude` is already on PATH (idempotent re-runs stay cheap
 *      even when the image is pre-baked);
 *   2. uses `npm install -g` when npm exists (the existing shipped-image path);
 *   3. falls back to the CLI's official native installer
 *      (`curl https://claude.ai/install.sh | bash`) when npm is missing.
 *
 * The final `ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude` is
 * load-bearing: every wisp exec starts a fresh non-login `/bin/sh` process
 * (no shared env, cwd, or profile between execs), so any PATH export from
 * this step DOES NOT survive to the agent step. The binary must land on the
 * default PATH that later execs already see, or the agent step won't find it.
 *
 * ### Idempotency and safety
 *
 * The row is only rewritten when it still matches the 023 seed byte-for-byte:
 *
 *   - the playbook exists with the seeded name; AND
 *   - `updated_at === created_at` (never written back through the repo layer,
 *     which bumps `updated_at` on every write — so the user has not customized
 *     it in the UI); AND
 *   - the `install claude code` step's `command_template` is still exactly the
 *     023 shape (so a manual DB edit or a second application is a no-op).
 *
 * When the rewrite fires it keeps `updated_at === created_at`, preserving the
 * "still pristine seed" invariant so any FUTURE seed follow-up can also patch
 * the row under the same rule. Any customization survives untouched.
 */

const PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const INSTALL_STEP_LABEL = "install claude code";

/** The exact 023 seed's `command_template` for the install-claude step. */
const OLD_INSTALL_COMMAND = [
  "set -e",
  "if command -v claude >/dev/null 2>&1; then",
  '  echo "claude already on PATH; skipping install"',
  "  exit 0",
  "fi",
  "npm install -g @anthropic-ai/claude-code",
].join("\n");

/**
 * Live-tested install command. Written on one line to match the shape the
 * live smoke test exercised verbatim; `/bin/sh -c` handles it identically
 * to a multi-line form but keeping the exact bytes eliminates any doubt
 * about what actually shipped.
 */
export const NEW_INSTALL_COMMAND =
  'set -e; if command -v claude >/dev/null 2>&1; then claude --version; exit 0; fi; ' +
  'echo "node=$(command -v node || echo none) npm=$(command -v npm || echo none)"; ' +
  "if command -v npm >/dev/null 2>&1; then npm install -g @anthropic-ai/claude-code; " +
  "else echo 'no npm; using native installer'; " +
  "curl -fsSL https://claude.ai/install.sh | bash; " +
  'ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude; ' +
  "fi; command -v claude; claude --version";

interface StepRow {
  phase?: unknown;
  label?: unknown;
  command_template?: unknown;
}

/**
 * Rewrite the seeded install-claude step's `command_template` from `from` to
 * `to`, only when every seeded-state guard holds. Used by both `up` and
 * `down` (with the arguments swapped) so a rollback is symmetric.
 */
async function rewriteInstallStep(
  knex: Knex,
  from: string,
  to: string
): Promise<void> {
  const row = await knex("playbooks")
    .where({ name: PLAYBOOK_NAME })
    .first<{
      id: number;
      created_at: number;
      updated_at: number;
      steps: string;
    }>();
  if (!row) return;
  if (row.updated_at !== row.created_at) return;

  let steps: unknown;
  try {
    steps = JSON.parse(row.steps);
  } catch {
    return;
  }
  if (!Array.isArray(steps)) return;

  const stepArray = steps as StepRow[];
  const idx = stepArray.findIndex(
    (s) => s && typeof s === "object" && s.label === INSTALL_STEP_LABEL
  );
  if (idx < 0) return;

  const step = stepArray[idx];
  if (step.command_template !== from) return;

  const updated: StepRow[] = stepArray.slice();
  updated[idx] = { ...step, command_template: to };

  await knex("playbooks").where({ id: row.id }).update({
    steps: JSON.stringify(updated),
    // Preserve the pristine-seed invariant so future seed follow-ups can
    // recognize the row as still untouched.
    updated_at: row.created_at,
  });
}

export async function up(knex: Knex): Promise<void> {
  await rewriteInstallStep(knex, OLD_INSTALL_COMMAND, NEW_INSTALL_COMMAND);
}

export async function down(knex: Knex): Promise<void> {
  await rewriteInstallStep(knex, NEW_INSTALL_COMMAND, OLD_INSTALL_COMMAND);
}

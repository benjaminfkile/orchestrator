import type { Knex } from "knex";

/**
 * Follow-up to migrations 023/024: harden the seeded
 * `smoke-test-clone-and-claude-linux` playbook so every smoke run PROVES its
 * credential hygiene instead of trusting the scrub step in silence.
 *
 * Two seed patches applied together (both idempotent, both guard-gated):
 *
 *  1. **Fatal leak-hunt step.** Inserted IMMEDIATELY AFTER the scrub step and
 *     BEFORE the install-claude step. The step re-checks every place a leaked
 *     ADO_PAT could hide (process env, ~/.azure cache, git remote URL, git
 *     config auth headers, PAT content anywhere on disk) and `exit`s with the
 *     leak count — any leak fails the dispatch loudly rather than silently
 *     shipping a discoverable PAT to the agent.
 *
 *     The PAT itself reaches the check via server-side template substitution
 *     (`{{env.ADO_PAT}}`), matching the scrub/clone steps' delivery model:
 *     step-only secrets never enter the lease environment but ARE rendered
 *     into command_templates by the executor, and the executor's log
 *     redaction masks the value to `***` in dispatch logs. The earlier
 *     live-tested probe (see task #71) derived its fragment from an env var
 *     that no longer exists in the container — the disk grep degenerated to
 *     an empty pattern and matched every file. The seeded shape here fixes
 *     that AND guards the disk grep behind `[ -n "$FRAG" ]`: if template
 *     rendering ever yields an empty PAT the grep is skipped, not run with an
 *     empty pattern (which would either match everything or scan every path).
 *
 *  2. **`run.failed` notify rule.** The 023 seed shipped `run.started`/
 *     `run.completed` notify rules but no `run.failed` — so a fatal leak-hunt
 *     exit would fail silently on the desktop. This migration seeds a "Smoke
 *     test failed" rule (idempotent by name; only when the desktop notifier
 *     is still present) so a regression in scrubbing toasts loudly.
 *
 * ### Idempotency and safety
 *
 * Same discipline as 024: the playbook row is rewritten ONLY when it still
 * matches the seeded state byte-for-byte:
 *
 *   - the playbook exists with the seeded name; AND
 *   - `updated_at === created_at` (the row has never been written back through
 *     the repo layer, which bumps `updated_at` on every write — so the user
 *     has not customized it in the UI, and 024's rewrite preserved the
 *     invariant); AND
 *   - the `scrub credentials ...` step's `command_template` is still exactly
 *     the 023 shape (the anchor for insertion — a diverged scrub step means
 *     the user has edited the row through another mechanism); AND
 *   - no step with the leak-hunt label is already present (so a second
 *     application is a no-op).
 *
 * When the rewrite fires it keeps `updated_at === created_at`, preserving the
 * pristine-seed invariant so any FUTURE seed follow-up can also patch the row
 * under the same rule. Any customization survives untouched.
 */

const PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const NOTIFIER_NAME = "desktop";
const SCRUB_STEP_LABEL =
  "scrub credentials (step-only PAT never survives past this step)";
const LEAK_HUNT_STEP_LABEL =
  "hunt for credential leaks (fatal if the scrub or step-only injection regresses)";
const NOTIFY_FAILED_RULE = "Smoke test failed";

/**
 * The exact 023 seed's `command_template` for the scrub step. Used as the
 * anchor to prove the row still matches the seed shape before we splice a new
 * step in after it — a diverged scrub step means the user has edited the row
 * (through some means other than the repo layer) and this migration skips.
 */
const SEEDED_SCRUB_COMMAND = [
  "set -e",
  "cd ./work",
  "CLEAN=$(git config --get remote.origin.url | sed 's|https://[^@]*@|https://|')",
  'git remote set-url origin "$CLEAN"',
  "if git config --get remote.origin.url | grep -q '@'; then",
  '  echo "smoke test: remote URL still carries credentials after scrub" >&2',
  "  exit 1",
  "fi",
  'rm -rf "$HOME/.azure"',
].join("\n");

/**
 * The leak-hunt command. Kept on one line (identical `/bin/sh -c` semantics
 * to a multi-line form) to match how the live-tested probe was exercised
 * verbatim, and so the entire step is a single grep target in reviews.
 *
 * Load-bearing pieces:
 *   - `PAT='{{env.ADO_PAT}}'` — server-side substitution renders the PAT into
 *     the command text (single-quoted so no shell escapes inside the value
 *     are re-interpreted); the executor's `maskSecrets` masks the full value
 *     to `***` in dispatch logs.
 *   - Five checks: process env, `~/.azure`, git remote URL, git config auth
 *     header, disk grep for a 12-char PAT fragment. Each check bumps `LEAKS`
 *     on a hit and prints an unambiguous "LEAK: ..." line for the log.
 *   - `if [ -n "$FRAG" ]` — the empty-fragment guard. If template rendering
 *     ever yields an empty PAT the disk grep is SKIPPED entirely, never run
 *     with an empty pattern (which matches every line of every file and
 *     produces a garbage report).
 *   - `exit $LEAKS` — fatal. Any leak fails the dispatch, which the seeded
 *     `run.failed` notify rule below then surfaces as a desktop toast.
 */
export const LEAK_HUNT_COMMAND =
  "PAT='{{env.ADO_PAT}}'; LEAKS=0; " +
  "if env | grep -q '^ADO_PAT='; then echo 'LEAK: ADO_PAT in process environment'; LEAKS=1; else echo 'env: clean'; fi; " +
  'if [ -d "$HOME/.azure" ]; then echo \'LEAK: ~/.azure exists\'; LEAKS=1; else echo \'az cache: clean\'; fi; ' +
  "if git -C ./work remote get-url origin | grep -q '@'; then echo 'LEAK: credentials in git remote url'; LEAKS=1; else echo 'git remote: clean'; fi; " +
  "if git -C ./work config --list | grep -qi 'authorization\\|extraheader'; then echo 'LEAK: auth header in git config'; LEAKS=1; else echo 'git config: clean'; fi; " +
  'FRAG=$(printf \'%s\' "$PAT" | head -c 12); ' +
  'if [ -n "$FRAG" ]; then ' +
  'HITS=$(grep -rl "$FRAG" "$HOME" ./work 2>/dev/null | head -3); ' +
  'if [ -n "$HITS" ]; then echo "LEAK: PAT content on disk:"; echo "$HITS"; LEAKS=1; else echo \'disk: clean\'; fi; ' +
  "else echo 'disk: skipped (empty PAT fragment — template did not render)'; fi; " +
  'echo "leak_hunt_result=$LEAKS (0=clean)"; ' +
  "exit $LEAKS";

/** The new step object spliced into the seeded steps array. */
export const LEAK_HUNT_STEP = {
  phase: "pre",
  label: LEAK_HUNT_STEP_LABEL,
  command_template: LEAK_HUNT_COMMAND,
};

interface StepRow {
  phase?: unknown;
  label?: unknown;
  command_template?: unknown;
}

/**
 * Splice the leak-hunt step in immediately after the scrub step, only when
 * every seeded-state guard holds. Used by `up`; `down` removes any step whose
 * label matches, subject to the same guards.
 */
async function insertLeakHuntStep(knex: Knex): Promise<void> {
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
  const scrubIdx = stepArray.findIndex(
    (s) => s && typeof s === "object" && s.label === SCRUB_STEP_LABEL
  );
  if (scrubIdx < 0) return;
  if (stepArray[scrubIdx].command_template !== SEEDED_SCRUB_COMMAND) return;

  // Second application is a no-op: the leak-hunt step is already present.
  const alreadyPresent = stepArray.some(
    (s) => s && typeof s === "object" && s.label === LEAK_HUNT_STEP_LABEL
  );
  if (alreadyPresent) return;

  const updated: StepRow[] = [
    ...stepArray.slice(0, scrubIdx + 1),
    LEAK_HUNT_STEP,
    ...stepArray.slice(scrubIdx + 1),
  ];

  await knex("playbooks").where({ id: row.id }).update({
    steps: JSON.stringify(updated),
    updated_at: row.created_at,
  });
}

/**
 * Reverse of {@link insertLeakHuntStep}: remove any step whose label matches
 * the leak-hunt label. Same guards — only touches a pristine seeded row.
 */
async function removeLeakHuntStep(knex: Knex): Promise<void> {
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
  const filtered = stepArray.filter(
    (s) => !(s && typeof s === "object" && s.label === LEAK_HUNT_STEP_LABEL)
  );
  if (filtered.length === stepArray.length) return;

  await knex("playbooks").where({ id: row.id }).update({
    steps: JSON.stringify(filtered),
    updated_at: row.created_at,
  });
}

/**
 * Seed the "Smoke test failed" notify rule if it isn't already present. Skips
 * silently when the desktop notifier is absent (a user may have deleted it),
 * mirroring 023's seed rule behavior. Idempotent by name.
 */
async function seedFailedNotifyRule(knex: Knex): Promise<void> {
  const existing = await knex("rules")
    .where({ name: NOTIFY_FAILED_RULE })
    .first();
  if (existing) return;
  const notifier = await knex("notifiers")
    .where({ name: NOTIFIER_NAME })
    .first<{ id: number }>();
  if (!notifier) return;
  const now = Date.now();
  await knex("rules").insert({
    name: NOTIFY_FAILED_RULE,
    enabled: 1,
    match: JSON.stringify({
      source: "orchestrator",
      type: "run.failed",
      criteria: { playbook_name: PLAYBOOK_NAME },
    }),
    dispatch: JSON.stringify([]),
    notify: JSON.stringify([{ notifier_id: notifier.id }]),
    created_at: now,
    updated_at: now,
  });
}

export async function up(knex: Knex): Promise<void> {
  await insertLeakHuntStep(knex);
  await seedFailedNotifyRule(knex);
}

export async function down(knex: Knex): Promise<void> {
  await knex("rules").where({ name: NOTIFY_FAILED_RULE }).delete();
  await removeLeakHuntStep(knex);
}

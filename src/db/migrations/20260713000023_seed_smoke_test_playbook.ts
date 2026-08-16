import type { Knex } from "knex";

/**
 * Replace the seeded `researcher` playbook with the first-launch smoke test.
 *
 * The 009 seed shipped a GitHub-flavored `researcher` that required a
 * `GIT_TOKEN` secret; on an ADO-oriented install the UI immediately warns
 * about a secret the user never sets. This migration:
 *
 *  1. Removes the seeded `researcher` playbook ONLY when it still matches the
 *     seeded definition (name is `researcher`, `updated_at === created_at` —
 *     the row was never edited via the repo layer, which bumps `updated_at`
 *     on every write — AND no `dispatches` row references it, so the FK
 *     delete cannot fail and no run history is silently thrown away). A
 *     playbook a user customized or ran survives untouched.
 *  2. Seeds a `smoke-test-clone-and-claude-linux` playbook that proves the
 *     full pipeline (ADO auth, lease, package installs, network, claude
 *     runner, notifications) end-to-end on a bare Debian/Ubuntu image using
 *     `CLAUDE_CODE_OAUTH_TOKEN` (lease env) and `ADO_PAT` (step-only, so it
 *     never lands in the container environment for the agent to read).
 *  3. Seeds one rule per `ado.workitem.*` event type that matches when the
 *     work item carries the `smoke-test-clone-and-claude-linux` tag —
 *     tagging any work item and touching it in any way fires the playbook.
 *  4. Seeds a `desktop` notifier (idempotent by name) and two `orchestrator`
 *     rules that notify through it on the playbook's `run.started` and
 *     `run.completed` lifecycle events.
 *
 * Everything is skipped by name / by seeded-state guard so a re-application
 * (or a fresh DB that runs 009 immediately followed by this migration) ends
 * up with only the new content and never duplicates a row.
 */

const RESEARCHER_NAME = "researcher";
const PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const NOTIFIER_NAME = "desktop";
const NOTIFY_STARTED_RULE = "Smoke test started";
const NOTIFY_FINISHED_RULE = "Smoke test finished";

/** No-op userdata: the default lease image is prebaked, so nothing to install. */
const USERDATA_TEMPLATE = [
  "#!/bin/sh",
  "# The default lease image is prebaked; no provisioning is required.",
  "exit 0",
].join("\n");

/**
 * Install az (Debian/Ubuntu-family only, per the linux host assumption) and
 * git if either is missing. The default lease image already carries node per
 * the runner image contract, so we do not install it here.
 */
const STEP_INSTALL_AZ_CLI = [
  "set -e",
  "if ! command -v git >/dev/null 2>&1; then",
  "  apt-get update -qq && apt-get install -y -qq git",
  "fi",
  "if ! command -v az >/dev/null 2>&1; then",
  "  curl -sL https://aka.ms/InstallAzureCLIDeb | bash",
  "fi",
].join("\n");

/**
 * Derive ORG from `payload.api_url` (the fourth `/`-separated segment of
 * `https://dev.azure.com/<org>/...`) and PROJECT from `payload.area_path`
 * (the first `\`-separated segment — ADO area paths are `Project\Team\...`).
 * List the project's repositories with `az repos list` using ADO_PAT as the
 * PAT via `AZURE_DEVOPS_EXT_PAT`; take the first `remoteUrl`, strip any
 * embedded credential, and re-clone with `https://pat:<ADO_PAT>@<host+path>`
 * so the clone authenticates. Fails loudly (exit non-zero) when either
 * derivation is empty or the project has no repositories.
 */
const STEP_CLONE_FIRST_REPO = [
  "set -e",
  'AREA_PATH="{{payload.area_path}}"',
  'API_URL="{{payload.api_url}}"',
  "ORG=$(printf '%s' \"$API_URL\" | awk -F/ '{print $4}')",
  "PROJECT=$(printf '%s' \"$AREA_PATH\" | cut -d'\\' -f1)",
  'if [ -z "$ORG" ]; then',
  '  echo "smoke test: could not derive ORG from payload.api_url" >&2',
  "  exit 1",
  "fi",
  'if [ -z "$PROJECT" ]; then',
  '  echo "smoke test: could not derive PROJECT from payload.area_path" >&2',
  "  exit 1",
  "fi",
  "REPO_URL=$(AZURE_DEVOPS_EXT_PAT={{env.ADO_PAT}} az repos list \\",
  '  --organization "https://dev.azure.com/$ORG" \\',
  '  --project "$PROJECT" \\',
  '  --query "[0].remoteUrl" -o tsv)',
  'if [ -z "$REPO_URL" ]; then',
  '  echo "smoke test: no repositories found in project $PROJECT" >&2',
  "  exit 1",
  "fi",
  "HOSTPATH=$(printf '%s' \"$REPO_URL\" | sed -e 's|^https://[^/@]*@||' -e 's|^https://||')",
  'git clone "https://pat:{{env.ADO_PAT}}@$HOSTPATH" ./work',
].join("\n");

/**
 * ADO_PAT is a step-only secret, so it lives in NO subsequent exec's
 * environment (wisp runs each exec as a fresh process — no shared cwd or
 * env). All we need to do here is scrub anything that could carry a PAT on
 * disk: the git remote URL (rewritten to strip any embedded credential) and
 * the az CLI's on-disk token cache under `$HOME/.azure`. After this step
 * runs the container has no PAT anywhere.
 */
const STEP_SCRUB_CREDENTIALS = [
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
 * Install the claude CLI globally. The runner image contract ships node, so
 * npm is available. Skips gracefully when claude is already on PATH so a
 * pre-baked image does no extra work.
 */
const STEP_INSTALL_CLAUDE = [
  "set -e",
  "if command -v claude >/dev/null 2>&1; then",
  '  echo "claude already on PATH; skipping install"',
  "  exit 0",
  "fi",
  "npm install -g @anthropic-ai/claude-code",
].join("\n");

const SEED_STEPS = [
  {
    phase: "pre",
    label: "install azure cli",
    command_template: STEP_INSTALL_AZ_CLI,
  },
  {
    phase: "pre",
    label: "clone first repo in project",
    command_template: STEP_CLONE_FIRST_REPO,
  },
  {
    phase: "pre",
    label: "scrub credentials (step-only PAT never survives past this step)",
    command_template: STEP_SCRUB_CREDENTIALS,
  },
  {
    phase: "pre",
    label: "install claude code",
    command_template: STEP_INSTALL_CLAUDE,
  },
];

/**
 * ADO_PAT is delivered as `{name, inject: "step-only"}` so it renders into
 * the two pre-step command strings that need it (via `{{env.ADO_PAT}}`) but
 * never lands in the lease environment — the agent step running inside the
 * lease has no way to read the value out of its process env.
 */
const SEED_ENV_REQUIREMENTS: unknown[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  { name: "ADO_PAT", inject: "step-only" },
];

/** Every `ado.workitem.*` event type: any touch of a tagged item fires it. */
const SEED_EVENT_TYPES = [
  "ado.workitem.created",
  "ado.workitem.updated",
  "ado.workitem.tagged",
  "ado.workitem.assigned",
  "ado.workitem.state_changed",
  "ado.workitem.area_changed",
  "ado.workitem.iteration_changed",
];

const PROMPT_TEMPLATE = [
  "You are running inside a first-launch smoke test of the orchestrator pipeline.",
  "A repository has been cloned into ./work and its remote credentials have been",
  "scrubbed. Explore ./work and produce findings that explain what this",
  "repository is: its purpose, main components, and how it is built and run.",
  "Deliver the findings via one NOTES_TO_SAVE block. Never commit, push, or",
  "otherwise modify the remote — the credentials are gone by design.",
].join(" ");

/**
 * Remove the seeded researcher iff (a) `updated_at === created_at` — the row
 * has never been written back through the repo layer, so it is byte-identical
 * to the seed — AND (b) no dispatch row references it. Either condition being
 * false means a user has customized or exercised the playbook, so it is left
 * alone: never delete customized work, and never leave a dangling FK.
 */
async function maybeRemoveSeededResearcher(knex: Knex): Promise<void> {
  const row = await knex("playbooks")
    .where({ name: RESEARCHER_NAME })
    .first<{ id: number; created_at: number; updated_at: number }>();
  if (!row) return;
  if (row.updated_at !== row.created_at) return;
  const referenced = await knex("dispatches")
    .where({ playbook_id: row.id })
    .first();
  if (referenced) return;
  await knex("playbooks").where({ id: row.id }).delete();
}

async function seedSmokeTestPlaybook(knex: Knex): Promise<void> {
  const existing = await knex("playbooks")
    .where({ name: PLAYBOOK_NAME })
    .first();
  if (existing) return;
  const now = Date.now();
  await knex("playbooks").insert({
    name: PLAYBOOK_NAME,
    image: "setting:default_lease_image",
    host: null,
    isolation: null,
    ttl_seconds: 1800,
    resources: JSON.stringify({ cpus: 2, memory_mb: 4096 }),
    network: "open",
    userdata_template: USERDATA_TEMPLATE,
    prompt_template: PROMPT_TEMPLATE,
    runner: "claude-code",
    runner_config: JSON.stringify({}),
    env_requirements: JSON.stringify(SEED_ENV_REQUIREMENTS),
    steps: JSON.stringify(SEED_STEPS),
    granted_capabilities: JSON.stringify([]),
    output_kind: "findings",
    created_at: now,
    updated_at: now,
  });
}

/**
 * Seed one dispatch rule per ADO work-item event type. Each rule fires only
 * when the payload's `tags` array carries the playbook name — the ruleEngine
 * `contains` operator, applied to an array, checks membership — so tagging a
 * work item with `smoke-test-clone-and-claude-linux` opts it into every rule.
 * Skips existing rows by name so re-application is a no-op.
 */
async function seedDispatchRules(knex: Knex): Promise<void> {
  const playbook = await knex("playbooks")
    .where({ name: PLAYBOOK_NAME })
    .first<{ id: number }>();
  if (!playbook) return;

  for (const eventType of SEED_EVENT_TYPES) {
    const ruleName = `smoke test: ${eventType}`;
    const existing = await knex("rules").where({ name: ruleName }).first();
    if (existing) continue;
    const now = Date.now();
    await knex("rules").insert({
      name: ruleName,
      enabled: 1,
      match: JSON.stringify({
        source: "ado",
        type: eventType,
        criteria: { tags: { contains: PLAYBOOK_NAME } },
      }),
      dispatch: JSON.stringify([{ playbook_id: playbook.id }]),
      notify: JSON.stringify([]),
      created_at: now,
      updated_at: now,
    });
  }
}

/**
 * Ensure a desktop notifier exists so the notify rules below have a delivery
 * target. Since drop_notifier_kind (017), every notifier delivers as an
 * in-app log row + a best-effort desktop toast — no kind selection remains,
 * so the notifier is simply named `desktop`. Idempotent by name. Templates
 * follow the desktopNotify no-here-string rule automatically: they render
 * server-side and travel to the OS toast tool over stdin/argv, not shell.
 */
async function seedDesktopNotifier(knex: Knex): Promise<void> {
  const existing = await knex("notifiers")
    .where({ name: NOTIFIER_NAME })
    .first();
  if (existing) return;
  const now = Date.now();
  await knex("notifiers").insert({
    name: NOTIFIER_NAME,
    config: JSON.stringify({}),
    title_template: "{{payload.playbook_name}} — {{event.type}}",
    body_template: "{{event.subject_kind}} {{event.subject_ref}}",
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
}

/**
 * Seed the two notify rules — one on `run.started`, one on `run.completed` —
 * each keyed to the smoke-test playbook via the `orchestrator`-source
 * lifecycle events' `payload.playbook_name`. Both point at the seeded
 * desktop notifier. Skip by name so re-application is a no-op; skip
 * silently when the notifier is absent (a user may have deleted it).
 */
async function seedNotifyRules(knex: Knex): Promise<void> {
  const notifier = await knex("notifiers")
    .where({ name: NOTIFIER_NAME })
    .first<{ id: number }>();
  if (!notifier) return;

  const specs = [
    { name: NOTIFY_STARTED_RULE, type: "run.started" },
    { name: NOTIFY_FINISHED_RULE, type: "run.completed" },
  ];
  for (const spec of specs) {
    const existing = await knex("rules").where({ name: spec.name }).first();
    if (existing) continue;
    const now = Date.now();
    await knex("rules").insert({
      name: spec.name,
      enabled: 1,
      match: JSON.stringify({
        source: "orchestrator",
        type: spec.type,
        criteria: { playbook_name: PLAYBOOK_NAME },
      }),
      dispatch: JSON.stringify([]),
      notify: JSON.stringify([{ notifier_id: notifier.id }]),
      created_at: now,
      updated_at: now,
    });
  }
}

export async function up(knex: Knex): Promise<void> {
  await maybeRemoveSeededResearcher(knex);
  await seedSmokeTestPlaybook(knex);
  await seedDispatchRules(knex);
  await seedDesktopNotifier(knex);
  await seedNotifyRules(knex);
}

export async function down(knex: Knex): Promise<void> {
  const dispatchRuleNames = SEED_EVENT_TYPES.map((t) => `smoke test: ${t}`);
  await knex("rules").whereIn("name", dispatchRuleNames).delete();
  await knex("rules")
    .whereIn("name", [NOTIFY_STARTED_RULE, NOTIFY_FINISHED_RULE])
    .delete();
  await knex("notifiers").where({ name: NOTIFIER_NAME }).delete();

  const playbook = await knex("playbooks")
    .where({ name: PLAYBOOK_NAME })
    .first<{ id: number }>();
  if (playbook) {
    const referenced = await knex("dispatches")
      .where({ playbook_id: playbook.id })
      .first();
    if (!referenced) {
      await knex("playbooks").where({ id: playbook.id }).delete();
    }
  }
}

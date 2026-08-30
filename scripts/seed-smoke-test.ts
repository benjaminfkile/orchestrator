/**
 * Optional first-launch smoke-test seeder.
 *
 * Product installs come up empty; this script is the explicit opt-in that
 * installs a working end-to-end example: the `smoke-test-clone-and-claude-linux`
 * playbook, one dispatch rule per `ado.workitem.*` event type keyed to the
 * playbook name as a tag, the `desktop` notifier, and three notify rules
 * ("Smoke test started/finished/failed") on the playbook's `run.started`,
 * `run.completed`, and `run.failed` lifecycle events.
 *
 * Run it with `npm run seed:smoke-test`. It is idempotent by name: every row
 * is skipped when a row with the same name already exists, so re-running the
 * script never duplicates content and never overwrites a user's edits.
 *
 * It writes through the same repo layer the REST API uses (`createPlaybook`,
 * `createRule`, `createNotifier`), targeting the DB file the server would
 * open: the ORCH_DB_PATH env var (verbatim) when set, otherwise
 * `<ORCH_DATA_DIR|OS user-data>/orchestrator.sqlite`. It also runs migrations
 * on that DB first so a fresh install can be seeded without booting the app.
 */

import "dotenv/config";

import { createDb, resolveDbPath, setDb } from "../src/db/db";
import { runMigrations } from "../src/db/migrate";
import { createNotifier, listNotifiers } from "../src/db/notifiers";
import {
  createPlaybook,
  listPlaybooks,
} from "../src/db/playbooks";
import { createRule, listRules } from "../src/db/rules";
import type {
  EnvRequirement,
  NewPlaybook,
  NewRule,
} from "../src/interfaces";

const PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const NOTIFIER_NAME = "desktop";
const NOTIFY_STARTED_RULE = "Smoke test started";
const NOTIFY_FINISHED_RULE = "Smoke test finished";
const NOTIFY_FAILED_RULE = "Smoke test failed";

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
 * (the first `\`-separated segment; ADO area paths are `Project\Team\...`).
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
 * environment (wisp runs each exec as a fresh process; no shared cwd or
 * env). All we need to do here is scrub anything that could carry a PAT on
 * disk: the git remote URL (rewritten to strip any embedded credential) and
 * the az CLI's on-disk token cache under `$HOME/.azure`. After this step
 * runs the container has no PAT anywhere.
 */
export const STEP_SCRUB_CREDENTIALS = [
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
 *   - `PAT='{{env.ADO_PAT}}'`: server-side substitution renders the PAT into
 *     the command text (single-quoted so no shell escapes inside the value
 *     are re-interpreted); the executor's `maskSecrets` masks the full value
 *     to `***` in dispatch logs.
 *   - Five checks: process env, `~/.azure`, git remote URL, git config auth
 *     header, disk grep for a 12-char PAT fragment. Each check bumps `LEAKS`
 *     on a hit and prints an unambiguous "LEAK: ..." line for the log.
 *   - `if [ -n "$FRAG" ]`: the empty-fragment guard. If template rendering
 *     ever yields an empty PAT the disk grep is SKIPPED entirely, never run
 *     with an empty pattern (which matches every line of every file and
 *     produces a garbage report).
 *   - `exit $LEAKS`: fatal. Any leak fails the dispatch, which the seeded
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
  "else echo 'disk: skipped (empty PAT fragment; template did not render)'; fi; " +
  'echo "leak_hunt_result=$LEAKS (0=clean)"; ' +
  "exit $LEAKS";

/**
 * Install the claude CLI. Skips fast if it is already on PATH. Uses the
 * native installer when npm is missing so a minimal image without node/npm
 * still works; the final symlink into `/usr/local/bin` is load-bearing
 * because each wisp exec runs in a fresh non-login `/bin/sh` process, so a
 * PATH export from this step would not survive to the agent step.
 */
export const STEP_INSTALL_CLAUDE =
  'set -e; if command -v claude >/dev/null 2>&1; then claude --version; exit 0; fi; ' +
  'echo "node=$(command -v node || echo none) npm=$(command -v npm || echo none)"; ' +
  "if command -v npm >/dev/null 2>&1; then npm install -g @anthropic-ai/claude-code; " +
  "else echo 'no npm; using native installer'; " +
  "curl -fsSL https://claude.ai/install.sh | bash; " +
  'ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude; ' +
  "fi; command -v claude; claude --version";

export const SEED_STEPS = [
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
    label:
      "hunt for credential leaks (fatal if the scrub or step-only injection regresses)",
    command_template: LEAK_HUNT_COMMAND,
  },
  {
    phase: "pre",
    label: "install claude code",
    command_template: STEP_INSTALL_CLAUDE,
  },
];

/**
 * ADO_PAT is delivered as `{name, inject: "step-only"}` so it renders into
 * the pre-step command strings that need it (via `{{env.ADO_PAT}}`) but
 * never lands in the lease environment; the agent step running inside the
 * lease has no way to read the value out of its process env.
 */
export const SEED_ENV_REQUIREMENTS: EnvRequirement[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  { name: "ADO_PAT", inject: "step-only" },
];

/** Every `ado.workitem.*` event type: any touch of a tagged item fires it. */
export const SEED_EVENT_TYPES: readonly string[] = [
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
  "otherwise modify the remote (the credentials are gone by design).",
].join(" ");

export const SEED_PLAYBOOK: NewPlaybook = {
  name: PLAYBOOK_NAME,
  image: "setting:default_lease_image",
  host: null,
  isolation: null,
  ttl_seconds: 1800,
  resources: { cpus: 2, memory_mb: 4096 },
  network: "open",
  userdata_template: USERDATA_TEMPLATE,
  prompt_template: PROMPT_TEMPLATE,
  runner: "claude-code",
  runner_config: {},
  env_requirements: SEED_ENV_REQUIREMENTS,
  steps: SEED_STEPS,
  granted_capabilities: [],
  output_kind: "findings",
};

export const SEED_NOTIFIER = {
  name: NOTIFIER_NAME,
  config: {},
  title_template: "{{payload.playbook_name}} :: {{event.type}}",
  body_template: "{{event.subject_kind}} {{event.subject_ref}}",
  enabled: true,
};

/** What a single seed run created or found already present. */
export interface SeedReport {
  playbook_created: boolean;
  notifier_created: boolean;
  dispatch_rules_created: string[];
  dispatch_rules_skipped: string[];
  notify_rules_created: string[];
  notify_rules_skipped: string[];
}

/**
 * Idempotently seed the smoke-test example content into `db`. Every row is
 * skipped when a row with the same name already exists, so a second call is
 * a no-op regardless of what has been edited since. Returns a report so a
 * caller (this script's CLI entry, or a test) can assert what happened.
 */
export async function seedSmokeTest(
  db: import("knex").Knex
): Promise<SeedReport> {
  const report: SeedReport = {
    playbook_created: false,
    notifier_created: false,
    dispatch_rules_created: [],
    dispatch_rules_skipped: [],
    notify_rules_created: [],
    notify_rules_skipped: [],
  };

  const playbooks = await listPlaybooks(db);
  let playbook = playbooks.find((p) => p.name === PLAYBOOK_NAME);
  if (!playbook) {
    playbook = await createPlaybook(SEED_PLAYBOOK, db);
    report.playbook_created = true;
  }

  const notifiers = await listNotifiers(db);
  let notifier = notifiers.find((n) => n.name === NOTIFIER_NAME);
  if (!notifier) {
    notifier = await createNotifier(SEED_NOTIFIER, db);
    report.notifier_created = true;
  }

  const rules = await listRules(db);
  const rulesByName = new Map(rules.map((r) => [r.name, r]));

  for (const eventType of SEED_EVENT_TYPES) {
    const name = `smoke test: ${eventType}`;
    if (rulesByName.has(name)) {
      report.dispatch_rules_skipped.push(name);
      continue;
    }
    const rule: NewRule = {
      name,
      enabled: true,
      match: {
        source: "ado",
        type: eventType,
        criteria: { tags: { contains: PLAYBOOK_NAME } },
      },
      dispatch: [{ playbook_id: playbook.id }],
      notify: [],
    };
    await createRule(rule, db);
    report.dispatch_rules_created.push(name);
  }

  const notifySpecs: Array<{ name: string; type: string }> = [
    { name: NOTIFY_STARTED_RULE, type: "run.started" },
    { name: NOTIFY_FINISHED_RULE, type: "run.completed" },
    { name: NOTIFY_FAILED_RULE, type: "run.failed" },
  ];
  for (const spec of notifySpecs) {
    if (rulesByName.has(spec.name)) {
      report.notify_rules_skipped.push(spec.name);
      continue;
    }
    const rule: NewRule = {
      name: spec.name,
      enabled: true,
      match: {
        source: "orchestrator",
        type: spec.type,
        criteria: { playbook_name: PLAYBOOK_NAME },
      },
      dispatch: [],
      notify: [{ notifier_id: notifier.id }],
    };
    await createRule(rule, db);
    report.notify_rules_created.push(spec.name);
  }

  return report;
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = createDb(dbPath);
  // Bind the global DB used by the repo helpers so anything they touch
  // internally shares the same connection; tests that call seedSmokeTest
  // directly pass their own db and never rely on this binding.
  setDb(db);
  try {
    await runMigrations(db);
    const report = await seedSmokeTest(db);
    process.stdout.write(
      `seed-smoke-test: db=${dbPath}\n` +
        `  playbook  ${report.playbook_created ? "created" : "already present"}\n` +
        `  notifier  ${report.notifier_created ? "created" : "already present"}\n` +
        `  dispatch rules  created=${report.dispatch_rules_created.length} skipped=${report.dispatch_rules_skipped.length}\n` +
        `  notify rules    created=${report.notify_rules_created.length} skipped=${report.notify_rules_skipped.length}\n`
    );
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`seed-smoke-test: ${message}\n`);
    process.exit(1);
  });
}

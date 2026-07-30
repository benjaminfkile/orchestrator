import type { Knex } from "knex";

/**
 * Seed the built-in `researcher` playbook: an agent that clones the repository
 * named by a triggering event, explores it, and produces findings — never
 * writing back to the remote.
 *
 * The insert is idempotent: it is skipped when a playbook named `researcher`
 * already exists, so re-running it (or running it against a DB seeded by other
 * means) never duplicates the row.
 *
 * Per the architecture principle the playbook is pure data — the executor never
 * branches on any of these values. The image is stored as the indirect reference
 * `setting:default_lease_image`, resolved from `app_settings` at dispatch time so
 * the concrete image can be reconfigured without editing the playbook.
 */

const RESEARCHER_NAME = "researcher";

/** No-op userdata: the default image is prebaked, so nothing to provision. */
const USERDATA_TEMPLATE = [
  "#!/bin/sh",
  "# The default lease image is prebaked; no provisioning is required.",
  "exit 0",
].join("\n");

/**
 * The single `pre` step: clone the event's repository into ./work using the
 * injected GIT_TOKEN. Rendered with the same template engine as the prompt.
 */
const CLONE_STEP = {
  phase: "pre",
  label: "clone repository",
  command_template:
    "git clone https://x-access-token:{{env.GIT_TOKEN}}@{{payload.repo_url}} ./work",
};

const PROMPT_TEMPLATE = [
  "Explore the cloned repository in ./work as it relates to the triggering",
  "event ({{event.type}}, {{payload.title}}). Investigate and produce findings",
  "via NOTES_TO_SAVE. Never commit, push, or otherwise modify the remote.",
].join(" ");

export async function up(knex: Knex): Promise<void> {
  const existing = await knex("playbooks")
    .where({ name: RESEARCHER_NAME })
    .first();
  if (existing) return;

  const now = Date.now();
  await knex("playbooks").insert({
    name: RESEARCHER_NAME,
    image: "setting:default_lease_image",
    ttl_seconds: 3600,
    resources: JSON.stringify({ cpus: 2, memory_mb: 4096 }),
    network: "open",
    userdata_template: USERDATA_TEMPLATE,
    prompt_template: PROMPT_TEMPLATE,
    model: null,
    allowed_tools: null,
    env_requirements: JSON.stringify(["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN"]),
    steps: JSON.stringify([CLONE_STEP]),
    output_kind: "findings",
    created_at: now,
    updated_at: now,
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex("playbooks").where({ name: RESEARCHER_NAME }).delete();
}

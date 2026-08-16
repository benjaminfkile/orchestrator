import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";
import { listPlaybooks } from "../playbooks";

import { NEW_INSTALL_COMMAND } from "./20260713000024_smoke_test_install_claude_native_installer";

/** Every migration up to (but NOT including) the 024 install-claude follow-up. */
const LAST_PRE_024_MIGRATION = "20260713000023_seed_smoke_test_playbook";

const PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const INSTALL_STEP_LABEL = "install claude code";

/** The 023 seed's original install-claude command, replicated here verbatim. */
const OLD_INSTALL_COMMAND = [
  "set -e",
  "if command -v claude >/dev/null 2>&1; then",
  '  echo "claude already on PATH; skipping install"',
  "  exit 0",
  "fi",
  "npm install -g @anthropic-ai/claude-code",
].join("\n");

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-smoke-024-"));
  return path.join(dir, "test.sqlite");
}

/**
 * Bring the schema up through 023 (the smoke-test seed) but NOT through 024,
 * so the seeded row is present with the old install-claude command.
 */
async function migrateToJustBefore024(db: Knex): Promise<void> {
  for (;;) {
    const [, applied] = await db.migrate.up();
    if (applied.includes(LAST_PRE_024_MIGRATION)) return;
    if (applied.length === 0) {
      throw new Error("ran out of migrations before reaching pre-024 marker");
    }
  }
}

interface Step {
  phase: string;
  label: string;
  command_template: string;
}

async function installStep(db: Knex): Promise<Step | undefined> {
  const smoke = (await listPlaybooks(db)).find((p) => p.name === PLAYBOOK_NAME);
  if (!smoke) return undefined;
  const steps = smoke.steps as Step[];
  return steps.find((s) => s.label === INSTALL_STEP_LABEL);
}

describe("smoke-test install-claude native-installer migration (024)", () => {
  let file: string;
  let db: Knex;

  beforeEach(() => {
    file = tempDbFile();
    db = createDb(file);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("fresh DB (023 then 024 in one latest() pass)", () => {
    beforeEach(async () => {
      await runMigrations(db);
    });

    it("rewrites the seeded install-claude step to the native-installer shape", async () => {
      const step = await installStep(db);
      expect(step).toBeDefined();
      expect(step!.command_template).toBe(NEW_INSTALL_COMMAND);
    });

    it("carries the load-bearing pieces of the live-tested command", async () => {
      const cmd = (await installStep(db))!.command_template;
      // Fast idempotent short-circuit when claude is already on PATH.
      expect(cmd).toContain("command -v claude");
      // npm-first path (existing shipped-image case).
      expect(cmd).toContain("npm install -g @anthropic-ai/claude-code");
      // Native-installer fallback for images with no npm.
      expect(cmd).toContain("https://claude.ai/install.sh");
      // The symlink into a default PATH dir — each wisp exec is a fresh sh
      // process, so a PATH export here would not survive to the agent step.
      expect(cmd).toContain('ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude');
    });

    it("keeps the seed row pristine (updated_at === created_at)", async () => {
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      // The pristine-seed invariant must hold so any future seed follow-up
      // migration can still recognize this row as untouched.
      expect(smoke.updated_at).toBe(smoke.created_at);
    });

    it("leaves the other seeded steps untouched (labels + count unchanged)", async () => {
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      const steps = smoke.steps as Step[];
      // runMigrations applies everything through 025, which splices the
      // leak-hunt step between scrub and install-claude on the pristine seed.
      // The 024 rewrite is orthogonal to that splice — it only touches the
      // install-claude step's command_template, not the surrounding order.
      expect(steps.map((s) => s.label)).toEqual([
        "install azure cli",
        "clone first repo in project",
        "scrub credentials (step-only PAT never survives past this step)",
        "hunt for credential leaks (fatal if the scrub or step-only injection regresses)",
        "install claude code",
      ]);
    });

    it("env_requirements are exactly CLAUDE_CODE_OAUTH_TOKEN + step-only ADO_PAT (no IS_SANDBOX)", async () => {
      // The runner is what carries IS_SANDBOX=1 into the agent command; the
      // playbook must not list it or any workaround as an env requirement.
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      expect(smoke.env_requirements).toEqual([
        "CLAUDE_CODE_OAUTH_TOKEN",
        { name: "ADO_PAT", inject: "step-only" },
      ]);
    });

    it("is idempotent: a second migrate pass keeps the command stable", async () => {
      const before = (await installStep(db))!.command_template;
      await runMigrations(db);
      const after = (await installStep(db))!.command_template;
      expect(after).toBe(before);
    });
  });

  describe("upgraded DB: 024 applied on top of pre-024 state", () => {
    it("rewrites when the seeded row is untouched", async () => {
      await migrateToJustBefore024(db);
      const preStep = await installStep(db);
      expect(preStep).toBeDefined();
      expect(preStep!.command_template).toBe(OLD_INSTALL_COMMAND);

      await runMigrations(db);

      const postStep = await installStep(db);
      expect(postStep!.command_template).toBe(NEW_INSTALL_COMMAND);
    });

    it("skips when the user has customized the row (updated_at !== created_at)", async () => {
      await migrateToJustBefore024(db);
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      // Simulate a UI edit that bumped updated_at.
      await db("playbooks")
        .where({ id: smoke.id })
        .update({ ttl_seconds: 42, updated_at: smoke.updated_at + 1 });

      await runMigrations(db);

      const post = (await installStep(db))!.command_template;
      expect(post).toBe(OLD_INSTALL_COMMAND);
      const postRow = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      expect(postRow.ttl_seconds).toBe(42);
    });

    it("skips when the install-claude command has diverged from the 023 seed", async () => {
      await migrateToJustBefore024(db);
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      const steps = smoke.steps as Step[];
      const idx = steps.findIndex((s) => s.label === INSTALL_STEP_LABEL);
      const custom = "echo custom install";
      const patched = steps.slice();
      patched[idx] = { ...steps[idx], command_template: custom };
      // Write the customized steps back WITHOUT bumping updated_at, to prove
      // the second guard (command must still match the seed) is independent.
      await db("playbooks")
        .where({ id: smoke.id })
        .update({ steps: JSON.stringify(patched) });

      await runMigrations(db);

      const post = (await installStep(db))!.command_template;
      expect(post).toBe(custom);
    });

    it("no-op when the seeded playbook doesn't exist at all", async () => {
      await migrateToJustBefore024(db);
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      await db("playbooks").where({ id: smoke.id }).delete();

      await expect(runMigrations(db)).resolves.not.toThrow();
      const post = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      );
      expect(post).toBeUndefined();
    });
  });

  describe("down migration", () => {
    it("restores the 023 install command byte-for-byte", async () => {
      await runMigrations(db);
      expect((await installStep(db))!.command_template).toBe(
        NEW_INSTALL_COMMAND
      );

      await db.migrate.down({
        name: "20260713000024_smoke_test_install_claude_native_installer",
      });

      expect((await installStep(db))!.command_template).toBe(
        OLD_INSTALL_COMMAND
      );
    });
  });
});

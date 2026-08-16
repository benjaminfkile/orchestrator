import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../db";
import { runMigrations } from "../migrate";
import { listPlaybooks } from "../playbooks";
import { listRules } from "../rules";

import {
  LEAK_HUNT_COMMAND,
  LEAK_HUNT_STEP,
} from "./20260713000025_smoke_test_credential_leak_hunt";

/** Every migration up to (but NOT including) the 025 leak-hunt follow-up. */
const LAST_PRE_025_MIGRATION =
  "20260713000024_smoke_test_install_claude_native_installer";

const PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const SCRUB_STEP_LABEL =
  "scrub credentials (step-only PAT never survives past this step)";
const INSTALL_STEP_LABEL = "install claude code";
const LEAK_HUNT_STEP_LABEL = LEAK_HUNT_STEP.label;
const NOTIFY_FAILED_RULE = "Smoke test failed";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-smoke-025-"));
  return path.join(dir, "test.sqlite");
}

/**
 * Bring the schema up through 024 but NOT through 025, so the seeded playbook
 * is present in its post-024 shape (native-installer install-claude, four
 * pre steps, no leak-hunt step yet).
 */
async function migrateToJustBefore025(db: Knex): Promise<void> {
  for (;;) {
    const [, applied] = await db.migrate.up();
    if (applied.includes(LAST_PRE_025_MIGRATION)) return;
    if (applied.length === 0) {
      throw new Error("ran out of migrations before reaching pre-025 marker");
    }
  }
}

interface Step {
  phase: string;
  label: string;
  command_template: string;
}

async function loadSteps(db: Knex): Promise<Step[]> {
  const smoke = (await listPlaybooks(db)).find((p) => p.name === PLAYBOOK_NAME);
  if (!smoke) throw new Error("seeded smoke-test playbook missing");
  return smoke.steps as Step[];
}

/**
 * Render the seeded `{{env.ADO_PAT}}` template token into a concrete PAT for
 * shell testing. Server-side substitution the executor performs is a
 * literal-string replace, so a plain replaceAll is faithful enough for a
 * unit test that just wants to run the resolved command.
 */
function renderPat(pat: string): string {
  return LEAK_HUNT_COMMAND.replace(/\{\{env\.ADO_PAT\}\}/g, pat);
}

/**
 * Run the rendered leak-hunt command under a scratch HOME + a fake ./work
 * git repo, so the checks that inspect $HOME/.azure and the git remote have
 * something realistic to look at. Returns the exit code + stdout so tests
 * can assert on the "LEAK: ..." lines directly.
 */
function runLeakHunt(
  scenario: {
    pat: string;
    envHasPat?: boolean;
    azureCache?: boolean;
    dirtyRemote?: boolean;
    authHeader?: boolean;
    patOnDisk?: boolean;
  }
): { code: number; stdout: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-025-work-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-025-home-"));
  try {
    // Set up a git repo under $workDir/work — the checks reference `./work`.
    const work = path.join(workDir, "work");
    fs.mkdirSync(work, { recursive: true });
    // `git -C ./work` needs a real repo; `git init` is enough. Use env HOME
    // so git doesn't pick up the running user's global config (which could
    // itself carry an authorization header and pollute the check).
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: homeDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    if (scenario.envHasPat) env.ADO_PAT = scenario.pat;
    const runSh = (cmd: string) =>
      spawnSync("sh", ["-c", cmd], { env, cwd: workDir, encoding: "utf8" });
    const init = runSh(`git init -q "${work}"`);
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    const remoteUrl = scenario.dirtyRemote
      ? `https://pat:${scenario.pat}@example.com/repo.git`
      : "https://example.com/repo.git";
    const addRemote = runSh(
      `git -C "${work}" remote add origin "${remoteUrl}"`
    );
    if (addRemote.status !== 0) throw new Error(addRemote.stderr);
    if (scenario.authHeader) {
      const set = runSh(
        `git -C "${work}" config http.https://example.com/.extraheader "AUTHORIZATION: bearer x"`
      );
      if (set.status !== 0) throw new Error(set.stderr);
    }
    if (scenario.azureCache) {
      fs.mkdirSync(path.join(homeDir, ".azure"), { recursive: true });
    }
    if (scenario.patOnDisk) {
      fs.writeFileSync(path.join(work, "leaked.txt"), scenario.pat);
    }

    const rendered = renderPat(scenario.pat);
    const result = spawnSync("sh", ["-c", rendered], {
      env,
      cwd: workDir,
      encoding: "utf8",
    });
    return { code: result.status ?? -1, stdout: result.stdout };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

describe("smoke-test credential-leak-hunt migration (025)", () => {
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

  describe("fresh DB (023-024-025 in one latest() pass)", () => {
    beforeEach(async () => {
      await runMigrations(db);
    });

    it("splices the leak-hunt step immediately after the scrub step", async () => {
      const labels = (await loadSteps(db)).map((s) => s.label);
      expect(labels).toEqual([
        "install azure cli",
        "clone first repo in project",
        SCRUB_STEP_LABEL,
        LEAK_HUNT_STEP_LABEL,
        INSTALL_STEP_LABEL,
      ]);
    });

    it("seeds the leak-hunt step with the expected command shape", async () => {
      const step = (await loadSteps(db)).find(
        (s) => s.label === LEAK_HUNT_STEP_LABEL
      )!;
      expect(step.phase).toBe("pre");
      // PAT reaches the step via server-side template substitution.
      expect(step.command_template).toContain("{{env.ADO_PAT}}");
      // Empty-fragment guard: never a bare `grep ""` scan.
      expect(step.command_template).toContain('if [ -n "$FRAG" ]');
      // Fatal exit code = leak count.
      expect(step.command_template).toContain("exit $LEAKS");
      // Every leak-check anchor is present so a future reader can grep.
      expect(step.command_template).toContain("ADO_PAT in process environment");
      expect(step.command_template).toContain("~/.azure exists");
      expect(step.command_template).toContain("credentials in git remote url");
      expect(step.command_template).toContain("auth header in git config");
      expect(step.command_template).toContain("PAT content on disk");
    });

    it("keeps the seed row pristine (updated_at === created_at)", async () => {
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      // Preserving this invariant lets any future seed follow-up recognize
      // the row as still-pristine and patch it under the same rule.
      expect(smoke.updated_at).toBe(smoke.created_at);
    });

    it("seeds a Smoke test failed notify rule pointing at the desktop notifier", async () => {
      const rules = await listRules(db);
      const failed = rules.find((r) => r.name === NOTIFY_FAILED_RULE);
      expect(failed).toBeDefined();
      expect(failed!.enabled).toBe(true);
      expect(failed!.match.source).toBe("orchestrator");
      expect(failed!.match.type).toBe("run.failed");
      expect(failed!.match.criteria).toEqual({ playbook_name: PLAYBOOK_NAME });
      expect(failed!.dispatch).toEqual([]);
      expect(failed!.notify).toHaveLength(1);
      expect(failed!.notify[0]).toEqual({
        notifier_id: expect.any(Number),
      });
    });

    it("is idempotent: a second migrate pass adds no rows", async () => {
      const before = {
        playbooks: (await listPlaybooks(db)).length,
        rules: (await listRules(db)).length,
        steps: (await loadSteps(db)).length,
      };
      await runMigrations(db);
      const after = {
        playbooks: (await listPlaybooks(db)).length,
        rules: (await listRules(db)).length,
        steps: (await loadSteps(db)).length,
      };
      expect(after).toEqual(before);
    });
  });

  describe("upgraded DB: 025 applied on top of pre-025 state", () => {
    it("splices when the seeded row is untouched", async () => {
      await migrateToJustBefore025(db);
      const preLabels = (await loadSteps(db)).map((s) => s.label);
      expect(preLabels).not.toContain(LEAK_HUNT_STEP_LABEL);

      await runMigrations(db);

      const postLabels = (await loadSteps(db)).map((s) => s.label);
      expect(postLabels.indexOf(LEAK_HUNT_STEP_LABEL)).toBe(
        postLabels.indexOf(SCRUB_STEP_LABEL) + 1
      );
      expect(postLabels.indexOf(LEAK_HUNT_STEP_LABEL)).toBeLessThan(
        postLabels.indexOf(INSTALL_STEP_LABEL)
      );
    });

    it("skips when the user has customized the row (updated_at !== created_at)", async () => {
      await migrateToJustBefore025(db);
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      await db("playbooks")
        .where({ id: smoke.id })
        .update({ ttl_seconds: 42, updated_at: smoke.updated_at + 1 });

      await runMigrations(db);

      const labels = (await loadSteps(db)).map((s) => s.label);
      expect(labels).not.toContain(LEAK_HUNT_STEP_LABEL);
    });

    it("skips when the scrub step's command_template has diverged from the seed", async () => {
      await migrateToJustBefore025(db);
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      const steps = smoke.steps as Step[];
      const idx = steps.findIndex((s) => s.label === SCRUB_STEP_LABEL);
      const patched = steps.slice();
      patched[idx] = { ...steps[idx], command_template: "echo custom scrub" };
      // Write the customized steps back WITHOUT bumping updated_at, so the
      // second guard (scrub command must still match the seed) is proven
      // independent of the pristine-row guard.
      await db("playbooks")
        .where({ id: smoke.id })
        .update({ steps: JSON.stringify(patched) });

      await runMigrations(db);

      const labels = (await loadSteps(db)).map((s) => s.label);
      expect(labels).not.toContain(LEAK_HUNT_STEP_LABEL);
    });

    it("no-op when the seeded playbook doesn't exist at all", async () => {
      await migrateToJustBefore025(db);
      const smoke = (await listPlaybooks(db)).find(
        (p) => p.name === PLAYBOOK_NAME
      )!;
      await db("playbooks").where({ id: smoke.id }).delete();

      await expect(runMigrations(db)).resolves.not.toThrow();
      expect(
        (await listPlaybooks(db)).find((p) => p.name === PLAYBOOK_NAME)
      ).toBeUndefined();
    });

    it("keeps an existing Smoke test failed rule instead of duplicating it", async () => {
      await migrateToJustBefore025(db);
      const notifier = await db("notifiers")
        .where({ name: "desktop" })
        .first<{ id: number }>();
      const now = Date.now();
      await db("rules").insert({
        name: NOTIFY_FAILED_RULE,
        enabled: 0,
        match: JSON.stringify({ source: "custom", type: "custom" }),
        dispatch: JSON.stringify([]),
        notify: JSON.stringify([{ notifier_id: notifier!.id }]),
        created_at: now,
        updated_at: now,
      });

      await runMigrations(db);

      const rules = (await listRules(db)).filter(
        (r) => r.name === NOTIFY_FAILED_RULE
      );
      expect(rules).toHaveLength(1);
      // The pre-existing row is preserved verbatim — the seeder skips by name.
      expect(rules[0].enabled).toBe(false);
      expect(rules[0].match.source).toBe("custom");
    });
  });

  describe("down migration", () => {
    it("removes the leak-hunt step and the run.failed rule", async () => {
      await runMigrations(db);
      const preLabels = (await loadSteps(db)).map((s) => s.label);
      expect(preLabels).toContain(LEAK_HUNT_STEP_LABEL);

      await db.migrate.down({
        name: "20260713000025_smoke_test_credential_leak_hunt",
      });

      const postLabels = (await loadSteps(db)).map((s) => s.label);
      expect(postLabels).not.toContain(LEAK_HUNT_STEP_LABEL);
      const rules = await listRules(db);
      expect(rules.find((r) => r.name === NOTIFY_FAILED_RULE)).toBeUndefined();
    });
  });

  describe("shell semantics of the seeded step", () => {
    // The step ships as a single sh -c string. These tests verify the actual
    // exit-code contract — the whole point of this migration is that a leak
    // FAILS the dispatch, so a broken exit here would defeat the purpose.

    it("exits 0 on a fully clean container", () => {
      const { code, stdout } = runLeakHunt({ pat: "abcdefghijkl-secret-pat" });
      expect(code).toBe(0);
      expect(stdout).toContain("env: clean");
      expect(stdout).toContain("az cache: clean");
      expect(stdout).toContain("git remote: clean");
      expect(stdout).toContain("git config: clean");
      expect(stdout).toContain("disk: clean");
      expect(stdout).toContain("leak_hunt_result=0 (0=clean)");
    });

    it("exits non-zero when ADO_PAT lingers in the process env", () => {
      const { code, stdout } = runLeakHunt({
        pat: "abcdefghijkl-secret-pat",
        envHasPat: true,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain("LEAK: ADO_PAT in process environment");
    });

    it("exits non-zero when ~/.azure survived the scrub", () => {
      const { code, stdout } = runLeakHunt({
        pat: "abcdefghijkl-secret-pat",
        azureCache: true,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain("LEAK: ~/.azure exists");
    });

    it("exits non-zero when the git remote url still carries credentials", () => {
      const { code, stdout } = runLeakHunt({
        pat: "abcdefghijkl-secret-pat",
        dirtyRemote: true,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain("LEAK: credentials in git remote url");
    });

    it("exits non-zero when an authorization header is set in git config", () => {
      const { code, stdout } = runLeakHunt({
        pat: "abcdefghijkl-secret-pat",
        authHeader: true,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain("LEAK: auth header in git config");
    });

    it("exits non-zero when the PAT content appears on disk", () => {
      const { code, stdout } = runLeakHunt({
        pat: "abcdefghijkl-secret-pat",
        patOnDisk: true,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain("LEAK: PAT content on disk:");
    });

    it("skips the disk grep (never runs `grep ''`) when the PAT fragment is empty", () => {
      // Simulates the template rendering to an empty string. The disk grep
      // must be SKIPPED — the earlier live-tested probe's bug was deriving
      // the fragment from a missing env var, which yielded an empty pattern
      // that then matched every file. This assertion is the regression guard.
      const { code, stdout } = runLeakHunt({ pat: "" });
      expect(code).toBe(0);
      expect(stdout).toContain(
        "disk: skipped (empty PAT fragment — template did not render)"
      );
      expect(stdout).not.toContain("disk: clean");
      expect(stdout).not.toContain("LEAK: PAT content on disk:");
    });
  });
});

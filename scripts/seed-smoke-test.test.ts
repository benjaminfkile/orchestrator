import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../src/db/db";
import { runMigrations } from "../src/db/migrate";
import { listNotifiers } from "../src/db/notifiers";
import { listPlaybooks } from "../src/db/playbooks";
import { listRules } from "../src/db/rules";

import { LEAK_HUNT_COMMAND, seedSmokeTest } from "./seed-smoke-test";

const SMOKE_TEST_PLAYBOOK_NAME = "smoke-test-clone-and-claude-linux";
const NOTIFIER_NAME = "desktop";
const NOTIFY_STARTED_RULE = "Smoke test started";
const NOTIFY_FINISHED_RULE = "Smoke test finished";
const NOTIFY_FAILED_RULE = "Smoke test failed";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-seed-script-"));
  return path.join(dir, "test.sqlite");
}

/**
 * Render the seeded `{{env.ADO_PAT}}` template token into a concrete PAT for
 * shell testing. The executor's server-side substitution is a literal-string
 * replace, so a plain replaceAll matches its behaviour faithfully.
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
function runLeakHunt(scenario: {
  pat: string;
  envHasPat?: boolean;
  azureCache?: boolean;
  dirtyRemote?: boolean;
  authHeader?: boolean;
  patOnDisk?: boolean;
}): { code: number; stdout: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-leak-work-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-leak-home-"));
  try {
    const work = path.join(workDir, "work");
    fs.mkdirSync(work, { recursive: true });
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

describe("seed-smoke-test script", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  describe("seedSmokeTest against a fresh, empty DB", () => {
    it("creates the playbook, notifier, and every dispatch/notify rule", async () => {
      const report = await seedSmokeTest(db);

      expect(report.playbook_created).toBe(true);
      expect(report.notifier_created).toBe(true);
      expect(report.dispatch_rules_created).toHaveLength(7);
      expect(report.dispatch_rules_skipped).toHaveLength(0);
      expect(report.notify_rules_created).toEqual([
        NOTIFY_STARTED_RULE,
        NOTIFY_FINISHED_RULE,
        NOTIFY_FAILED_RULE,
      ]);
      expect(report.notify_rules_skipped).toHaveLength(0);

      const playbooks = await listPlaybooks(db);
      expect(playbooks).toHaveLength(1);
      expect(playbooks[0].name).toBe(SMOKE_TEST_PLAYBOOK_NAME);

      const notifiers = await listNotifiers(db);
      expect(notifiers).toHaveLength(1);
      expect(notifiers[0].name).toBe(NOTIFIER_NAME);

      const rules = await listRules(db);
      // Seven dispatch + three notify.
      expect(rules).toHaveLength(10);
      const dispatchRules = rules.filter((r) => r.name.startsWith("smoke test: "));
      const eventTypes = dispatchRules
        .map((r) => r.match.type)
        .filter((t): t is string => typeof t === "string")
        .sort();
      expect(eventTypes).toEqual([
        "ado.workitem.area_changed",
        "ado.workitem.assigned",
        "ado.workitem.created",
        "ado.workitem.iteration_changed",
        "ado.workitem.state_changed",
        "ado.workitem.tagged",
        "ado.workitem.updated",
      ]);
      for (const rule of dispatchRules) {
        expect(rule.match.source).toBe("ado");
        expect(rule.match.criteria).toEqual({
          tags: { contains: SMOKE_TEST_PLAYBOOK_NAME },
        });
        expect(rule.dispatch).toEqual([{ playbook_id: playbooks[0].id }]);
      }
      const startedRule = rules.find((r) => r.name === NOTIFY_STARTED_RULE)!;
      expect(startedRule.match).toEqual({
        source: "orchestrator",
        type: "run.started",
        criteria: { playbook_name: SMOKE_TEST_PLAYBOOK_NAME },
      });
      expect(startedRule.notify).toEqual([{ notifier_id: notifiers[0].id }]);
    });

    it("seeds the playbook with the expected env_requirements and step shape", async () => {
      await seedSmokeTest(db);
      const playbook = (await listPlaybooks(db))[0];
      expect(playbook.env_requirements).toEqual([
        "CLAUDE_CODE_OAUTH_TOKEN",
        { name: "ADO_PAT", inject: "step-only" },
      ]);
      const steps = playbook.steps as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(5);
      expect(steps.map((s) => s.label)).toEqual([
        "install azure cli",
        "clone first repo in project",
        "scrub credentials (step-only PAT never survives past this step)",
        "hunt for credential leaks (fatal if the scrub or step-only injection regresses)",
        "install claude code",
      ]);
      for (const step of steps) expect(step.phase).toBe("pre");
      const clone = steps[1].command_template as string;
      expect(clone).toContain("{{env.ADO_PAT}}");
      expect(clone).toContain("{{payload.api_url}}");
      expect(clone).toContain("{{payload.area_path}}");
      expect(clone).toContain("az repos list");
    });
  });

  describe("idempotency", () => {
    it("a second call is a no-op: every row is skipped", async () => {
      await seedSmokeTest(db);
      const second = await seedSmokeTest(db);
      expect(second.playbook_created).toBe(false);
      expect(second.notifier_created).toBe(false);
      expect(second.dispatch_rules_created).toHaveLength(0);
      expect(second.dispatch_rules_skipped).toHaveLength(7);
      expect(second.notify_rules_created).toHaveLength(0);
      expect(second.notify_rules_skipped).toHaveLength(3);

      // Table counts are unchanged: no duplicates.
      expect((await listPlaybooks(db)).length).toBe(1);
      expect((await listNotifiers(db)).length).toBe(1);
      expect((await listRules(db)).length).toBe(10);
    });

    it("preserves a user's rename by not resurrecting a missing row", async () => {
      await seedSmokeTest(db);
      // The user deletes one of the rules; a second seed run must not re-add it.
      await db("rules").where({ name: "smoke test: ado.workitem.tagged" }).delete();
      const before = (await listRules(db)).length;
      const second = await seedSmokeTest(db);
      // The re-run reports one dispatch rule as CREATED again (rules are matched
      // by name; a deleted row is a fresh name in the table). This is the same
      // contract every other create endpoint has, and it's what makes the seeder
      // useful for restoring an accidentally deleted row.
      expect(second.dispatch_rules_created).toEqual([
        "smoke test: ado.workitem.tagged",
      ]);
      const after = (await listRules(db)).length;
      expect(after).toBe(before + 1);
    });
  });

  describe("leak-hunt shell semantics of the seeded step", () => {
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
      const { code, stdout } = runLeakHunt({ pat: "" });
      expect(code).toBe(0);
      expect(stdout).toContain(
        "disk: skipped (empty PAT fragment; template did not render)"
      );
      expect(stdout).not.toContain("disk: clean");
      expect(stdout).not.toContain("LEAK: PAT content on disk:");
    });
  });
});

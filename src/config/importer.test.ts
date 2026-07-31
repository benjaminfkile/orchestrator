import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { getModuleConfig, setModuleConfig } from "../db/moduleConfig";
import { createPlaybook, listPlaybooks } from "../db/playbooks";
import { createRule, listRules } from "../db/rules";
import { getSetting, setSetting } from "../db/settings";
import { createSnippet, listSnippets } from "../db/snippets";

import { exportConfig } from "./exporter";
import { importConfig, ImportError } from "./importer";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-importer-"));
  return path.join(dir, "test.sqlite");
}

/** A minimal, valid export document with one playbook and one rule wired to it. */
function sampleDoc(overrides: Record<string, unknown> = {}) {
  return {
    kind: "orchestrator-config-export",
    schema_version: 1,
    exported_at: "2026-07-15T00:00:00.000Z",
    app_settings: {
      dispatch_max_attempts: "7",
      default_lease_image: "ghcr.io/example/runner:2",
    },
    modules: {
      ado: {
        org: "contoso",
        project: "widgets",
        pat_secret_ref: "ADO_PAT",
        enabled: true,
        interval_seconds: 60,
      },
    },
    playbooks: [
      {
        key: "researcher",
        name: "researcher",
        image: "setting:default_lease_image",
        ttl_seconds: 900,
        resources: { cpus: 2, memory_mb: 4096 },
        network: "open",
        userdata_template: "echo hi",
        prompt_template: "Investigate {{event.type}}",
        runner: "claude-code",
        runner_config: { model: "claude-sonnet-5", allowed_tools: ["Read", "Bash"] },
        env_requirements: ["GIT_TOKEN", "NPM_TOKEN"],
        steps: [{ phase: "pre", command_template: "git clone", label: "clone" }],
        granted_capabilities: [{ capability_id: "ado.work_item" }],
        output_kind: "findings",
      },
    ],
    rules: [
      {
        name: "bugs-to-researcher",
        enabled: true,
        match: { source: "ado", type: "ado.workitem.created" },
        dispatch: [{ playbook: "researcher", bindings: { priority: "high" } }],
      },
    ],
    snippets: [
      {
        kind: "prompt",
        name: "house-style",
        description: "Shared prose style",
        content: "Write terse findings.",
      },
    ],
    required_secrets: [
      { name: "ADO_PAT", used_by: ["module:ado (pat_secret_ref)"] },
      { name: "GIT_TOKEN", used_by: ["playbook:researcher (env)"] },
      { name: "NPM_TOKEN", used_by: ["playbook:researcher (env)"] },
    ],
    ...overrides,
  };
}

describe("config importer", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
    // Migrations seed some playbooks/rules; clear them so tests start empty.
    await db("rules").delete();
    await db("playbooks").delete();
    await db("module_config").delete();
    await db("app_settings").delete();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("does not statically import the secret-store module", () => {
    // Structural no-secrets guarantee: the importer must never touch the store.
    const source = fs.readFileSync(path.join(__dirname, "importer.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\.\/secrets["']/);
  });

  it("rejects a document with the wrong kind", async () => {
    await expect(
      importConfig({
        document: sampleDoc({ kind: "something-else" }),
        secretNames: [],
        db,
      })
    ).rejects.toBeInstanceOf(ImportError);
  });

  it("rejects a document with an unsupported schema_version", async () => {
    await expect(
      importConfig({
        document: sampleDoc({ schema_version: 999 }),
        secretNames: [],
        db,
      })
    ).rejects.toThrow(/schema_version/);
  });

  it("rejects a missing schema_version rather than best-effort parsing", async () => {
    await expect(
      importConfig({
        document: sampleDoc({ schema_version: undefined }),
        secretNames: [],
        db,
      })
    ).rejects.toBeInstanceOf(ImportError);
  });

  it("dry-run writes nothing and plans everything as create on an empty DB", async () => {
    const plan = await importConfig({
      document: sampleDoc(),
      dryRun: true,
      secretNames: [],
      db,
    });
    expect(plan.dry_run).toBe(true);
    expect(plan.applied).toBe(false);
    expect(plan.playbooks).toEqual([{ key: "researcher", action: "create" }]);
    expect(plan.rules).toEqual([
      { key: "bugs-to-researcher", action: "create" },
    ]);
    expect(plan.snippets).toEqual([
      { key: "prompt:house-style", action: "create" },
    ]);
    expect(plan.modules).toEqual([{ key: "ado", action: "create" }]);
    expect(plan.settings).toEqual(
      expect.arrayContaining([
        { key: "dispatch_max_attempts", action: "create" },
        { key: "default_lease_image", action: "create" },
      ])
    );
    // No writes happened.
    expect(await listPlaybooks(db)).toHaveLength(0);
    expect(await listRules(db)).toHaveLength(0);
    expect(await listSnippets(undefined, db)).toHaveLength(0);
    expect(await getModuleConfig("ado", db)).toBeUndefined();
  });

  it("applies create actions and remaps rule dispatch to the local playbook id", async () => {
    const plan = await importConfig({
      document: sampleDoc(),
      secretNames: [],
      db,
    });
    expect(plan.applied).toBe(true);

    const playbooks = await listPlaybooks(db);
    expect(playbooks).toHaveLength(1);
    const pb = playbooks[0];
    expect(pb.name).toBe("researcher");
    expect(pb.prompt_template).toBe("Investigate {{event.type}}");

    const rules = await listRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0].dispatch).toEqual([
      { playbook_id: pb.id, bindings: { priority: "high" } },
    ]);

    const snippets = await listSnippets(undefined, db);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({
      kind: "prompt",
      name: "house-style",
      description: "Shared prose style",
      content: "Write terse findings.",
    });
  });

  it("rejects a snippet whose kind is not a known snippet kind", async () => {
    const doc = sampleDoc({
      snippets: [{ kind: "template", name: "bad", content: "x" }],
    });
    await expect(
      importConfig({ document: doc, secretNames: [], db })
    ).rejects.toThrow(/invalid kind/);
    // The rejection also holds for a dry-run, and nothing is written.
    await expect(
      importConfig({ document: doc, dryRun: true, secretNames: [], db })
    ).rejects.toThrow(/invalid kind/);
    expect(await listSnippets(undefined, db)).toHaveLength(0);
  });

  it("merge mode skips a colliding snippet; overwrite mode replaces its content", async () => {
    const local = await createSnippet(
      {
        kind: "prompt",
        name: "house-style",
        description: "LOCAL description",
        content: "LOCAL content",
      },
      db
    );

    const mergePlan = await importConfig({
      document: sampleDoc(),
      secretNames: [],
      db,
    });
    expect(mergePlan.snippets).toEqual([
      { key: "prompt:house-style", action: "skip" },
    ]);
    let [snippet] = await listSnippets("prompt", db);
    expect(snippet.content).toBe("LOCAL content");

    const overwritePlan = await importConfig({
      document: sampleDoc(),
      mode: "overwrite",
      secretNames: [],
      db,
    });
    expect(overwritePlan.snippets).toEqual([
      { key: "prompt:house-style", action: "overwrite" },
    ]);
    [snippet] = await listSnippets("prompt", db);
    // Overwrite patches the LOCAL row in place: same id, imported content.
    expect(snippet.id).toBe(local.id);
    expect(snippet.description).toBe("Shared prose style");
    expect(snippet.content).toBe("Write terse findings.");
  });

  it("tolerates a document with no snippets field (older exports)", async () => {
    const plan = await importConfig({
      document: sampleDoc({ snippets: undefined }),
      secretNames: [],
      db,
    });
    expect(plan.applied).toBe(true);
    expect(plan.snippets).toEqual([]);
    expect(await listSnippets(undefined, db)).toHaveLength(0);
  });

  it("round-trips a playbook's set isolation through export then import", async () => {
    await createPlaybook(
      { name: "vm-pb", image: "img", ttl_seconds: 60, isolation: "vm" },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    // Reset to an empty DB, then import the exported document.
    await db("playbooks").delete();
    await importConfig({ document: doc, secretNames: [], db });

    const [pb] = await listPlaybooks(db);
    expect(pb.name).toBe("vm-pb");
    expect(pb.isolation).toBe("vm");
  });

  it("round-trips an absent/null isolation as null (server default)", async () => {
    const plan = await importConfig({
      document: sampleDoc(),
      secretNames: [],
      db,
    });
    expect(plan.applied).toBe(true);
    const [pb] = await listPlaybooks(db);
    // sampleDoc's playbook has no isolation field at all -> stored null.
    expect(pb.isolation).toBeNull();

    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    expect(doc.playbooks.find((p) => p.name === "researcher")?.isolation).toBeNull();
  });

  it("rejects a playbook whose isolation is not a known level", async () => {
    const doc = sampleDoc({
      playbooks: [
        {
          key: "bad",
          name: "bad",
          image: "img",
          ttl_seconds: 60,
          isolation: "hypervisor",
          network: "open",
          userdata_template: "",
          prompt_template: "",
          runner: "claude-code",
          runner_config: {},
          env_requirements: [],
          steps: [],
          granted_capabilities: [],
          output_kind: "findings",
        },
      ],
      rules: [],
    });
    await expect(
      importConfig({ document: doc, secretNames: [], db })
    ).rejects.toThrow(/invalid isolation/);
    // The rejection also holds for a dry-run, and nothing is written.
    await expect(
      importConfig({ document: doc, dryRun: true, secretNames: [], db })
    ).rejects.toThrow(/invalid isolation/);
    expect(await listPlaybooks(db)).toHaveLength(0);
  });

  it("merge mode skips colliding objects; overwrite mode replaces them", async () => {
    // Seed a local playbook and rule under the same names but different content.
    const local = await createPlaybook(
      {
        name: "researcher",
        image: "local-image",
        ttl_seconds: 60,
        prompt_template: "LOCAL",
      },
      db
    );
    await createRule(
      {
        name: "bugs-to-researcher",
        match: { source: "local" },
        dispatch: [{ playbook_id: local.id }],
      },
      db
    );

    // merge: both collisions skipped, local content preserved.
    const merge = await importConfig({
      document: sampleDoc(),
      mode: "merge",
      secretNames: [],
      db,
    });
    expect(merge.playbooks).toEqual([{ key: "researcher", action: "skip" }]);
    expect(merge.rules).toEqual([
      { key: "bugs-to-researcher", action: "skip" },
    ]);
    expect((await listPlaybooks(db))[0].prompt_template).toBe("LOCAL");

    // overwrite: both collisions replaced with the document content.
    const overwrite = await importConfig({
      document: sampleDoc(),
      mode: "overwrite",
      secretNames: [],
      db,
    });
    expect(overwrite.playbooks).toEqual([
      { key: "researcher", action: "overwrite" },
    ]);
    expect(overwrite.rules).toEqual([
      { key: "bugs-to-researcher", action: "overwrite" },
    ]);
    const pb = (await listPlaybooks(db))[0];
    expect(pb.prompt_template).toBe("Investigate {{event.type}}");
    // The overwritten rule dispatch remaps to the (same) local playbook id.
    expect((await listRules(db))[0].dispatch).toEqual([
      { playbook_id: pb.id, bindings: { priority: "high" } },
    ]);
  });

  it("remaps a rule dispatch to an already-existing local playbook not in the document", async () => {
    // Pre-existing local playbook the imported rule targets by key.
    const local = await createPlaybook(
      { name: "existing", image: "img", ttl_seconds: 60 },
      db
    );
    const doc = sampleDoc({
      playbooks: [],
      rules: [
        {
          name: "to-existing",
          enabled: true,
          match: {},
          dispatch: [{ playbook: "existing" }],
        },
      ],
    });
    await importConfig({ document: doc, secretNames: [], db });
    const rules = await listRules(db);
    const rule = rules.find((r) => r.name === "to-existing");
    expect(rule?.dispatch).toEqual([{ playbook_id: local.id }]);
  });

  it("rolls back the entire import when a rule references a dangling playbook", async () => {
    const doc = sampleDoc({
      rules: [
        {
          name: "bugs-to-researcher",
          enabled: true,
          match: {},
          dispatch: [{ playbook: "researcher" }],
        },
        {
          name: "dangling",
          enabled: true,
          match: {},
          dispatch: [{ playbook: "no-such-playbook" }],
        },
      ],
    });
    await expect(
      importConfig({ document: doc, secretNames: [], db })
    ).rejects.toThrow(/no-such-playbook/);
    // Nothing was committed — the valid playbook must not have landed.
    expect(await listPlaybooks(db)).toHaveLength(0);
    expect(await listRules(db)).toHaveLength(0);
    expect(await getModuleConfig("ado", db)).toBeUndefined();
  });

  it("reports missing_secrets against the local store's names only", async () => {
    const plan = await importConfig({
      document: sampleDoc(),
      dryRun: true,
      secretNames: ["ADO_PAT"],
      db,
    });
    expect(plan.missing_secrets.map((s) => s.name)).toEqual([
      "GIT_TOKEN",
      "NPM_TOKEN",
    ]);
    expect(plan.post_import_checklist.secrets_to_create).toEqual([
      "GIT_TOKEN",
      "NPM_TOKEN",
    ]);
    // used_by is carried through from the manifest.
    const git = plan.missing_secrets.find((s) => s.name === "GIT_TOKEN");
    expect(git?.used_by).toEqual(["playbook:researcher (env)"]);
  });

  it("stores an imported module disabled even when the document says enabled", async () => {
    await importConfig({ document: sampleDoc(), secretNames: [], db });
    const config = (await getModuleConfig("ado", db)) as Record<string, unknown>;
    expect(config.enabled).toBe(false);
    // Non-secret fields and the secret NAME are preserved.
    expect(config.org).toBe("contoso");
    expect(config.pat_secret_ref).toBe("ADO_PAT");
  });

  it("keeps identity_me out of imported settings and surfaces it on the checklist", async () => {
    await setSetting("identity_me", "me@example.com", db);
    const doc = sampleDoc({
      app_settings: {
        dispatch_max_attempts: "7",
        identity_me: "attacker@evil.com",
      },
    });
    const plan = await importConfig({ document: doc, secretNames: [], db });
    // identity_me is never imported.
    expect(plan.settings.map((s) => s.key)).not.toContain("identity_me");
    expect(await getSetting("identity_me", undefined, db)).toBe(
      "me@example.com"
    );
    expect(plan.post_import_checklist.identity_me).toBe("me@example.com");
  });

  it("produces a post_import_checklist with modules to review and the effective image", async () => {
    const plan = await importConfig({
      document: sampleDoc(),
      dryRun: true,
      secretNames: [],
      db,
    });
    expect(plan.post_import_checklist.modules_to_review).toEqual(["ado"]);
    expect(plan.post_import_checklist.default_lease_image).toBe(
      "ghcr.io/example/runner:2"
    );
  });

  it("round-trips: export -> import into an empty DB -> export is equivalent", async () => {
    // Build a source instance.
    const source = await createPlaybook(
      {
        name: "researcher",
        image: "setting:default_lease_image",
        ttl_seconds: 900,
        resources: { cpus: 2, memory_mb: 4096 },
        network: "open",
        userdata_template: "echo hi",
        prompt_template: "Investigate {{event.type}}",
        runner: "claude-code",
        runner_config: { model: "claude-sonnet-5", allowed_tools: ["Read", "Bash"] },
        env_requirements: ["GIT_TOKEN"],
        steps: [{ phase: "pre", command_template: "git clone", label: "clone" }],
        granted_capabilities: [{ capability_id: "ado.work_item" }],
        output_kind: "findings",
      },
      db
    );
    await createRule(
      {
        name: "bugs-to-researcher",
        enabled: true,
        match: { source: "ado" },
        dispatch: [{ playbook_id: source.id, bindings: { priority: "high" } }],
      },
      db
    );
    await setModuleConfig("ado", { org: "contoso", enabled: false }, db);
    await setSetting("dispatch_max_attempts", "5", db);
    await createSnippet(
      {
        kind: "prompt",
        name: "house-style",
        description: "Shared prose style",
        content: "Write terse findings.",
      },
      db
    );

    const first = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });

    // Fresh empty target DB.
    const targetFile = tempDbFile();
    const target = createDb(targetFile);
    try {
      await runMigrations(target);
      await target("rules").delete();
      await target("playbooks").delete();
      await target("module_config").delete();
      await target("app_settings").delete();

      await importConfig({ document: first, secretNames: [], db: target });

      const second = await exportConfig({
        nowIso: "2026-07-16T00:00:00.000Z",
        secrets: [],
        db: target,
      });

      // The exported_at timestamps differ by construction; everything else must
      // be equivalent.
      expect(second.playbooks).toEqual(first.playbooks);
      expect(second.rules).toEqual(first.rules);
      expect(second.snippets).toEqual(first.snippets);
      expect(second.snippets).toHaveLength(1);
      expect(second.modules).toEqual(first.modules);
      expect(second.app_settings).toEqual(first.app_settings);
      expect(second.required_secrets).toEqual(first.required_secrets);
    } finally {
      await target.destroy();
      fs.rmSync(path.dirname(targetFile), { recursive: true, force: true });
    }
  });
});

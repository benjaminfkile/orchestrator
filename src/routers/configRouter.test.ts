import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { setModuleConfig } from "../db/moduleConfig";
import { createPlaybook, listPlaybooks } from "../db/playbooks";
import { createRule, listRules } from "../db/rules";
import { setSetting } from "../db/settings";
import {
  SecretStore,
  setSecretStore,
  setSecret,
  type Keychain,
} from "../secrets";

/** An in-memory keychain so the store never touches the real OS keychain. */
function fakeKeychain(): Keychain {
  let stored: string | null = null;
  return {
    get: () => stored,
    set: (password) => {
      stored = password;
    },
  };
}

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-config-router-"));
  return path.join(dir, "test.sqlite");
}

describe("config router — GET /api/config/export", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
    // A fresh in-memory/temp-dir secret store per test — never the real OS.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-config-secrets-"));
    setSecretStore(new SecretStore({ dir, keychain: fakeKeychain() }));
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  /** Seed one playbook, one rule referencing it, ado module config, settings. */
  async function seed(): Promise<void> {
    const playbook = await createPlaybook(
      {
        name: "crew-bug-researcher",
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
      db
    );
    await createRule(
      {
        name: "bugs-to-researcher",
        enabled: true,
        match: { source: "ado", type: "ado.workitem.created" },
        dispatch: [{ playbook_id: playbook.id, bindings: { priority: "high" } }],
      },
      db
    );
    await setModuleConfig(
      "ado",
      {
        org: "contoso",
        project: "widgets",
        pat_secret_ref: "ADO_PAT",
        enabled: true,
        interval_seconds: 60,
      },
      db
    );
    await setSetting("default_lease_image", "ghcr.io/example/runner:1", db);
    await setSetting("dispatch_max_attempts", "5", db);
    await setSetting("identity_me", "me@example.com", db);
  }

  it("returns a versioned document with the expected shape and attachment header", async () => {
    await seed();
    const res = await request(app).get("/api/config/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.body.kind).toBe("orchestrator-config-export");
    expect(res.body.schema_version).toBe(2);
    expect(typeof res.body.exported_at).toBe("string");
    expect(Array.isArray(res.body.playbooks)).toBe(true);
    expect(Array.isArray(res.body.rules)).toBe(true);
    expect(Array.isArray(res.body.notifiers)).toBe(true);
    expect(Array.isArray(res.body.required_secrets)).toBe(true);
    expect(res.body.modules).toHaveProperty("ado");
    expect(res.body.app_settings).toBeDefined();
  });

  it("exports the full playbook definition keyed by name, with no numeric ids", async () => {
    await seed();
    const res = await request(app).get("/api/config/export");
    const pb = res.body.playbooks.find(
      (p: { key: string }) => p.key === "crew-bug-researcher"
    );
    expect(pb.key).toBe("crew-bug-researcher");
    expect(pb.name).toBe("crew-bug-researcher");
    expect(pb.image).toBe("setting:default_lease_image");
    expect(pb.prompt_template).toBe("Investigate {{event.type}}");
    expect(pb.env_requirements).toEqual(["GIT_TOKEN", "NPM_TOKEN"]);
    expect(pb.granted_capabilities).toEqual([{ capability_id: "ado.work_item" }]);
    expect(pb).not.toHaveProperty("id");
    expect(pb).not.toHaveProperty("created_at");
  });

  it("rewrites rule dispatch to reference playbooks by key, not playbook_id", async () => {
    await seed();
    const res = await request(app).get("/api/config/export");
    const rule = res.body.rules.find(
      (r: { name: string }) => r.name === "bugs-to-researcher"
    );
    expect(rule.name).toBe("bugs-to-researcher");
    expect(rule.enabled).toBe(true);
    expect(rule).not.toHaveProperty("id");
    expect(rule.dispatch).toEqual([
      { playbook: "crew-bug-researcher", bindings: { priority: "high" } },
    ]);
    expect(JSON.stringify(rule)).not.toContain("playbook_id");
  });

  it("forces modules to be exported disabled even when enabled locally", async () => {
    await seed();
    const res = await request(app).get("/api/config/export");
    expect(res.body.modules.ado.enabled).toBe(false);
    // Non-secret connection fields and the secret NAME are preserved.
    expect(res.body.modules.ado.org).toBe("contoso");
    expect(res.body.modules.ado.project).toBe("widgets");
    expect(res.body.modules.ado.pat_secret_ref).toBe("ADO_PAT");
  });

  it("whitelists app_settings and excludes identity_me", async () => {
    await seed();
    const res = await request(app).get("/api/config/export");
    expect(res.body.app_settings.default_lease_image).toBe(
      "ghcr.io/example/runner:1"
    );
    expect(res.body.app_settings.dispatch_max_attempts).toBe("5");
    expect(res.body.app_settings).not.toHaveProperty("identity_me");
  });

  it("builds a complete required_secrets manifest with names only", async () => {
    await seed();
    const res = await request(app).get("/api/config/export");
    const manifest: Array<{ name: string; used_by: string[] }> =
      res.body.required_secrets;
    const byName = Object.fromEntries(manifest.map((s) => [s.name, s.used_by]));
    // Seed migrations contribute their own playbooks/secrets, so assert our
    // seeded names are present rather than requiring an exact set.
    expect(Object.keys(byName)).toEqual(expect.arrayContaining([
      "ADO_PAT",
      "GIT_TOKEN",
      "NPM_TOKEN",
    ]));
    expect(byName.GIT_TOKEN).toContain("playbook:crew-bug-researcher (env)");
    expect(byName.NPM_TOKEN).toEqual(["playbook:crew-bug-researcher (env)"]);
    expect(byName.ADO_PAT).toContain("module:ado (pat_secret_ref)");
    // Names only — the manifest never carries a value field.
    for (const entry of manifest) {
      expect(entry).not.toHaveProperty("value");
    }
  });

  it("scrub=environment blanks org, project, and default_lease_image", async () => {
    await seed();
    const res = await request(app)
      .get("/api/config/export")
      .query({ scrub: "environment" });
    expect(res.status).toBe(200);
    expect(res.body.modules.ado.org).toBe("");
    expect(res.body.modules.ado.project).toBe("");
    expect(res.body.app_settings.default_lease_image).toBe("");
    // The secret name is still preserved under scrub.
    expect(res.body.modules.ado.pat_secret_ref).toBe("ADO_PAT");
  });

  it("400s on an unknown scrub value", async () => {
    await seed();
    const res = await request(app)
      .get("/api/config/export")
      .query({ scrub: "everything" });
    expect(res.status).toBe(400);
  });

  it("never emits any stored secret value even with a populated store", async () => {
    await seed();
    setSecret("ADO_PAT", "pat-value-1234567890");
    setSecret("GIT_TOKEN", "git-value-abcdefghij");
    setSecret("NPM_TOKEN", "npm-value-zyxwvutsrq");
    const res = await request(app).get("/api/config/export");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("pat-value-1234567890");
    expect(body).not.toContain("git-value-abcdefghij");
    expect(body).not.toContain("npm-value-zyxwvutsrq");
  });

  it("fails loudly when a template embeds a stored secret value", async () => {
    const secretValue = "super-secret-pat-value-1234567890";
    setSecret("GIT_TOKEN", secretValue);
    await createPlaybook(
      {
        name: "crew-bug-researcher",
        image: "setting:default_lease_image",
        ttl_seconds: 900,
        // The user pasted the raw secret value into a template — a leak.
        userdata_template: `export TOKEN=${secretValue}`,
        prompt_template: "go",
        env_requirements: ["GIT_TOKEN"],
      },
      db
    );
    const res = await request(app).get("/api/config/export");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("crew-bug-researcher");
    expect(res.body.error).toContain("userdata_template");
    expect(res.body.error).toContain("GIT_TOKEN");
    // The leaked value itself is never echoed back in the error.
    expect(JSON.stringify(res.body)).not.toContain(secretValue);
  });
});

describe("config router — POST /api/config/import", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
    // Start from a clean slate: migrations seed some playbooks/rules/notifiers.
    await db("rules").delete();
    await db("playbooks").delete();
    await db("notifiers").delete();
    await db("module_config").delete();
    await db("app_settings").delete();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-config-secrets-"));
    setSecretStore(new SecretStore({ dir, keychain: fakeKeychain() }));
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  /** A round-trip document produced by the real exporter over a seeded DB. */
  async function seededDocument() {
    const playbook = await createPlaybook(
      {
        name: "crew-bug-researcher",
        image: "setting:default_lease_image",
        ttl_seconds: 900,
        prompt_template: "Investigate {{event.type}}",
        env_requirements: ["GIT_TOKEN", "NPM_TOKEN"],
      },
      db
    );
    await createRule(
      {
        name: "bugs-to-researcher",
        match: { source: "ado" },
        dispatch: [{ playbook_id: playbook.id, bindings: { priority: "high" } }],
      },
      db
    );
    await setModuleConfig(
      "ado",
      { org: "contoso", pat_secret_ref: "ADO_PAT", enabled: true },
      db
    );
    await setSetting("default_lease_image", "ghcr.io/example/runner:1", db);
    const res = await request(app).get("/api/config/export");
    return res.body;
  }

  it("dry-run returns a plan and writes nothing", async () => {
    const doc = await seededDocument();
    // Wipe the DB so the import would be all-creates.
    await db("rules").delete();
    await db("playbooks").delete();
    await db("module_config").delete();
    await db("app_settings").delete();

    const res = await request(app)
      .post("/api/config/import")
      .send({ document: doc, dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.playbooks).toContainEqual({
      key: "crew-bug-researcher",
      action: "create",
    });
    expect(res.body.post_import_checklist).toBeDefined();
    // Nothing was written.
    expect(await db("playbooks").count({ n: "*" }).first()).toEqual({ n: 0 });
  });

  it("applies the import and remaps rule dispatch to local ids", async () => {
    const doc = await seededDocument();
    await db("rules").delete();
    await db("playbooks").delete();
    await db("module_config").delete();

    const res = await request(app)
      .post("/api/config/import")
      .send({ document: doc });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    const rules = await listRules(db);
    const playbooks = await listPlaybooks(db);
    const pb = playbooks.find((p) => p.name === "crew-bug-researcher");
    const rule = rules.find((r) => r.name === "bugs-to-researcher");
    expect(rule?.dispatch).toEqual([
      { playbook_id: pb?.id, bindings: { priority: "high" } },
    ]);
  });

  it("computes missing_secrets against the store's names", async () => {
    const doc = await seededDocument();
    setSecret("ADO_PAT", "some-value-000000");
    const res = await request(app)
      .post("/api/config/import")
      .send({ document: doc, dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.post_import_checklist.secrets_to_create).toEqual(
      expect.arrayContaining(["GIT_TOKEN", "NPM_TOKEN"])
    );
    expect(res.body.post_import_checklist.secrets_to_create).not.toContain(
      "ADO_PAT"
    );
  });

  it("400s on a missing document", async () => {
    const res = await request(app).post("/api/config/import").send({});
    expect(res.status).toBe(400);
  });

  it("400s on an unrecognized document kind", async () => {
    const res = await request(app)
      .post("/api/config/import")
      .send({ document: { kind: "nope", schema_version: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("kind");
  });

  it("400s on an unknown mode", async () => {
    const doc = await seededDocument();
    const res = await request(app)
      .post("/api/config/import")
      .send({ document: doc, mode: "clobber" });
    expect(res.status).toBe(400);
  });

  it("409s and rolls back on a dangling playbook reference", async () => {
    const doc = await seededDocument();
    await db("rules").delete();
    await db("playbooks").delete();
    await db("module_config").delete();
    // Point the rule at a playbook that neither the document nor the DB defines.
    doc.rules[0].dispatch = [{ playbook: "no-such-playbook" }];

    const res = await request(app)
      .post("/api/config/import")
      .send({ document: doc });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no-such-playbook");
    // The whole apply rolled back — the valid playbook was not created.
    expect(await listPlaybooks(db)).toHaveLength(0);
  });
});

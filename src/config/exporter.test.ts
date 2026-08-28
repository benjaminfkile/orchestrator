import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb, setDb } from "../db/db";
import { runMigrations } from "../db/migrate";
import { setModuleConfig } from "../db/moduleConfig";
import { createNotifier } from "../db/notifiers";
import { createPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import { setSetting } from "../db/settings";
import { createSnippet } from "../db/snippets";

import {
  EXPORT_KIND,
  EXPORT_SCHEMA_VERSION,
  exportConfig,
  SecretLeakError,
} from "./exporter";

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-exporter-"));
  return path.join(dir, "test.sqlite");
}

describe("config exporter", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
    // Migrations seed some playbooks/rules/notifiers; clear them so tests
    // start empty and can plant their own fixtures.
    await db("rules").delete();
    await db("playbooks").delete();
    await db("notifiers").delete();
    await db("module_config").delete();
    await db("app_settings").delete();
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("does not statically import the secret-store module", () => {
    // Structural no-secrets guarantee: the exporter must read only
    // playbooks/rules/module_config/app_settings and never the secret store.
    const source = fs.readFileSync(
      path.join(__dirname, "exporter.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/from\s+["']\.\.\/secrets["']/);
  });

  it("stamps kind, schema_version and the provided timestamp", async () => {
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    expect(doc.kind).toBe(EXPORT_KIND);
    expect(doc.schema_version).toBe(EXPORT_SCHEMA_VERSION);
    expect(doc.exported_at).toBe("2026-07-15T00:00:00.000Z");
    // Version 2 also stamps the notifier collection (empty here) so a diff of
    // two exports is stable regardless of whether any notifier exists locally.
    expect(doc.notifiers).toEqual([]);
  });

  it("exports notifiers with name, templates, enabled bit, and config", async () => {
    await createNotifier(
      {
        name: "desktop",
        title_template: "Run finished",
        body_template: "{{event.type}}",
        enabled: true,
        config: { channel: "primary" },
      },
      db
    );
    await createNotifier(
      {
        name: "quiet",
        title_template: "",
        body_template: "",
        enabled: false,
        config: {},
      },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    // Sorted by name for a diffable export.
    expect(doc.notifiers).toEqual([
      {
        name: "desktop",
        title_template: "Run finished",
        body_template: "{{event.type}}",
        enabled: true,
        config: { channel: "primary" },
      },
      {
        name: "quiet",
        title_template: "",
        body_template: "",
        enabled: false,
        config: {},
      },
    ]);
    // A notifier is a reactive outbound sink; unlike modules, it preserves its
    // `enabled` bit through export so a live setup lands live on import.
    expect(doc.notifiers[0].enabled).toBe(true);
    expect(doc.notifiers[1].enabled).toBe(false);
  });

  it("rewrites a rule's notify targets to reference notifiers by name", async () => {
    const desktop = await createNotifier({ name: "desktop" }, db);
    await createRule(
      {
        name: "notify-on-done",
        match: {},
        dispatch: [],
        notify: [{ notifier_id: desktop.id }],
      },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    const rule = doc.rules.find((r) => r.name === "notify-on-done");
    expect(rule?.notify).toEqual([{ notifier: "desktop" }]);
  });

  it("leaves a notify target's notifier null when the id is unresolvable", async () => {
    await createRule(
      {
        name: "dangling-notify",
        match: {},
        dispatch: [],
        notify: [{ notifier_id: 999999 }],
      },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    const rule = doc.rules.find((r) => r.name === "dangling-notify");
    expect(rule?.notify).toEqual([{ notifier: null }]);
  });

  it("emits a rule's empty notify as [], not omitted, for diff stability", async () => {
    await createRule(
      {
        name: "silent",
        match: {},
        dispatch: [],
      },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    const rule = doc.rules.find((r) => r.name === "silent");
    expect(rule?.notify).toEqual([]);
  });

  it("throws SecretLeakError naming the notifier when a config field leaks", async () => {
    // Defense in depth: a pasted secret VALUE inside a notifier config field
    // (whatever the user named it) is a leak the exporter refuses to mask.
    await createNotifier(
      {
        name: "webhook",
        config: { webhook_url: "https://example.com/deadbeefcafef00d" },
      },
      db
    );
    await expect(
      exportConfig({
        nowIso: "2026-07-15T00:00:00.000Z",
        secrets: [{ name: "WEBHOOK_TOKEN", value: "deadbeefcafef00d" }],
        db,
      })
    ).rejects.toThrow(/notifier webhook/);
  });

  it("throws SecretLeakError naming the offending object when a value leaks", async () => {
    await createPlaybook(
      {
        name: "leaky",
        image: "img",
        ttl_seconds: 60,
        prompt_template: "token is deadbeefcafef00d",
      },
      db
    );
    await expect(
      exportConfig({
        nowIso: "2026-07-15T00:00:00.000Z",
        secrets: [{ name: "TOKEN", value: "deadbeefcafef00d" }],
        db,
      })
    ).rejects.toBeInstanceOf(SecretLeakError);
  });

  it("does not fail on secrets shorter than a real value / empty value", async () => {
    await createPlaybook(
      { name: "p", image: "img", ttl_seconds: 60, prompt_template: "hello" },
      db
    );
    // An empty stored value must not match every string in the document.
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [{ name: "EMPTY", value: "" }],
      db,
    });
    expect(doc.kind).toBe(EXPORT_KIND);
  });

  it("does not blank org/project without scrub", async () => {
    await setModuleConfig(
      "ado",
      { org: "contoso", project: "widgets", enabled: true },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    const ado = doc.modules.ado as Record<string, unknown>;
    expect(ado.org).toBe("contoso");
    expect(ado.project).toBe("widgets");
    expect(ado.enabled).toBe(false);
  });

  it("leaves a dispatch target's playbook null when the id is unresolvable", async () => {
    await createRule(
      {
        name: "dangling",
        match: {},
        dispatch: [{ playbook_id: 999999 }],
      },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    const rule = doc.rules.find((r) => r.name === "dangling");
    expect(rule?.dispatch).toEqual([{ playbook: null }]);
  });

  it("includes the run-budget gate settings in app_settings", async () => {
    await setSetting("run_budget_per_hour", "10", db);
    await setSetting("run_budget_window_minutes", "300", db);
    await setSetting("token_budget_per_window", "500000", db);
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    expect(doc.app_settings).toMatchObject({
      run_budget_per_hour: "10",
      run_budget_window_minutes: "300",
      token_budget_per_window: "500000",
    });
  });

  it("emits a playbook's set isolation, and null when unset", async () => {
    await createPlaybook(
      {
        name: "sandboxed",
        image: "img",
        ttl_seconds: 60,
        isolation: "sandboxed",
      },
      db
    );
    await createPlaybook(
      { name: "plain", image: "img", ttl_seconds: 60 },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    const sandboxed = doc.playbooks.find((p) => p.name === "sandboxed");
    const plain = doc.playbooks.find((p) => p.name === "plain");
    expect(sandboxed?.isolation).toBe("sandboxed");
    expect(plain?.isolation).toBeNull();
  });

  it("exports snippets sorted by (kind, name) with no ids or timestamps", async () => {
    await createSnippet(
      { kind: "userdata", name: "setup", content: "apt-get install -y jq" },
      db
    );
    await createSnippet(
      {
        kind: "prompt",
        name: "house-style",
        description: "Shared prose style",
        content: "Write terse findings.",
      },
      db
    );
    await createSnippet(
      { kind: "prompt", name: "guardrails", content: "Never push." },
      db
    );
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    expect(doc.snippets).toEqual([
      {
        kind: "prompt",
        name: "guardrails",
        description: "",
        content: "Never push.",
      },
      {
        kind: "prompt",
        name: "house-style",
        description: "Shared prose style",
        content: "Write terse findings.",
      },
      {
        kind: "userdata",
        name: "setup",
        description: "",
        content: "apt-get install -y jq",
      },
    ]);
  });

  it("throws SecretLeakError when a snippet's content embeds a secret value", async () => {
    await createSnippet(
      {
        kind: "userdata",
        name: "leaky",
        content: "export TOKEN=deadbeefcafef00d",
      },
      db
    );
    await expect(
      exportConfig({
        nowIso: "2026-07-15T00:00:00.000Z",
        secrets: [{ name: "TOKEN", value: "deadbeefcafef00d" }],
        db,
      })
    ).rejects.toThrow(/snippet userdata:leaky/);
  });

  it("emits no numeric ids anywhere in the document", async () => {
    await setSetting("dispatch_max_attempts", "5", db);
    const doc = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain("playbook_id");
    for (const p of doc.playbooks) {
      expect(p).not.toHaveProperty("id");
    }
  });
});

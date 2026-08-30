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
  UnknownExclusionError,
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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
    const { document: doc } = await exportConfig({
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

describe("config exporter, per-export exclusion", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);
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

  it("drops excluded playbooks and rebuilds required_secrets without them", async () => {
    await createPlaybook(
      {
        name: "keep",
        image: "img",
        ttl_seconds: 60,
        env_requirements: ["KEEP_TOKEN"],
      },
      db
    );
    await createPlaybook(
      {
        name: "drop",
        image: "img",
        ttl_seconds: 60,
        env_requirements: ["DROP_TOKEN"],
      },
      db
    );
    const { document: doc, warnings } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      exclude: { playbooks: ["drop"] },
      db,
    });
    expect(doc.playbooks.map((p) => p.name)).toEqual(["keep"]);
    // required_secrets tracks only the surviving playbook's env requirements.
    const names = doc.required_secrets.map((s) => s.name);
    expect(names).toContain("KEEP_TOKEN");
    expect(names).not.toContain("DROP_TOKEN");
    expect(warnings).toEqual([]);
  });

  it("drops excluded rules but leaves everything else intact", async () => {
    const playbook = await createPlaybook(
      { name: "runner", image: "img", ttl_seconds: 60 },
      db
    );
    await createRule(
      {
        name: "keep-rule",
        match: {},
        dispatch: [{ playbook_id: playbook.id }],
      },
      db
    );
    await createRule(
      {
        name: "drop-rule",
        match: {},
        dispatch: [{ playbook_id: playbook.id }],
      },
      db
    );
    const { document: doc, warnings } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      exclude: { rules: ["drop-rule"] },
      db,
    });
    expect(doc.rules.map((r) => r.name)).toEqual(["keep-rule"]);
    expect(warnings).toEqual([]);
  });

  it("drops excluded snippets identified by kind:name and leaves same-name entries in other kinds", async () => {
    await createSnippet(
      { kind: "prompt", name: "shared", content: "PROMPT" },
      db
    );
    await createSnippet(
      { kind: "userdata", name: "shared", content: "USERDATA" },
      db
    );
    const { document: doc } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      exclude: { snippets: ["prompt:shared"] },
      db,
    });
    expect(doc.snippets).toEqual([
      {
        kind: "userdata",
        name: "shared",
        description: "",
        content: "USERDATA",
      },
    ]);
  });

  it("drops excluded notifiers AND removes them from every rule's notify targets", async () => {
    const desktop = await createNotifier({ name: "desktop" }, db);
    const email = await createNotifier({ name: "email" }, db);
    await createRule(
      {
        name: "notify-both",
        match: {},
        dispatch: [],
        notify: [
          { notifier_id: desktop.id },
          { notifier_id: email.id },
        ],
      },
      db
    );
    const { document: doc, warnings } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      exclude: { notifiers: ["desktop"] },
      db,
    });
    expect(doc.notifiers.map((n) => n.name)).toEqual(["email"]);
    const rule = doc.rules.find((r) => r.name === "notify-both");
    // The excluded notifier is dropped in-place, keeping the surviving one.
    expect(rule?.notify).toEqual([{ notifier: "email" }]);
    // Dropping an excluded notifier is a deliberate opt-out and does NOT warn.
    expect(warnings).toEqual([]);
  });

  it("warns for included rules whose dispatch target is an excluded playbook", async () => {
    const playbook = await createPlaybook(
      { name: "excluded-pb", image: "img", ttl_seconds: 60 },
      db
    );
    await createRule(
      {
        name: "still-here",
        match: {},
        dispatch: [{ playbook_id: playbook.id }],
      },
      db
    );
    const { document: doc, warnings } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      exclude: { playbooks: ["excluded-pb"] },
      db,
    });
    expect(doc.playbooks).toEqual([]);
    // The rule survives with its dispatch target preserved (import side needs it).
    const rule = doc.rules.find((r) => r.name === "still-here");
    expect(rule?.dispatch).toEqual([{ playbook: "excluded-pb" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      rule: "still-here",
      kind: "dispatch",
      target: "excluded-pb",
    });
    expect(warnings[0].message).toContain("still-here");
    expect(warnings[0].message).toContain("excluded-pb");
  });

  it("warns for included rules whose dispatch target was unresolvable in the source", async () => {
    await createRule(
      {
        name: "dangling-source",
        match: {},
        dispatch: [{ playbook_id: 999999 }],
      },
      db
    );
    const { warnings } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      rule: "dangling-source",
      kind: "dispatch",
    });
  });

  it("warns for included rules whose notify target was unresolvable in the source", async () => {
    await createRule(
      {
        name: "dangling-notify",
        match: {},
        dispatch: [],
        notify: [{ notifier_id: 999999 }],
      },
      db
    );
    const { warnings } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [],
      db,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      rule: "dangling-notify",
      kind: "notify",
    });
  });

  it("throws UnknownExclusionError listing every unknown name across groups", async () => {
    await createPlaybook({ name: "pb", image: "img", ttl_seconds: 60 }, db);
    await createNotifier({ name: "desk" }, db);
    await expect(
      exportConfig({
        nowIso: "2026-07-15T00:00:00.000Z",
        secrets: [],
        exclude: {
          playbooks: ["pb", "nope-pb"],
          notifiers: ["desk", "nope-notif"],
        },
        db,
      })
    ).rejects.toBeInstanceOf(UnknownExclusionError);
    try {
      await exportConfig({
        nowIso: "2026-07-15T00:00:00.000Z",
        secrets: [],
        exclude: {
          playbooks: ["nope-pb"],
          rules: ["nope-rule"],
        },
        db,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownExclusionError);
      const unknown = (err as UnknownExclusionError).unknown;
      expect(unknown.playbooks).toEqual(["nope-pb"]);
      expect(unknown.rules).toEqual(["nope-rule"]);
    }
  });

  it("runs the secret leak scan on the FILTERED document (an excluded leaky playbook does not fail export)", async () => {
    await createPlaybook(
      {
        name: "leaky",
        image: "img",
        ttl_seconds: 60,
        prompt_template: "token=deadbeefcafef00d",
      },
      db
    );
    // Without exclusion, the leak scan fails.
    await expect(
      exportConfig({
        nowIso: "2026-07-15T00:00:00.000Z",
        secrets: [{ name: "TOKEN", value: "deadbeefcafef00d" }],
        db,
      })
    ).rejects.toBeInstanceOf(SecretLeakError);
    // With the leaky playbook excluded, the scan sees nothing offending.
    const { document: doc } = await exportConfig({
      nowIso: "2026-07-15T00:00:00.000Z",
      secrets: [{ name: "TOKEN", value: "deadbeefcafef00d" }],
      exclude: { playbooks: ["leaky"] },
      db,
    });
    expect(doc.playbooks).toEqual([]);
  });
});

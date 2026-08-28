import type { Knex } from "knex";

import { getDb } from "../db/db";
import { getModuleConfig, setModuleConfig } from "../db/moduleConfig";
import {
  createNotifier,
  listNotifiers,
  updateNotifier,
} from "../db/notifiers";
import { createPlaybook, listPlaybooks, updatePlaybook } from "../db/playbooks";
import { createRule, listRules, updateRule } from "../db/rules";
import { getSetting, setSetting } from "../db/settings";
import { createSnippet, listSnippets, updateSnippet } from "../db/snippets";
import { DEFAULT_LEASE_IMAGE_SETTING } from "../executor/executor";
import {
  LEASE_ISOLATION_LEVELS,
  SNIPPET_KINDS,
  type LeaseIsolation,
  type NewNotifier,
  type NewPlaybook,
  type RuleDispatchTarget,
  type RuleMatch,
  type RuleNotifyTarget,
  type SnippetKind,
} from "../interfaces";
import { IDENTITY_ME_SETTING } from "../services/eventIntake";

import { KNOWN_SETTING_KEYS } from "../routers/settingsRouter";

import {
  EXPORT_KIND,
  SUPPORTED_IMPORT_SCHEMA_VERSIONS,
  type ConfigExportDocument,
  type ExportedNotifier,
  type ExportedPlaybook,
  type ExportedRule,
  type ExportedSnippet,
} from "./exporter";

/**
 * config import — the counterpart to {@link import("./exporter").exportConfig}.
 * It takes a portable export document and reproduces its automation setup
 * (playbooks, rules with their dispatch AND notify targets, notifiers,
 * snippets, module config, whitelisted settings) on the local instance.
 *
 * SECRET HYGIENE (load-bearing). Like the exporter, this module NEVER touches the
 * secret store: it neither creates, reads, nor modifies secrets. It computes a
 * `missing_secrets` checklist purely from secret NAMES the caller passes in (the
 * router reads the store once and hands over the name list). Imported module
 * configs are always stored with `enabled=false` regardless of what the document
 * says — a hand-edited document that re-enabled a module is tolerated, not
 * obeyed, so an import can never start polling or dispatching on its own.
 *
 * NOTIFIERS. Rule `notify` targets reference notifiers by NAME. A notifier is
 * matched by name idempotently: an existing local notifier of the same name is
 * skipped (merge) or overwritten (overwrite); either way the rule's notify
 * target rebinds to the local numeric id. A rule that notifies a name neither
 * in the document nor already local is a referential failure that rolls back
 * the whole apply, same shape as the existing dispatch dangling check.
 *
 * BACK-COMPAT. A v1 document (which had no notifiers and no rule notify field)
 * imports cleanly: `notifiers[]` and each rule's `notify[]` default to empty.
 *
 * TRANSACTIONAL (load-bearing). A non-dry-run apply runs inside a single
 * better-sqlite3 transaction. Any referential failure (e.g. a rule whose playbook
 * or notifier key is neither in the document nor already in the local DB) throws
 * and rolls back EVERYTHING, naming the object that failed.
 */

/** Import merge strategy on a name/id/key collision with a local object. */
export type ImportMode = "merge" | "overwrite";

/** What the import did (or would do, in dry-run) to a single object. */
export type ImportAction = "create" | "skip" | "overwrite";

/** One planned object action, keyed by its stable identity string. */
export interface ImportPlanItem {
  /** The object's identity: playbook/rule name, module id, or setting key. */
  key: string;
  action: ImportAction;
}

/** A required secret NAME not present in the local store, with its uses. */
export interface MissingSecret {
  name: string;
  used_by: string[];
}

/**
 * The post-import checklist: everything a human must review or provide by hand,
 * since the importer deliberately never touches secrets, identity, or module
 * enablement, and cannot know the local wisp image allow-list.
 */
export interface PostImportChecklist {
  /** Secret NAMES referenced by the document but absent locally — create these. */
  secrets_to_create: string[];
  /**
   * The local `identity_me` value (blank when unset). Never imported — it is
   * environment-bound — so it is surfaced for the user to set/confirm.
   */
  identity_me: string;
  /**
   * Module ids the import wrote. Every one arrives DISABLED; review and enable
   * each by hand once its secrets/config are in place.
   */
  modules_to_review: string[];
  /**
   * The `default_lease_image` value in effect after import (document value when
   * imported, else the current local value, else null). Confirm it against the
   * local wisp image allow-list before running anything.
   */
  default_lease_image: string | null;
}

/** The full import plan / result, returned for dry-run and apply alike. */
export interface ImportPlan {
  mode: ImportMode;
  dry_run: boolean;
  /** True when writes were committed; always false for a dry-run. */
  applied: boolean;
  playbooks: ImportPlanItem[];
  rules: ImportPlanItem[];
  /** Notifier plan items, keyed by name (a notifier's stable identity). */
  notifiers: ImportPlanItem[];
  /** Snippet plan items, keyed `<kind>:<name>` — a snippet's stable identity. */
  snippets: ImportPlanItem[];
  modules: ImportPlanItem[];
  settings: ImportPlanItem[];
  missing_secrets: MissingSecret[];
  post_import_checklist: PostImportChecklist;
}

/** Options for {@link importConfig}. */
export interface ImportConfigOptions {
  /** The document to import — validated before anything is read or written. */
  document: unknown;
  /** Collision strategy; defaults to "merge" (never destroy a working setup). */
  mode?: ImportMode;
  /** When true, execute NO writes and return the full plan. */
  dryRun?: boolean;
  /**
   * Secret NAMES currently in the local store, used ONLY to compute
   * `missing_secrets`. The importer never reads the store itself.
   */
  secretNames: string[];
  db?: Knex;
}

/**
 * Raised for any import failure: a malformed/unversioned document (status 400) or
 * a referential integrity failure that rolls back the whole apply (status 409).
 * The message names the offending object; the router maps `status` to the HTTP
 * response.
 */
export class ImportError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/** True for a non-null, non-array object value. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the document envelope and return it strongly typed. Unknown or missing
 * `kind`/`schema_version` are rejected with a clear message — never best-effort
 * parsed. Any version listed in {@link SUPPORTED_IMPORT_SCHEMA_VERSIONS} is
 * accepted; older-version documents just get default values for fields that
 * did not exist yet (see the readers below).
 */
function validateDocument(document: unknown): ConfigExportDocument {
  if (!isPlainObject(document)) {
    throw new ImportError("import document must be a JSON object");
  }
  if (document.kind !== EXPORT_KIND) {
    throw new ImportError(
      `unrecognized import document kind: ${JSON.stringify(document.kind)} ` +
        `(expected ${JSON.stringify(EXPORT_KIND)})`
    );
  }
  if (
    typeof document.schema_version !== "number" ||
    !SUPPORTED_IMPORT_SCHEMA_VERSIONS.includes(document.schema_version)
  ) {
    throw new ImportError(
      `unsupported import schema_version: ${JSON.stringify(
        document.schema_version
      )} (this build imports versions ${SUPPORTED_IMPORT_SCHEMA_VERSIONS.join(
        ", "
      )})`
    );
  }
  return document as unknown as ConfigExportDocument;
}

/** Coerce the document's `playbooks` field to an array, tolerating absence. */
function readPlaybooks(doc: ConfigExportDocument): ExportedPlaybook[] {
  const raw = (doc as { playbooks?: unknown }).playbooks;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ImportError("import document playbooks must be an array");
  }
  return raw as ExportedPlaybook[];
}

/** Coerce the document's `rules` field to an array, tolerating absence. */
function readRules(doc: ConfigExportDocument): ExportedRule[] {
  const raw = (doc as { rules?: unknown }).rules;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ImportError("import document rules must be an array");
  }
  return raw as ExportedRule[];
}

/**
 * Coerce the document's `notifiers` field to an array, tolerating absence (v1
 * exports predate notifiers), and validate each entry: `name` must be a
 * non-empty string; `config` must be an object; templates and `enabled` are
 * optional (default to `""` and `true`).
 */
function readNotifiers(doc: ConfigExportDocument): ExportedNotifier[] {
  const raw = (doc as { notifiers?: unknown }).notifiers;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ImportError("import document notifiers must be an array");
  }
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ImportError(
        `import document notifiers[${i}] must be an object`
      );
    }
    const { name, config, title_template, body_template, enabled } = entry;
    if (typeof name !== "string" || name.length === 0) {
      throw new ImportError(
        `import document notifiers[${i}] must have a non-empty string name`
      );
    }
    if (config !== undefined && !isPlainObject(config)) {
      throw new ImportError(
        `notifier "${name}" config must be an object when present`
      );
    }
    return {
      name,
      title_template:
        typeof title_template === "string" ? title_template : "",
      body_template: typeof body_template === "string" ? body_template : "",
      enabled: typeof enabled === "boolean" ? enabled : true,
      config: (config as Record<string, unknown> | undefined) ?? {},
    };
  });
}

/**
 * Read one rule's exported `notify` array, tolerating absence (v1 rules had no
 * notify field). Each entry must be an object; the `notifier` key names the
 * target notifier by its stable key (name), or is null when the source id was
 * unresolvable at export time. Extra keys are ignored; only `notifier` shapes
 * the local write.
 */
function readRuleNotify(rule: ExportedRule): Array<{ notifier: string | null }> {
  const raw = (rule as { notify?: unknown }).notify;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ImportError(
      `rule "${rule.name}" notify must be an array when present`
    );
  }
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ImportError(
        `rule "${rule.name}" notify[${i}] must be an object`
      );
    }
    const notifier = entry.notifier;
    if (notifier !== null && typeof notifier !== "string") {
      throw new ImportError(
        `rule "${rule.name}" notify[${i}].notifier must be a string or null`
      );
    }
    return { notifier: notifier as string | null };
  });
}

/**
 * Coerce the document's `snippets` field to an array, tolerating absence (older
 * exports predate snippets), and validate each entry: `kind` must be one of
 * {@link SNIPPET_KINDS} and `name`/`content` must be strings (`name` non-empty),
 * else the import is rejected naming the offending snippet.
 */
function readSnippets(doc: ConfigExportDocument): ExportedSnippet[] {
  const raw = (doc as { snippets?: unknown }).snippets;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ImportError("import document snippets must be an array");
  }
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ImportError(`import document snippets[${i}] must be an object`);
    }
    const { kind, name, content, description } = entry;
    if (typeof name !== "string" || name.length === 0) {
      throw new ImportError(
        `import document snippets[${i}] must have a non-empty string name`
      );
    }
    if (
      typeof kind !== "string" ||
      !SNIPPET_KINDS.includes(kind as SnippetKind)
    ) {
      throw new ImportError(
        `snippet "${name}" has invalid kind ${JSON.stringify(kind)} ` +
          `(expected one of ${SNIPPET_KINDS.map((k) => JSON.stringify(k)).join(
            ", "
          )})`
      );
    }
    if (typeof content !== "string") {
      throw new ImportError(`snippet "${name}" must have string content`);
    }
    return {
      kind: kind as SnippetKind,
      name,
      description: typeof description === "string" ? description : "",
      content,
    };
  });
}

/** A snippet's stable identity string, used as its import plan key. */
function snippetKeyOf(s: { kind: SnippetKind; name: string }): string {
  return `${s.kind}:${s.name}`;
}

/** The playbook's stable identity key, falling back to its name. */
function playbookKeyOf(pb: ExportedPlaybook): string {
  if (typeof pb.key === "string" && pb.key.length > 0) return pb.key;
  return pb.name;
}

/**
 * Validate and normalize an exported playbook's optional isolation. Absent or
 * null means "server default" (like an unset host); a present value must be
 * exactly one of {@link LEASE_ISOLATION_LEVELS}, else the import is rejected.
 */
function readIsolation(pb: ExportedPlaybook): LeaseIsolation | null {
  const raw = (pb as { isolation?: unknown }).isolation;
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== "string" ||
    !LEASE_ISOLATION_LEVELS.includes(raw as LeaseIsolation)
  ) {
    throw new ImportError(
      `playbook "${pb.name}" has invalid isolation ${JSON.stringify(raw)} ` +
        `(expected one of ${LEASE_ISOLATION_LEVELS.map((v) =>
          JSON.stringify(v)
        ).join(", ")})`
    );
  }
  return raw as LeaseIsolation;
}

/** Map an exported playbook to the fields {@link createPlaybook} accepts. */
function toNewPlaybook(pb: ExportedPlaybook): NewPlaybook {
  return {
    name: pb.name,
    image: pb.image,
    isolation: readIsolation(pb),
    ttl_seconds: pb.ttl_seconds,
    resources: (pb.resources ?? {}) as NewPlaybook["resources"],
    network: pb.network,
    userdata_template: pb.userdata_template,
    prompt_template: pb.prompt_template,
    runner: pb.runner ?? "claude-code",
    runner_config: pb.runner_config ?? {},
    env_requirements: pb.env_requirements ?? [],
    steps: pb.steps ?? [],
    granted_capabilities:
      (pb.granted_capabilities as NewPlaybook["granted_capabilities"]) ?? [],
    output_kind: pb.output_kind,
  };
}

/** Force a module config to `enabled=false`, whatever the document said. */
function disabledModuleConfig(config: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(config)
    ? { ...config }
    : {};
  // An imported module must never poll or dispatch until a human re-enables it,
  // even if a hand-editor flipped `enabled` back to true in the document.
  base.enabled = false;
  return base;
}

/** Read the document's required_secrets manifest defensively (names only). */
function readRequiredSecrets(doc: ConfigExportDocument): MissingSecret[] {
  const raw = (doc as { required_secrets?: unknown }).required_secrets;
  if (!Array.isArray(raw)) return [];
  const out: MissingSecret[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const name = entry.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const usedBy = Array.isArray(entry.used_by)
      ? entry.used_by.filter((u): u is string => typeof u === "string")
      : [];
    out.push({ name, used_by: usedBy });
  }
  return out;
}

/** The whitelisted settings the importer will consider, excluding identity_me. */
function importableSettings(
  doc: ConfigExportDocument
): Array<{ key: string; value: string }> {
  const raw = (doc as { app_settings?: unknown }).app_settings;
  if (!isPlainObject(raw)) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const key of KNOWN_SETTING_KEYS) {
    // identity_me is environment-bound and never exported; if a hand-editor
    // added it, we still refuse to import it (it goes on the checklist instead).
    if (key === IDENTITY_ME_SETTING) continue;
    const value = raw[key];
    if (typeof value !== "string") continue;
    out.push({ key, value });
  }
  return out;
}

/**
 * Resolve a rule dispatch target's playbook key to a local playbook id. `key`
 * may name a playbook defined in this document (matched to its stored name) or
 * one that already exists locally. Returns undefined when unresolvable.
 */
function resolvePlaybookId(
  key: string | null,
  docPlaybooksByKey: Map<string, ExportedPlaybook>,
  nameToId: Map<string, number>
): number | undefined {
  if (key === null) return undefined;
  const docPb = docPlaybooksByKey.get(key);
  const name = docPb ? docPb.name : key;
  return nameToId.get(name);
}

/** Remap one exported rule's dispatch to local playbook ids, or throw. */
function remapDispatch(
  rule: ExportedRule,
  docPlaybooksByKey: Map<string, ExportedPlaybook>,
  nameToId: Map<string, number>
): RuleDispatchTarget[] {
  const dispatch = Array.isArray(rule.dispatch) ? rule.dispatch : [];
  return dispatch.map((target) => {
    const id = resolvePlaybookId(target.playbook, docPlaybooksByKey, nameToId);
    if (id === undefined) {
      throw new ImportError(
        `rule "${rule.name}" dispatches to playbook ` +
          `${JSON.stringify(target.playbook)}, which is neither in the ` +
          `document nor already in the local database`,
        409
      );
    }
    const out: RuleDispatchTarget = { playbook_id: id };
    if (target.bindings !== undefined) out.bindings = target.bindings;
    return out;
  });
}

/**
 * Remap one exported rule's notify targets to local notifier ids, or throw.
 * Same referential integrity shape as {@link remapDispatch}: an unresolvable
 * name is a 409 that rolls back the whole apply.
 */
function remapNotify(
  rule: ExportedRule,
  nameToId: Map<string, number>
): RuleNotifyTarget[] {
  const notify = readRuleNotify(rule);
  return notify.map((target) => {
    if (target.notifier === null) {
      throw new ImportError(
        `rule "${rule.name}" has a notify target with a null notifier; ` +
          `fix the source export before importing`,
        409
      );
    }
    const id = nameToId.get(target.notifier);
    if (id === undefined) {
      throw new ImportError(
        `rule "${rule.name}" notifies notifier ` +
          `${JSON.stringify(target.notifier)}, which is neither in the ` +
          `document nor already in the local database`,
        409
      );
    }
    return { notifier_id: id };
  });
}

/** Map an exported notifier to the fields {@link createNotifier} accepts. */
function toNewNotifier(n: ExportedNotifier): NewNotifier {
  return {
    name: n.name,
    config: n.config,
    title_template: n.title_template,
    body_template: n.body_template,
    enabled: n.enabled,
  };
}

/**
 * Import a portable config document. When `dryRun` is set, computes and returns
 * the full plan without writing. Otherwise applies the plan in one transaction,
 * rolling back everything on any referential failure.
 */
export async function importConfig(
  options: ImportConfigOptions
): Promise<ImportPlan> {
  const db = options.db ?? getDb();
  const mode: ImportMode = options.mode ?? "merge";
  const dryRun = options.dryRun ?? false;

  const doc = validateDocument(options.document);
  const docPlaybooks = readPlaybooks(doc);
  const docRules = readRules(doc);
  const docNotifiers = readNotifiers(doc);
  const docSnippets = readSnippets(doc);
  const docModules = isPlainObject(doc.modules) ? doc.modules : {};
  const docSettings = importableSettings(doc);

  // Validate optional per-playbook fields up-front so a dry-run rejects a bad
  // document exactly as an apply would (readIsolation throws on a bad value).
  for (const pb of docPlaybooks) readIsolation(pb);
  // Similarly validate each rule's notify shape up-front so a dry-run rejects
  // a bad notify array exactly as an apply would.
  for (const rule of docRules) readRuleNotify(rule);

  // Index document playbooks by their stable key so rule dispatch targets can be
  // resolved back to the local playbook once ids are assigned.
  const docPlaybooksByKey = new Map<string, ExportedPlaybook>();
  for (const pb of docPlaybooks) docPlaybooksByKey.set(playbookKeyOf(pb), pb);

  // Snapshot local state to plan create/skip/overwrite decisions.
  const [localPlaybooks, localRules, localNotifiers, localSnippets] =
    await Promise.all([
      listPlaybooks(db),
      listRules(db),
      listNotifiers(db),
      listSnippets(undefined, db),
    ]);
  const localPlaybookNames = new Set(localPlaybooks.map((p) => p.name));
  const localRuleNames = new Set(localRules.map((r) => r.name));
  const localNotifierNames = new Set(localNotifiers.map((n) => n.name));
  const localSnippetKeys = new Set(localSnippets.map(snippetKeyOf));

  const decide = (exists: boolean): ImportAction =>
    exists ? (mode === "overwrite" ? "overwrite" : "skip") : "create";

  const playbookPlan: ImportPlanItem[] = docPlaybooks.map((pb) => ({
    key: pb.name,
    action: decide(localPlaybookNames.has(pb.name)),
  }));
  const rulePlan: ImportPlanItem[] = docRules.map((rule) => ({
    key: rule.name,
    action: decide(localRuleNames.has(rule.name)),
  }));
  const notifierPlan: ImportPlanItem[] = docNotifiers.map((n) => ({
    key: n.name,
    action: decide(localNotifierNames.has(n.name)),
  }));
  const snippetPlan: ImportPlanItem[] = docSnippets.map((s) => ({
    key: snippetKeyOf(s),
    action: decide(localSnippetKeys.has(snippetKeyOf(s))),
  }));

  // Module/setting collision checks read the DB per key.
  const modulePlan: ImportPlanItem[] = [];
  for (const moduleId of Object.keys(docModules)) {
    const existing = await getModuleConfig(moduleId, db);
    modulePlan.push({ key: moduleId, action: decide(existing !== undefined) });
  }
  const settingPlan: ImportPlanItem[] = [];
  for (const { key } of docSettings) {
    const existing = await getSetting(key, undefined, db);
    settingPlan.push({ key, action: decide(existing !== undefined) });
  }

  // Referential integrity: the set of playbook names resolvable after import is
  // every local playbook plus every playbook this document defines. A rule that
  // dispatches outside that set is a hard failure in both dry-run and apply.
  const namesAfter = new Set(localPlaybookNames);
  for (const pb of docPlaybooks) namesAfter.add(pb.name);
  const resolvableAfter = (key: string | null): boolean => {
    if (key === null) return false;
    const docPb = docPlaybooksByKey.get(key);
    return namesAfter.has(docPb ? docPb.name : key);
  };
  for (const rule of docRules) {
    const dispatch = Array.isArray(rule.dispatch) ? rule.dispatch : [];
    for (const target of dispatch) {
      if (!resolvableAfter(target.playbook)) {
        throw new ImportError(
          `rule "${rule.name}" dispatches to playbook ` +
            `${JSON.stringify(target.playbook)}, which is neither in the ` +
            `document nor already in the local database`,
          409
        );
      }
    }
  }

  // Same referential integrity check for notifiers: a rule's notify target must
  // resolve to a notifier defined in this document or already present locally.
  const notifierNamesAfter = new Set(localNotifierNames);
  for (const n of docNotifiers) notifierNamesAfter.add(n.name);
  for (const rule of docRules) {
    const notify = readRuleNotify(rule);
    for (const target of notify) {
      if (target.notifier === null || !notifierNamesAfter.has(target.notifier)) {
        throw new ImportError(
          `rule "${rule.name}" notifies notifier ` +
            `${JSON.stringify(target.notifier)}, which is neither in the ` +
            `document nor already in the local database`,
          409
        );
      }
    }
  }

  // missing_secrets: manifest names not present in the local store (names only).
  const localSecretNames = new Set(options.secretNames);
  const missingSecrets = readRequiredSecrets(doc).filter(
    (s) => !localSecretNames.has(s.name)
  );

  // Checklist bits that don't depend on writes.
  const localIdentity = (await getSetting(IDENTITY_ME_SETTING, "", db)) ?? "";
  const modulesToReview = modulePlan
    .filter((m) => m.action !== "skip")
    .map((m) => m.key);
  // The effective default_lease_image: the document's value when it will be
  // written, otherwise whatever is (or stays) local.
  const settingByKey = new Map(docSettings.map((s) => [s.key, s.value]));
  const willWriteImage = settingPlan.some(
    (s) => s.key === DEFAULT_LEASE_IMAGE_SETTING && s.action !== "skip"
  );
  const localImage = await getSetting(DEFAULT_LEASE_IMAGE_SETTING, undefined, db);
  const effectiveImage = willWriteImage
    ? (settingByKey.get(DEFAULT_LEASE_IMAGE_SETTING) ?? null)
    : (localImage ?? null);

  const checklist: PostImportChecklist = {
    secrets_to_create: missingSecrets.map((s) => s.name),
    identity_me: localIdentity,
    modules_to_review: modulesToReview,
    default_lease_image: effectiveImage,
  };

  const plan: ImportPlan = {
    mode,
    dry_run: dryRun,
    applied: false,
    playbooks: playbookPlan,
    rules: rulePlan,
    notifiers: notifierPlan,
    snippets: snippetPlan,
    modules: modulePlan,
    settings: settingPlan,
    missing_secrets: missingSecrets,
    post_import_checklist: checklist,
  };

  if (dryRun) return plan;

  // Apply everything in one transaction: any failure rolls the whole import back.
  await db.transaction(async (trx) => {
    // Playbooks first, so their ids exist before rules reference them.
    for (const pb of docPlaybooks) {
      const action = decide(localPlaybookNames.has(pb.name));
      if (action === "skip") continue;
      if (action === "create") {
        await createPlaybook(toNewPlaybook(pb), trx);
      } else {
        const existing = localPlaybooks.find((p) => p.name === pb.name);
        if (existing) await updatePlaybook(existing.id, toNewPlaybook(pb), trx);
      }
    }

    // Notifiers next: their ids must exist before rules that notify them are
    // written. A local notifier of the same name is skipped (merge) or
    // overwritten in place (overwrite); its id is preserved either way, so
    // pre-existing rules that referenced it locally keep working.
    for (const n of docNotifiers) {
      const action = decide(localNotifierNames.has(n.name));
      if (action === "skip") continue;
      if (action === "create") {
        await createNotifier(toNewNotifier(n), trx);
      } else {
        const existing = localNotifiers.find((local) => local.name === n.name);
        if (existing) await updateNotifier(existing.id, toNewNotifier(n), trx);
      }
    }

    // Rebuild the name->id map from the post-playbook state so rule dispatch can
    // be remapped whether the target playbook is new, overwritten, or pre-existing.
    const afterPlaybooks = await listPlaybooks(trx);
    const nameToId = new Map<string, number>();
    for (const p of afterPlaybooks) nameToId.set(p.name, p.id);

    // Same rebuild for notifiers, so a rule.notify target resolves whether the
    // notifier is new, overwritten, or pre-existing.
    const afterNotifiers = await listNotifiers(trx);
    const notifierNameToId = new Map<string, number>();
    for (const n of afterNotifiers) notifierNameToId.set(n.name, n.id);

    for (const rule of docRules) {
      const action = decide(localRuleNames.has(rule.name));
      if (action === "skip") continue;
      const dispatch = remapDispatch(rule, docPlaybooksByKey, nameToId);
      const notify = remapNotify(rule, notifierNameToId);
      const match = (rule.match ?? {}) as RuleMatch;
      if (action === "create") {
        await createRule(
          { name: rule.name, enabled: rule.enabled, match, dispatch, notify },
          trx
        );
      } else {
        const existing = localRules.find((r) => r.name === rule.name);
        if (existing) {
          await updateRule(
            existing.id,
            {
              name: rule.name,
              enabled: rule.enabled,
              match,
              dispatch,
              notify,
            },
            trx
          );
        }
      }
    }

    // Snippets, keyed by (kind, name). An overwrite patches description and
    // content in place, keeping the local row's id so nothing referencing it by
    // name resolves differently afterward.
    for (const s of docSnippets) {
      const action = decide(localSnippetKeys.has(snippetKeyOf(s)));
      if (action === "skip") continue;
      if (action === "create") {
        await createSnippet(
          {
            kind: s.kind,
            name: s.name,
            description: s.description,
            content: s.content,
          },
          trx
        );
      } else {
        const existing = localSnippets.find(
          (local) => local.kind === s.kind && local.name === s.name
        );
        if (existing) {
          await updateSnippet(
            existing.id,
            { description: s.description, content: s.content },
            trx
          );
        }
      }
    }

    // Module configs — always stored disabled.
    for (const [moduleId, config] of Object.entries(docModules)) {
      const existing = await getModuleConfig(moduleId, trx);
      const action = decide(existing !== undefined);
      if (action === "skip") continue;
      await setModuleConfig(moduleId, disabledModuleConfig(config), trx);
    }

    // Whitelisted settings (identity_me already excluded).
    for (const { key, value } of docSettings) {
      const existing = await getSetting(key, undefined, trx);
      const action = decide(existing !== undefined);
      if (action === "skip") continue;
      await setSetting(key, value, trx);
    }
  });

  plan.applied = true;
  return plan;
}

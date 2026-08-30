import type { Knex } from "knex";

import { getDb } from "../db/db";
import { listModuleConfigs } from "../db/moduleConfig";
import { listNotifiers } from "../db/notifiers";
import { listPlaybooks } from "../db/playbooks";
import { listRules } from "../db/rules";
import { getAllSettings } from "../db/settings";
import { listSnippets } from "../db/snippets";
import { DEFAULT_LEASE_IMAGE_SETTING } from "../executor/executor";
import { envRequirementName } from "../executor/executor";
import type {
  EnvRequirement,
  LeaseIsolation,
  NotifierRecord,
  PlaybookRecord,
  SnippetKind,
  SnippetRecord,
} from "../interfaces";
import { IDENTITY_ME_SETTING } from "../services/eventIntake";

import { KNOWN_SETTING_KEYS } from "../routers/settingsRouter";

/**
 * config export — a single portable JSON document describing one orchestrator's
 * automation setup (playbooks, rules with their dispatch AND notify targets,
 * notifiers, snippets, module config, whitelisted settings) so it can be
 * reproduced on another instance.
 *
 * SECRET HYGIENE (load-bearing). This module NEVER imports or touches the secret
 * store: it reads only playbooks, rules, notifiers, snippets, module_config, and
 * app_settings. The document references secrets by NAME only. As defense in
 * depth, the caller passes in the currently stored secret {name, value} pairs
 * and {@link exportConfig} scans the serialized document for any of those
 * values, FAILING loudly (a {@link SecretLeakError}) rather than masking: a
 * template (or a notifier's `config`) holding a pasted secret value is a leak
 * the user must fix, not something to paper over. Notifier secret-bearing
 * fields therefore round-trip only when they reference a secret by NAME (like a
 * playbook's `env_requirements` or a module's `pat_secret_ref`); a pasted VALUE
 * fails export.
 *
 * Runtime state (events, dispatches, runs, findings, leases) is never
 * exported. Modules are always exported DISABLED so an imported config can never
 * poll or dispatch until a human re-enables it. Notifiers preserve their
 * `enabled` bit: a notifier is a reactive outbound sink that fires only when a
 * matched rule targets it, so it cannot poll or dispatch on its own; the sibling
 * rule's `enabled` bit already gates whether notifications happen at all.
 *
 * Schema version history:
 *  - 1: initial. Playbooks, rules (dispatch only), snippets, modules, settings.
 *  - 2 (current): adds `notifiers[]` and per-rule `notify[]` targets referencing
 *    notifiers by NAME. A v1 document imports cleanly (its notifiers/notify
 *    default to empty); see the importer's back-compat handling.
 */

/** The current export document schema version. Bump on any breaking shape change. */
export const EXPORT_SCHEMA_VERSION = 2;

/** Schema versions this build's importer will read. Newest first. */
export const SUPPORTED_IMPORT_SCHEMA_VERSIONS: readonly number[] = [2, 1];

/** The document `kind` discriminator, so an importer can sanity-check input. */
export const EXPORT_KIND = "orchestrator-config-export";

/** One entry in the generated `required_secrets` manifest — a NAME and its uses. */
export interface RequiredSecret {
  name: string;
  used_by: string[];
}

/** A rule's dispatch target rewritten to reference its playbook by stable key. */
export interface ExportedDispatchTarget {
  /** The target playbook's stable key (its name), or null when unresolvable. */
  playbook: string | null;
  bindings?: Record<string, unknown>;
}

/**
 * A rule's notify target rewritten to reference its notifier by stable key
 * (name). Null when the numeric notifier id no longer resolves, the same
 * dangling shape a dispatch target uses.
 */
export interface ExportedNotifyTarget {
  /** The target notifier's stable key (its name), or null when unresolvable. */
  notifier: string | null;
}

/**
 * A rule as exported: no numeric ids, dispatch keyed by playbook name and
 * notify keyed by notifier name. `notify` is always present (empty array when
 * the rule has none) so a diff of two exports is stable.
 */
export interface ExportedRule {
  name: string;
  enabled: boolean;
  match: unknown;
  dispatch: ExportedDispatchTarget[];
  notify: ExportedNotifyTarget[];
}

/**
 * A notifier as exported: identified by its `name`, with templates, `enabled`
 * bit, and free-form `config` carried through. Numeric ids and timestamps are
 * dropped.
 *
 * SECRET HYGIENE: `config` is an opaque, user-defined blob (the app never
 * branches on its content). Any secret-bearing field a user places in it
 * should reference the secret by NAME, exactly like a playbook's
 * `env_requirements` or a module's `pat_secret_ref`; a pasted secret VALUE is
 * caught by the exporter's leak scan and fails the export loudly.
 */
export interface ExportedNotifier {
  name: string;
  title_template: string;
  body_template: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** A playbook as exported: its full definition keyed by name, no numeric ids. */
export interface ExportedPlaybook {
  key: string;
  name: string;
  image: string;
  /**
   * Optional lease isolation level (see {@link PlaybookRecord.isolation}). `null`
   * means "let the server apply its default"; carried through so an imported
   * config reproduces the source playbook's isolation.
   */
  isolation: LeaseIsolation | null;
  ttl_seconds: number;
  resources: unknown;
  network: string;
  userdata_template: string;
  prompt_template: string;
  runner: string;
  runner_config: Record<string, unknown>;
  env_requirements: EnvRequirement[];
  steps: unknown[];
  granted_capabilities: unknown[];
  output_kind: string;
}

/**
 * A snippet as exported: identified by its (kind, name) pair — the same identity
 * references resolve against at dispatch time — with numeric ids and timestamps
 * dropped.
 */
export interface ExportedSnippet {
  kind: SnippetKind;
  name: string;
  description: string;
  content: string;
}

/** The full export document. */
export interface ConfigExportDocument {
  kind: typeof EXPORT_KIND;
  schema_version: number;
  exported_at: string;
  app_settings: Record<string, string>;
  modules: Record<string, unknown>;
  playbooks: ExportedPlaybook[];
  rules: ExportedRule[];
  notifiers: ExportedNotifier[];
  snippets: ExportedSnippet[];
  required_secrets: RequiredSecret[];
}

/**
 * A per-export exclusion set: names of playbooks / rules / snippets / notifiers
 * to leave out of the produced document. Names key against the exported
 * document (a playbook by its `name`, a rule by its `name`, a notifier by its
 * `name`, a snippet by its `kind:name` key (snippet identity is (kind, name);
 * the exclude entry must carry the kind prefix, e.g. `prompt:greeting`, and
 * only that exact snippet is dropped). Selections
 * are per-export only; nothing is persisted anywhere. Unknown names are a
 * validation error (see {@link UnknownExclusionError}).
 */
export interface ExportExclude {
  playbooks?: string[];
  rules?: string[];
  snippets?: string[];
  notifiers?: string[];
}

/**
 * One entry in an export's `warnings` array. Names an included rule whose
 * dispatch or notify target refers to an excluded (or never-exported) entity,
 * so the caller knows the import side must already have it.
 */
export interface ExportWarning {
  /** The rule whose target is unresolvable within this document. */
  rule: string;
  /** Which target kind is dangling: dispatch (a playbook) or notify. */
  kind: "dispatch" | "notify";
  /** The missing entity's name (playbook or notifier). */
  target: string;
  /** A human-readable one-liner suitable for direct display. */
  message: string;
}

/** A currently stored secret, passed in by the caller for the leak scan only. */
export interface SecretEntry {
  name: string;
  value: string;
}

/** Options for {@link exportConfig}. */
export interface ExportConfigOptions {
  /** ISO timestamp stamped as `exported_at` (injected so the module stays pure). */
  nowIso: string;
  /**
   * Currently stored secrets, used ONLY for the post-serialization leak scan.
   * The exporter never reads the store itself; the caller supplies these.
   */
  secrets: SecretEntry[];
  /**
   * When "environment", additionally blank environment identifiers
   * (`modules.*.org`, `modules.*.project`, `app_settings.default_lease_image`)
   * for public sharing.
   */
  scrub?: "environment";
  /**
   * Per-export exclusion set (names). Chosen at export time by the caller (the
   * dialog on the Settings page); nothing is persisted anywhere. Excluding a
   * notifier ALSO drops it from every remaining rule's notify targets, because
   * the importer 409s on a dangling notify name. Excluding a playbook leaves
   * every rule that dispatches it intact; the response's `warnings` names each
   * such rule so the caller knows the import side must already have the
   * referenced playbook (or that the target was dangling in the source).
   * Unknown names throw {@link UnknownExclusionError}.
   */
  exclude?: ExportExclude;
  db?: Knex;
}

/** The result of an export: the document itself plus any dangling-reference warnings. */
export interface ExportConfigResult {
  document: ConfigExportDocument;
  warnings: ExportWarning[];
}

/**
 * Raised when the serialized document is found to contain a currently stored
 * secret VALUE. The message names the offending object and the secret. The
 * export is aborted — we never mask-and-continue.
 */
export class SecretLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretLeakError";
  }
}

/**
 * Raised when an {@link ExportConfigOptions.exclude} entry names something that
 * is not in the corresponding group. The message lists every unknown name in
 * each group so the caller can render a single 400 with the full list.
 */
export class UnknownExclusionError extends Error {
  readonly unknown: {
    playbooks: string[];
    rules: string[];
    snippets: string[];
    notifiers: string[];
  };
  constructor(unknown: UnknownExclusionError["unknown"]) {
    const parts: string[] = [];
    for (const group of ["playbooks", "rules", "snippets", "notifiers"] as const) {
      if (unknown[group].length > 0) {
        parts.push(`${group}: ${unknown[group].map((n) => JSON.stringify(n)).join(", ")}`);
      }
    }
    super(`unknown exclude entries: ${parts.join("; ")}`);
    this.name = "UnknownExclusionError";
    this.unknown = unknown;
  }
}

/**
 * Build the exported form of one playbook. The stable `key` is the playbook
 * name; numeric ids and timestamps are dropped.
 */
function exportPlaybook(p: PlaybookRecord): ExportedPlaybook {
  return {
    key: p.name,
    name: p.name,
    image: p.image,
    isolation: p.isolation ?? null,
    ttl_seconds: p.ttl_seconds,
    resources: p.resources,
    network: p.network,
    userdata_template: p.userdata_template,
    prompt_template: p.prompt_template,
    runner: p.runner,
    runner_config: p.runner_config,
    env_requirements: p.env_requirements,
    steps: p.steps,
    granted_capabilities: p.granted_capabilities,
    output_kind: p.output_kind,
  };
}

/**
 * Build the exported form of one snippet: its (kind, name) identity plus
 * description and content; numeric ids and timestamps are dropped.
 */
function exportSnippet(s: SnippetRecord): ExportedSnippet {
  return {
    kind: s.kind,
    name: s.name,
    description: s.description,
    content: s.content,
  };
}

/**
 * Build the exported form of one notifier: identified by name, with templates,
 * `enabled` bit, and `config` blob carried through; numeric ids and timestamps
 * are dropped. The exporter does NOT try to strip "secret-bearing" fields from
 * `config`: it cannot know which keys are secrets (that would be a domain
 * branch in the core). Users reference secrets by NAME in `config` for
 * round-trip safety; a pasted secret VALUE is caught by the leak scan and fails
 * the export loudly.
 */
function exportNotifier(n: NotifierRecord): ExportedNotifier {
  return {
    name: n.name,
    title_template: n.title_template,
    body_template: n.body_template,
    enabled: n.enabled,
    config: n.config,
  };
}

/** Read a top-level `pat_secret_ref` string from a module config, if present. */
function patSecretRefOf(config: unknown): string | undefined {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const ref = (config as Record<string, unknown>).pat_secret_ref;
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  return undefined;
}

/**
 * Produce the module's exported config: a shallow copy with `enabled` FORCED to
 * false unconditionally, and — under `scrub=environment` — `org`/`project`
 * blanked. `pat_secret_ref` (a NAME) is preserved.
 */
function exportModuleConfig(
  config: unknown,
  scrub: boolean
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config && typeof config === "object" && !Array.isArray(config)
      ? { ...(config as Record<string, unknown>) }
      : {};
  // An imported config must never poll or dispatch until a human re-enables it.
  base.enabled = false;
  if (scrub) {
    if ("org" in base) base.org = "";
    if ("project" in base) base.project = "";
  }
  return base;
}

/**
 * Recursively scan `value` for any stored secret value. `label` is a
 * human-readable path to the value being scanned (e.g.
 * `playbook crew-bug-researcher userdata_template`). Throws {@link
 * SecretLeakError} at the first hit, naming the object and the secret.
 */
function scanForSecrets(
  label: string,
  value: unknown,
  secrets: SecretEntry[]
): void {
  if (typeof value === "string") {
    for (const secret of secrets) {
      // A zero-length secret would "match" every string; skip it. Real secrets
      // are never empty, but a defensive guard keeps the scan from false-firing.
      if (secret.value.length > 0 && value.includes(secret.value)) {
        throw new SecretLeakError(
          `${label} contains the value of secret ${secret.name}`
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => scanForSecrets(`${label}[${i}]`, el, secrets));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      scanForSecrets(label ? `${label} ${k}` : k, v, secrets);
    }
  }
}

/**
 * The stable identity string for an exported snippet: `<kind>:<name>`. Matches
 * the importer's plan key so a UI that shows one and passes the other back is
 * consistent. Excluded snippets are keyed the same way.
 */
export function snippetIdentity(s: { kind: SnippetKind; name: string }): string {
  return `${s.kind}:${s.name}`;
}

/**
 * Build (and secret-scan) the portable config export document. Reads only
 * playbooks, rules, snippets, module_config, and app_settings — never the
 * secret store. Throws {@link SecretLeakError} when a stored secret value
 * appears anywhere in the document. When `exclude` is set, filters the named
 * playbooks / rules / snippets / notifiers out and returns any dangling-
 * reference warnings for included rules whose dispatch or notify target is
 * excluded or was already unresolvable in the source.
 */
export async function exportConfig(
  options: ExportConfigOptions
): Promise<ExportConfigResult> {
  const db = options.db ?? getDb();
  const scrub = options.scrub === "environment";
  const exclude = options.exclude ?? {};

  const [playbooks, rules, notifiers, snippets, moduleConfigs, allSettings] =
    await Promise.all([
      listPlaybooks(db),
      listRules(db),
      listNotifiers(db),
      listSnippets(undefined, db),
      listModuleConfigs(db),
      getAllSettings(db),
    ]);

  // playbook id -> stable key (name), so rule dispatch targets can be rewritten
  // to reference playbooks by key instead of the numeric id.
  const keyById = new Map<number, string>();
  for (const p of playbooks) keyById.set(p.id, p.name);

  // notifier id -> stable key (name), so rule notify targets can be rewritten
  // to reference notifiers by key instead of the numeric id.
  const notifierNameById = new Map<number, string>();
  for (const n of notifiers) notifierNameById.set(n.id, n.name);

  const allPlaybookNames = new Set(playbooks.map((p) => p.name));
  const allRuleNames = new Set(rules.map((r) => r.name));
  const allNotifierNames = new Set(notifiers.map((n) => n.name));
  const allSnippetKeys = new Set(snippets.map(snippetIdentity));

  // Validate exclusions up-front: any name that does not match a currently
  // known entry is a caller error and 400s with the full list per group.
  const excludePlaybooks = new Set(exclude.playbooks ?? []);
  const excludeRules = new Set(exclude.rules ?? []);
  const excludeNotifiers = new Set(exclude.notifiers ?? []);
  const excludeSnippets = new Set(exclude.snippets ?? []);
  const unknown: UnknownExclusionError["unknown"] = {
    playbooks: [...excludePlaybooks].filter((n) => !allPlaybookNames.has(n)),
    rules: [...excludeRules].filter((n) => !allRuleNames.has(n)),
    notifiers: [...excludeNotifiers].filter((n) => !allNotifierNames.has(n)),
    snippets: [...excludeSnippets].filter((n) => !allSnippetKeys.has(n)),
  };
  if (
    unknown.playbooks.length +
      unknown.rules.length +
      unknown.notifiers.length +
      unknown.snippets.length >
    0
  ) {
    throw new UnknownExclusionError(unknown);
  }

  const exportedPlaybooks = playbooks
    .filter((p) => !excludePlaybooks.has(p.name))
    .map(exportPlaybook);

  // Notifiers are listed newest-first for the UI; sort by name so exports of
  // the same setup are diffable.
  const exportedNotifiers = notifiers
    .filter((n) => !excludeNotifiers.has(n.name))
    .map(exportNotifier)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Snippets are listed newest-first for the UI; sort by (kind, name) — their
  // stable identity — so exports of the same setup are diffable.
  const exportedSnippets = snippets
    .filter((s) => !excludeSnippets.has(snippetIdentity(s)))
    .map(exportSnippet)
    .sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind.localeCompare(b.kind)
    );

  // Included playbooks (by name), used both to shape the rule warnings and to
  // rebuild required_secrets from only the surviving playbooks.
  const includedPlaybookNames = new Set(exportedPlaybooks.map((p) => p.name));

  const warnings: ExportWarning[] = [];

  const exportedRules: ExportedRule[] = rules
    .filter((r) => !excludeRules.has(r.name))
    .map((rule) => {
      const dispatch: ExportedDispatchTarget[] = rule.dispatch.map((target) => {
        const playbookName = keyById.get(target.playbook_id) ?? null;
        const out: ExportedDispatchTarget = { playbook: playbookName };
        if (target.bindings !== undefined) out.bindings = target.bindings;
        // Warn when the dispatch target was already unresolvable in the source
        // OR when the referenced playbook exists but was excluded from this
        // export. Either way the import side must already have it.
        if (playbookName === null) {
          warnings.push({
            rule: rule.name,
            kind: "dispatch",
            target: "",
            message: `rule ${JSON.stringify(rule.name)} dispatches to a playbook that was unresolvable at export time; the import side must already have the intended playbook`,
          });
        } else if (!includedPlaybookNames.has(playbookName)) {
          warnings.push({
            rule: rule.name,
            kind: "dispatch",
            target: playbookName,
            message: `rule ${JSON.stringify(rule.name)} dispatches to excluded playbook ${JSON.stringify(playbookName)}; the import side must already have it`,
          });
        }
        return out;
      });

      // Notify targets that reference an EXCLUDED notifier are DROPPED (the
      // importer 409s on a dangling notify name). A target that was already
      // null in the source is kept and warned; the user can decide whether the
      // import side already has the intended notifier.
      const notify: ExportedNotifyTarget[] = [];
      for (const target of rule.notify) {
        const notifierName = notifierNameById.get(target.notifier_id) ?? null;
        if (notifierName !== null && excludeNotifiers.has(notifierName)) {
          // Dropped silently: an excluded notifier is a deliberate opt-out
          // no warning, else the dialog would spam warnings for every rule
          // that used to notify it.
          continue;
        }
        if (notifierName === null) {
          warnings.push({
            rule: rule.name,
            kind: "notify",
            target: "",
            message: `rule ${JSON.stringify(rule.name)} notifies a notifier that was unresolvable at export time; the import side must already have the intended notifier`,
          });
        }
        notify.push({ notifier: notifierName });
      }

      return {
        name: rule.name,
        enabled: rule.enabled,
        match: rule.match,
        dispatch,
        notify,
      };
    });

  const modules: Record<string, unknown> = {};
  for (const entry of moduleConfigs) {
    modules[entry.module_id] = exportModuleConfig(entry.config, scrub);
  }

  // app_settings: whitelisted keys only, excluding the environment-bound
  // personal identity. default_lease_image is blanked under scrub.
  const app_settings: Record<string, string> = {};
  for (const key of KNOWN_SETTING_KEYS) {
    if (key === IDENTITY_ME_SETTING) continue;
    const value = allSettings[key];
    if (value === undefined) continue;
    app_settings[key] =
      scrub && key === DEFAULT_LEASE_IMAGE_SETTING ? "" : value;
  }

  // required_secrets: union of every INCLUDED playbook's env_requirements plus
  // every module pat_secret_ref. Names only, each with a list of human-readable
  // uses. Excluded playbooks contribute no rows: their env requirements are
  // irrelevant to the filtered document.
  const usesByName = new Map<string, string[]>();
  const addUse = (name: string, use: string): void => {
    const uses = usesByName.get(name);
    if (uses) {
      if (!uses.includes(use)) uses.push(use);
    } else {
      usesByName.set(name, [use]);
    }
  };
  for (const p of exportedPlaybooks) {
    for (const req of p.env_requirements) {
      addUse(envRequirementName(req), `playbook:${p.key} (env)`);
    }
  }
  for (const entry of moduleConfigs) {
    const ref = patSecretRefOf(entry.config);
    if (ref) addUse(ref, `module:${entry.module_id} (pat_secret_ref)`);
  }
  const required_secrets: RequiredSecret[] = [...usesByName.keys()]
    .sort()
    .map((name) => ({ name, used_by: usesByName.get(name)! }));

  const doc: ConfigExportDocument = {
    kind: EXPORT_KIND,
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: options.nowIso,
    app_settings,
    modules,
    playbooks: exportedPlaybooks,
    rules: exportedRules,
    notifiers: exportedNotifiers,
    snippets: exportedSnippets,
    required_secrets,
  };

  // Defense in depth: scan every exported section for any stored secret VALUE
  // and fail loudly, naming the offending object. Runs on the FILTERED
  // document, so an excluded object cannot cause a leak that never leaves.
  for (const p of doc.playbooks) {
    scanForSecrets(`playbook ${p.key}`, p, options.secrets);
  }
  for (const [id, config] of Object.entries(doc.modules)) {
    scanForSecrets(`module ${id}`, config, options.secrets);
  }
  for (const rule of doc.rules) {
    scanForSecrets(`rule ${rule.name}`, rule, options.secrets);
  }
  for (const n of doc.notifiers) {
    scanForSecrets(`notifier ${n.name}`, n, options.secrets);
  }
  for (const s of doc.snippets) {
    scanForSecrets(`snippet ${s.kind}:${s.name}`, s, options.secrets);
  }
  for (const [key, value] of Object.entries(doc.app_settings)) {
    scanForSecrets(`app_settings ${key}`, value, options.secrets);
  }

  return { document: doc, warnings };
}

import type { Knex } from "knex";

import { getDb } from "../db/db";
import { listModuleConfigs } from "../db/moduleConfig";
import { listPlaybooks } from "../db/playbooks";
import { listRules } from "../db/rules";
import { getAllSettings } from "../db/settings";
import { listSnippets } from "../db/snippets";
import { DEFAULT_LEASE_IMAGE_SETTING } from "../executor/executor";
import { envRequirementName } from "../executor/executor";
import type {
  EnvRequirement,
  LeaseIsolation,
  PlaybookRecord,
  SnippetKind,
  SnippetRecord,
} from "../interfaces";
import { IDENTITY_ME_SETTING } from "../services/eventIntake";

import { KNOWN_SETTING_KEYS } from "../routers/settingsRouter";

/**
 * config export — a single portable JSON document describing one orchestrator's
 * automation setup (playbooks, rules, snippets, module config, whitelisted
 * settings) so it can be reproduced on another instance.
 *
 * SECRET HYGIENE (load-bearing). This module NEVER imports or touches the secret
 * store: it reads only playbooks, rules, snippets, module_config, and
 * app_settings. The document references secrets by NAME only. As defense in depth, the caller
 * passes in the currently stored secret {name, value} pairs and {@link
 * exportConfig} scans the serialized document for any of those values, FAILING
 * loudly (a {@link SecretLeakError}) rather than masking — a template holding a
 * pasted secret value is a leak the user must fix, not something to paper over.
 *
 * Runtime state — events, dispatches, runs, findings, leases — is never
 * exported. Modules are always exported DISABLED so an imported config can never
 * poll or dispatch until a human re-enables it.
 */

/** The current export document schema version. Bump on any breaking shape change. */
export const EXPORT_SCHEMA_VERSION = 1;

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

/** A rule as exported: no numeric ids, dispatch keyed by playbook name. */
export interface ExportedRule {
  name: string;
  enabled: boolean;
  match: unknown;
  dispatch: ExportedDispatchTarget[];
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
  snippets: ExportedSnippet[];
  required_secrets: RequiredSecret[];
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
  db?: Knex;
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
 * Build (and secret-scan) the portable config export document. Reads only
 * playbooks, rules, snippets, module_config, and app_settings — never the
 * secret store. Throws {@link SecretLeakError} when a stored secret value
 * appears anywhere in the document.
 */
export async function exportConfig(
  options: ExportConfigOptions
): Promise<ConfigExportDocument> {
  const db = options.db ?? getDb();
  const scrub = options.scrub === "environment";

  const [playbooks, rules, snippets, moduleConfigs, allSettings] =
    await Promise.all([
      listPlaybooks(db),
      listRules(db),
      listSnippets(undefined, db),
      listModuleConfigs(db),
      getAllSettings(db),
    ]);

  // playbook id -> stable key (name), so rule dispatch targets can be rewritten
  // to reference playbooks by key instead of the numeric id.
  const keyById = new Map<number, string>();
  for (const p of playbooks) keyById.set(p.id, p.name);

  const exportedPlaybooks = playbooks.map(exportPlaybook);

  // Snippets are listed newest-first for the UI; sort by (kind, name) — their
  // stable identity — so exports of the same setup are diffable.
  const exportedSnippets = snippets
    .map(exportSnippet)
    .sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind.localeCompare(b.kind)
    );

  const exportedRules: ExportedRule[] = rules.map((rule) => ({
    name: rule.name,
    enabled: rule.enabled,
    match: rule.match,
    dispatch: rule.dispatch.map((target) => {
      const out: ExportedDispatchTarget = {
        playbook: keyById.get(target.playbook_id) ?? null,
      };
      if (target.bindings !== undefined) out.bindings = target.bindings;
      return out;
    }),
  }));

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

  // required_secrets: union of every playbook env_requirements entry and every
  // module pat_secret_ref. Names only, each with a list of human-readable uses.
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
    snippets: exportedSnippets,
    required_secrets,
  };

  // Defense in depth: scan every exported section for any stored secret VALUE
  // and fail loudly, naming the offending object. We never mask-and-continue.
  for (const p of doc.playbooks) {
    scanForSecrets(`playbook ${p.key}`, p, options.secrets);
  }
  for (const [id, config] of Object.entries(doc.modules)) {
    scanForSecrets(`module ${id}`, config, options.secrets);
  }
  for (const rule of doc.rules) {
    scanForSecrets(`rule ${rule.name}`, rule, options.secrets);
  }
  for (const s of doc.snippets) {
    scanForSecrets(`snippet ${s.kind}:${s.name}`, s, options.secrets);
  }
  for (const [key, value] of Object.entries(doc.app_settings)) {
    scanForSecrets(`app_settings ${key}`, value, options.secrets);
  }

  return doc;
}

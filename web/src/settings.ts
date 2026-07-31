// Typed data-access helpers for the Settings page. Wraps three backends: the
// whitelisted `app_settings` editor (`/api/settings`), the read-only host info
// (`/api/settings/system`), and the write-only secret store (`/api/secrets`).
// Secret VALUES never cross this boundary in either direction — the store is
// name-only on read and write-only on set.

import { apiFetch } from "./api";

/** Every stored setting as a `{key: value}` map (values are always strings). */
export type SettingsMap = Record<string, string>;

/** Read-only host facts sourced from the boot config, displayed but not edited. */
export interface SystemInfo {
  /** Base URL of the local wisper-api. */
  wisperBaseUrl: string;
  /** The configured wisper hostId, or null when leasing is not configured. */
  wisperHostId: string | null;
  /** The wisper client mode: `dev` (local harness) or `v1` (authenticated). */
  wisperMode: "dev" | "v1";
  /** Whether the WISPER_API_KEY secret is set. Never the value — a flag only. */
  wisperApiKeyPresent: boolean;
}

/** Fetch every stored setting as a map. */
export function getSettings(): Promise<SettingsMap> {
  return apiFetch<SettingsMap>(`/settings`);
}

/** Read-only host info the Settings page displays (wisper base URL + hostId). */
export function getSystemInfo(): Promise<SystemInfo> {
  return apiFetch<SystemInfo>(`/settings/system`);
}

/** Upsert one whitelisted setting; resolves to the stored `{key, value}`. */
export function putSetting(
  key: string,
  value: string,
): Promise<{ key: string; value: string }> {
  return apiFetch<{ key: string; value: string }>(`/settings`, {
    method: "PUT",
    body: { key, value },
  });
}

/** List the stored secret NAMES only — a value is never returned by the API. */
export function listSecrets(): Promise<string[]> {
  return apiFetch<{ keys: string[] }>(`/secrets`).then((r) => r.keys);
}

/** Add or replace a secret by name. The value is write-only; only the name echoes back. */
export function putSecret(
  key: string,
  value: string,
): Promise<{ key: string }> {
  return apiFetch<{ key: string }>(`/secrets`, {
    method: "PUT",
    body: { key, value },
  });
}

/** Delete a secret by name (idempotent). */
export function deleteSecret(key: string): Promise<void> {
  return apiFetch<void>(`/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

/** Fetch the portable config export document (playbooks/rules/snippets/modules/settings). */
export function getConfigExport(): Promise<unknown> {
  return apiFetch<unknown>(`/config/export`);
}

/** Import collision strategy: skip name collisions, or replace them. */
export type ImportMode = "merge" | "overwrite";

/** What an import did (or would do, in dry-run) to a single object. */
export type ImportAction = "create" | "skip" | "overwrite";

/** One planned object action from an import plan. */
export interface ImportPlanItem {
  key: string;
  action: ImportAction;
}

/** A required secret NAME the document references but the local store lacks. */
export interface MissingSecret {
  name: string;
  used_by: string[];
}

/** The manual follow-up steps an import cannot perform on the user's behalf. */
export interface PostImportChecklist {
  secrets_to_create: string[];
  identity_me: string;
  modules_to_review: string[];
  default_lease_image: string | null;
}

/** The full import plan / result returned for both dry-run and apply. */
export interface ImportPlan {
  mode: ImportMode;
  dry_run: boolean;
  applied: boolean;
  playbooks: ImportPlanItem[];
  rules: ImportPlanItem[];
  /** Snippet plan items, keyed `<kind>:<name>` — a snippet's stable identity. */
  snippets: ImportPlanItem[];
  modules: ImportPlanItem[];
  settings: ImportPlanItem[];
  missing_secrets: MissingSecret[];
  post_import_checklist: PostImportChecklist;
}

/**
 * Import a config document. `dryRun` computes and returns the plan without any
 * writes; the same call with `dryRun=false` applies it. The apply is one server
 * transaction — a dangling reference rolls the whole thing back.
 */
export function importConfig(
  document: unknown,
  mode: ImportMode,
  dryRun: boolean,
): Promise<ImportPlan> {
  return apiFetch<ImportPlan>(`/config/import`, {
    method: "POST",
    body: { document, mode, dry_run: dryRun },
  });
}

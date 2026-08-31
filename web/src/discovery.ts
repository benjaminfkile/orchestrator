// Thin data-layer functions over the discovery/facet endpoints that back the
// "magic string → fetched dropdown" work. The endpoints themselves land in
// later tasks; this module is the single import site every AsyncCombobox
// `load` fn comes from, so pickers never reach into feature modules directly.
//
// Each helper returns the exact shape a picker needs (usually a bare string[]
// of candidate values); the AsyncCombobox maps those into `{value,label}`
// options at the call site.

import type { AsyncComboboxOption } from "./components/AsyncCombobox";
import { apiFetch, apiFetchRestrictable } from "./api";
import { getEventFacets, type EventRecord } from "./events";
import { getSettings, listSecrets } from "./settings";

/**
 * Fetch an ADO discovery list. The endpoint answers 200 even when the PAT lacks
 * permission (an expected outcome, not a gateway failure), signalling that case
 * via a `restricted` header. We rethrow that reason as an Error so the picker
 * renders it inline and stays freeform — without a red 5xx in the network log.
 */
async function adoList<T>(path: string): Promise<T[]> {
  const { data, restricted } = await apiFetchRestrictable<T[]>(path);
  if (restricted) throw new Error(restricted);
  return data;
}

/**
 * Stored secret NAMES for secret-ref pickers (env requirements, PAT refs).
 * Secret VALUES never cross this boundary — the store is name-only on read.
 * Re-exported from `settings.ts` so discovery stays the one place pickers
 * import their `load` fns from.
 */
export function getSecretNames(): Promise<string[]> {
  return listSecrets();
}

/**
 * Distinct known event SOURCES for the Events filter and Rule source pickers.
 * Backed by `GET /api/events/facets`; freeform values (unseen sources) are
 * still committable at the picker, so this is only a suggestion list.
 */
export async function getEventSources(): Promise<string[]> {
  return (await getEventFacets()).sources;
}

/**
 * Distinct known event TYPES for the Events filter and Rule type pickers. The
 * Rule type field additionally accepts `prefix.*` / `*` wildcard freeform
 * entries; those never appear here — this is only the concrete-value suggestion
 * list from recorded events plus module-advertised types.
 */
export async function getEventTypes(): Promise<string[]> {
  return (await getEventFacets()).types;
}

// --- Anthropic model list --------------------------------------------------

/**
 * Model options for the playbook Model picker, from `GET /api/anthropic/models`.
 * The `id` is committed (used verbatim as the playbook's model); the
 * `display_name` is shown. The endpoint DEGRADES rather than fails — it always
 * answers 200 with a (possibly empty) list plus an optional `warning` — so this
 * resolves to a bare option list even with no credential configured. Blank stays
 * a valid choice (the runner's default model) and freeform custom ids remain
 * committable at the picker.
 */
export async function getAnthropicModelOptions(): Promise<AsyncComboboxOption[]> {
  const res = await apiFetch<{
    models?: { id?: unknown; display_name?: unknown }[];
  }>(`/anthropic/models`);
  return (res.models ?? [])
    .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === "string" && m.id !== "")
    .map((m) => ({
      value: m.id,
      label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id,
    }));
}

// --- Wisper host list -------------------------------------------------------

/**
 * Host options for the playbook Host picker, from `GET /api/wisper/hosts`. The
 * catalog is fetched SERVER-SIDE (the wisper API key never reaches the browser);
 * the endpoint DEGRADES rather than fails — it always answers 200 with a
 * (possibly empty) list plus an optional `warning` — so this resolves to a bare
 * option list even with no credential configured or the catalog down.
 *
 * The `id` is committed (used verbatim as the playbook's `host`); the label shows
 * the host name plus its `os` — the detail users pick hosts by — and an
 * "(offline)" marker when the host is not currently online. Blank stays a valid
 * choice (the configured default host) and freeform custom ids remain committable
 * at the picker.
 */
export async function getWisperHostOptions(): Promise<AsyncComboboxOption[]> {
  const res = await apiFetch<{
    hosts?: {
      id?: unknown;
      name?: unknown;
      os?: unknown;
      online?: unknown;
    }[];
  }>(`/wisper/hosts`);
  return (res.hosts ?? [])
    .filter((h): h is { id: string } & Record<string, unknown> =>
      typeof h.id === "string" && h.id !== "",
    )
    .map((h) => {
      const name = typeof h.name === "string" && h.name ? h.name : h.id;
      const os = typeof h.os === "string" && h.os ? h.os : null;
      const offline = h.online === false ? " (offline)" : "";
      const label = os ? `${name} — ${os}${offline}` : `${name}${offline}`;
      return { value: h.id, label };
    });
}

// --- Granted-capability suggestions -----------------------------------------

/**
 * Capability options for the playbook "Granted capabilities" picker, from
 * `GET /api/capabilities`. Each entry is `{ id, module_id }`; the `id` is
 * committed (used verbatim as the grant's `capability_id`) and the label adds
 * the owning module for disambiguation. A fresh install with no modules simply
 * returns an empty list. The picker stays freeform, so a capability not (yet)
 * registered still commits.
 */
export async function getCapabilityOptions(): Promise<AsyncComboboxOption[]> {
  const rows = await apiFetch<{ id?: unknown; module_id?: unknown }[]>(
    `/capabilities`,
  );
  return (rows ?? [])
    .filter(
      (r): r is { id: string; module_id?: unknown } =>
        typeof r.id === "string" && r.id !== "",
    )
    .map((r) => ({
      value: r.id,
      label:
        typeof r.module_id === "string" && r.module_id
          ? `${r.id} (${r.module_id})`
          : r.id,
    }));
}

// --- Lease image suggestions ------------------------------------------------

/**
 * The playbook `image` value that resolves, at dispatch time, to whatever the
 * `default_lease_image` app setting currently holds. Offered as a first-class
 * suggestion so a playbook can track the default without hard-coding a tag.
 */
export const DEFAULT_LEASE_IMAGE_SENTINEL = "setting:default_lease_image";

/**
 * Image suggestions for the playbook Image picker. Seeded from the current
 * `default_lease_image` setting (`GET /api/settings`) plus the
 * `setting:default_lease_image` sentinel that resolves to it at dispatch time.
 * The picker stays freeform, so any registry reference still commits.
 *
 * NOTE: live wisp image discovery (enumerating images the wisper host can pull)
 * is intentionally out of scope for this task. When it lands, merge its results
 * into this list rather than adding a second picker.
 */
export async function getImageSuggestions(): Promise<AsyncComboboxOption[]> {
  const settings = await getSettings();
  const options: AsyncComboboxOption[] = [
    { value: DEFAULT_LEASE_IMAGE_SENTINEL, label: `${DEFAULT_LEASE_IMAGE_SENTINEL} (setting)` },
  ];
  const def = settings.default_lease_image;
  if (def && def !== DEFAULT_LEASE_IMAGE_SENTINEL) options.push({ value: def });
  return options;
}

// --- Azure DevOps cascading discovery -------------------------------------
//
// These back the Modules page's ADO config pickers. Each is a READ-ONLY GET
// against `/api/modules/ado/discovery/*`; the PAT is resolved server-side from
// the module's `pat_secret_ref` and never crosses this boundary. Every helper
// returns the exact shape its picker needs (a bare `string[]` for name lists,
// `{value,label}` options for identities where the display name differs from the
// committed value). A failing fetch rejects — pickers surface that inline and
// stay freeform, so the form still saves without discovery.

const ADO_BASE = "/modules/ado";

/** Encode a `?k=v&...` query string, dropping blank values. */
function query(params: Record<string, string>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** One identity option: the unique name is committed; the display name is shown. */
export interface IdentityOption {
  value: string;
  label: string;
}

/** Organizations the configured PAT can reach (`/discovery/orgs`). */
export async function getAdoOrgs(): Promise<string[]> {
  const rows = await adoList<{ accountName?: string }>(
    `${ADO_BASE}/discovery/orgs`,
  );
  return rows.map((r) => r.accountName ?? "").filter((s) => s !== "");
}

/** Projects within `org` (`/discovery/projects?org=`). */
export async function getAdoProjects(org: string): Promise<string[]> {
  const rows = await adoList<{ name?: string }>(
    `${ADO_BASE}/discovery/projects${query({ org })}`,
  );
  return rows.map((r) => r.name ?? "").filter((s) => s !== "");
}

/** Work-item type names in a project (`/discovery/work-item-types`). */
export async function getAdoWorkItemTypes(
  org: string,
  project: string,
): Promise<string[]> {
  const rows = await adoList<{ name?: string }>(
    `${ADO_BASE}/discovery/work-item-types${query({ org, project })}`,
  );
  return rows.map((r) => r.name ?? "").filter((s) => s !== "");
}

/** State names for one work-item type (`/discovery/states?...&type=`). */
export async function getAdoStates(
  org: string,
  project: string,
  type: string,
): Promise<string[]> {
  const rows = await adoList<{ name?: string }>(
    `${ADO_BASE}/discovery/states${query({ org, project, type })}`,
  );
  return rows.map((r) => r.name ?? "").filter((s) => s !== "");
}

/** Flattened area paths of a project (`/discovery/area-paths`). */
export async function getAdoAreaPaths(
  org: string,
  project: string,
): Promise<string[]> {
  return adoList<string>(
    `${ADO_BASE}/discovery/area-paths${query({ org, project })}`,
  );
}

/** Flattened iteration paths of a project (`/discovery/iterations`). */
export async function getAdoIterations(
  org: string,
  project: string,
): Promise<string[]> {
  return adoList<string>(
    `${ADO_BASE}/discovery/iterations${query({ org, project })}`,
  );
}

/** The authenticated identity resolved from the configured PAT (`/identity/me`). */
export interface AdoMeIdentity {
  uniqueName?: string;
  displayName?: string;
}

/**
 * Resolve the authenticated ADO identity from the configured connection
 * (`GET /modules/ado/identity/me`). Used to prefill Settings' `identity_me`.
 * The PAT is resolved server-side from the module's `pat_secret_ref`; a missing
 * PAT or org surfaces as a rejected fetch the caller renders inline.
 */
export function getAdoMe(): Promise<AdoMeIdentity> {
  return apiFetch<AdoMeIdentity>(`${ADO_BASE}/identity/me`);
}

/**
 * Project identities matching `q` (`/discovery/identities?...&q=`). An empty `q`
 * matches everyone; the picker then filters the returned set client-side. The
 * committed value is the unique name (email/UPN); the display name is the label.
 */
export async function getAdoIdentities(
  org: string,
  project: string,
  q = "",
): Promise<IdentityOption[]> {
  const rows = await adoList<{ displayName?: string; uniqueName?: string }>(
    `${ADO_BASE}/discovery/identities${query({ org, project, q })}`,
  );
  return rows
    .map((r) => {
      const value = r.uniqueName || r.displayName || "";
      return { value, label: r.displayName || value };
    })
    .filter((o) => o.value !== "");
}

// --- Azure DevOps work-item search + materialize ---------------------------
//
// These back the manual "run a playbook on a work item" flow. Both are READ-ONLY
// against ADO (the materialize only WRITES to local SQLite, via the event it
// records); the PAT is resolved server-side from the module's `pat_secret_ref`
// and never crosses this boundary.

/**
 * One work-item search result. These are exactly the fields the backend's
 * `/discovery/workitems` endpoint returns — the poller payload's identity/display
 * fields — so the picker shows the same naming a materialized event carries.
 */
export interface WorkItemSearchRow {
  id: number;
  title: string;
  work_item_type: string;
  state: string;
  area_path: string;
  iteration_path: string;
  assignee: string;
  url: string;
}

/**
 * Search work items by free-text `q` (title match, plus an exact-id lookup when
 * `q` is a bare id), capped server-side. Like the other ADO discovery lists this
 * degrades a PAT-permission failure to a 200 with the restricted header, which
 * {@link adoList} rethrows so the caller renders the reason inline.
 */
export function searchWorkItems(q: string): Promise<WorkItemSearchRow[]> {
  return adoList<WorkItemSearchRow>(
    `${ADO_BASE}/discovery/workitems${query({ q })}`,
  );
}

/**
 * Materialize ONE work item into a local event (`POST /workitems/:id/materialize`)
 * and resolve to the created {@link EventRecord}. No rule matching runs and no
 * dispatch is created here — the caller queues a dispatch separately with the
 * returned event's id. A non-existent id rejects with an `ApiError` (404).
 */
export function materializeWorkItem(id: number): Promise<EventRecord> {
  return apiFetch<EventRecord>(`${ADO_BASE}/workitems/${id}/materialize`, {
    method: "POST",
  });
}

// --- Azure DevOps pull-request discovery + materialize ---------------------
//
// These back the manual "run a playbook on a pull request" flow in the same
// dialog as the work-item flow. Both are READ-ONLY against ADO (the
// materialize only WRITES to local SQLite, via the event it records); the PAT
// is resolved server-side from the module's `pat_secret_ref` and never
// crosses this boundary.

/**
 * One active-PR discovery row shown in the dialog's PR list. These are exactly
 * the fields the backend's `/discovery/pullrequests` endpoint returns and are
 * the compact display shape; the full poller payload lands only when the user
 * materializes and dispatches.
 */
export interface PullRequestDiscoveryRow {
  id: number;
  title: string;
  repository: string;
  source_branch: string;
  target_branch: string;
  is_draft: boolean;
}

/**
 * List the configured project's ACTIVE pull requests for the dialog. Like the
 * other ADO discovery lists this degrades a PAT-permission failure to a 200
 * with the restricted header, which {@link adoList} rethrows so the caller
 * renders the reason inline.
 */
export function listAdoPullRequests(): Promise<PullRequestDiscoveryRow[]> {
  return adoList<PullRequestDiscoveryRow>(
    `${ADO_BASE}/discovery/pullrequests`,
  );
}

/**
 * Materialize ONE pull request into a local event
 * (`POST /pullrequests/:id/materialize`) and resolve to the created
 * {@link EventRecord}. No rule matching runs and no dispatch is created here;
 * the caller queues a dispatch separately with the returned event's id. A
 * non-existent id rejects with an `ApiError` (404).
 */
export function materializePullRequest(id: number): Promise<EventRecord> {
  return apiFetch<EventRecord>(
    `${ADO_BASE}/pullrequests/${id}/materialize`,
    { method: "POST" },
  );
}

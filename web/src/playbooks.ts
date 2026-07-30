// Typed data-access helpers for the Playbooks page. These wrap the generic
// `apiFetch` in named, strongly-typed calls so the page stays declarative and
// tests can mock this module wholesale. `/api/playbooks` exposes full CRUD;
// deleting a playbook CASCADES its run history and returns 409 when it still has
// in-flight dispatches (`GET /api/playbooks/:id/usage` previews the cascade).

import { apiFetch } from "./api";

/** Resource limits requested for a playbook's lease; every field is optional. */
export interface PlaybookResources {
  cpus?: number;
  memory_mb?: number;
  pids?: number;
}

/**
 * The lease isolation level, ordered weakest -> strongest. An infrastructure
 * knob (like `network`), never domain intent. `null`/omitted lets the wisper
 * server apply its default ("shared").
 */
export type LeaseIsolation = "shared" | "sandboxed" | "vm";

/** The valid {@link LeaseIsolation} values, weakest -> strongest. */
export const LEASE_ISOLATION_LEVELS: readonly LeaseIsolation[] = [
  "shared",
  "sandboxed",
  "vm",
];

/** The pipeline stage a step runs in — never a domain intent. */
export type PlaybookStepPhase = "pre" | "collect";

/** One ordered playbook step: a labeled shell command run in a given phase. */
export interface PlaybookStep {
  phase: PlaybookStepPhase;
  label: string;
  command_template: string;
}

/**
 * One capability a playbook is granted: the registered capability's id and an
 * optional `config` blob. When `config` is omitted the executor falls back to
 * the owning module's persisted config at dispatch time. The shape of `config`
 * is opaque to the core — its meaning is defined entirely by the capability.
 */
export interface GrantedCapability {
  capability_id: string;
  config?: Record<string, unknown>;
}

/** A playbook record as returned by `GET /api/playbooks`, id ascending. */
export interface PlaybookRecord {
  id: number;
  name: string;
  image: string;
  /**
   * The host selector this playbook leases on, or `null` for the configured
   * default host (`WISPER_HOST_ID`). In v1 mode it is resolved against the wisper
   * catalog (id OR name) at dispatch time; in dev mode used verbatim.
   */
  host: string | null;
  /**
   * The lease isolation level, or `null` for the wisper server default
   * ("shared"). In v1 mode a non-null value is checked against the selected
   * host's advertised levels at dispatch time; dev mode ignores it.
   */
  isolation: LeaseIsolation | null;
  ttl_seconds: number;
  resources: PlaybookResources;
  network: string;
  userdata_template: string;
  prompt_template: string;
  /** Id of the runner that builds the agent-step command and parses its output. */
  runner: string;
  /**
   * Opaque, runner-defined config. The core never interprets it; the editor
   * knows the shapes of the built-in runners (claude-code's `model`/
   * `allowed_tools`, script's `command_template`) and falls back to a raw JSON
   * editor for any other runner.
   */
  runner_config: Record<string, unknown>;
  env_requirements: string[];
  steps: PlaybookStep[];
  granted_capabilities: GrantedCapability[];
  output_kind: string;
  created_at: number;
  updated_at: number;
}

/**
 * Fields sent when creating a playbook. Only `name`, `image`, and `ttl_seconds`
 * are required; the rest fall back to their table defaults server-side.
 */
export interface NewPlaybook {
  name: string;
  image: string;
  /** Host selector; `null`/omitted uses the configured default host. */
  host?: string | null;
  /** Lease isolation; `null`/omitted uses the wisper server default ("shared"). */
  isolation?: LeaseIsolation | null;
  ttl_seconds: number;
  resources?: PlaybookResources;
  network?: string;
  userdata_template?: string;
  prompt_template?: string;
  runner?: string;
  runner_config?: Record<string, unknown>;
  env_requirements?: string[];
  steps?: PlaybookStep[];
  granted_capabilities?: GrantedCapability[];
  output_kind?: string;
}

/** Fields sent when updating a playbook. Any omitted field is left unchanged. */
export type PlaybookUpdate = Partial<Omit<NewPlaybook, never>>;

/** The runner every playbook defaults to when none is chosen. */
export const DEFAULT_RUNNER = "claude-code";

/**
 * The registered runner ids from `GET /api/runners`, used to populate the
 * editor's runner picker. The endpoint answers `{ runners: [...] }`; a missing
 * or malformed body degrades to a list carrying just {@link DEFAULT_RUNNER} so
 * the picker is never empty.
 */
export async function listRunners(): Promise<string[]> {
  const res = await apiFetch<{ runners?: unknown }>(`/runners`);
  const ids = Array.isArray(res.runners)
    ? res.runners.filter((r): r is string => typeof r === "string" && r !== "")
    : [];
  return ids.length > 0 ? ids : [DEFAULT_RUNNER];
}

/** List all playbooks ordered by id ascending. */
export function listPlaybooks(): Promise<PlaybookRecord[]> {
  return apiFetch<PlaybookRecord[]>(`/playbooks`);
}

/** Create a playbook; resolves to the stored record. */
export function createPlaybook(playbook: NewPlaybook): Promise<PlaybookRecord> {
  return apiFetch<PlaybookRecord>(`/playbooks`, {
    method: "POST",
    body: playbook,
  });
}

/** Apply a partial update to a playbook; resolves to the updated record. */
export function updatePlaybook(
  id: number,
  patch: PlaybookUpdate,
): Promise<PlaybookRecord> {
  return apiFetch<PlaybookRecord>(`/playbooks/${id}`, {
    method: "PATCH",
    body: patch,
  });
}

/**
 * What deleting a playbook would cascade, from `GET /api/playbooks/:id/usage`:
 * the counts of run history removed, how many dispatches are still in flight
 * (delete is refused with 409 while any are), and the enabled rules whose
 * dispatch targets reference this playbook (they stop dispatching it afterward).
 */
export interface PlaybookUsage {
  dispatches: number;
  runs: number;
  findings: number;
  in_flight: number;
  referencing_rules: { id: number; name: string }[];
}

/** Fetch the delete-cascade footprint for a playbook. */
export function getPlaybookUsage(id: number): Promise<PlaybookUsage> {
  return apiFetch<PlaybookUsage>(`/playbooks/${id}/usage`);
}

/**
 * Delete a playbook by id. Resolves once the backend returns 204. This CASCADES
 * the playbook's run history; a playbook with in-flight dispatches is refused
 * with 409.
 */
export function deletePlaybook(id: number): Promise<void> {
  return apiFetch<void>(`/playbooks/${id}`, { method: "DELETE" });
}

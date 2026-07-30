// Typed data-access helpers for the Modules page. These wrap the generic
// `apiFetch` in named calls so the page stays declarative and tests can mock
// this module wholesale. `/api/modules` lists each registered integration module
// with its producers' live status; `/api/modules/:id/config` reads and replaces
// a module's opaque config (validated + reconciled server-side on write).

import { apiFetch } from "./api";

/** A producer trigger as reported by the scheduler. */
export type Trigger =
  | { kind: "manual" }
  | { kind: "interval"; seconds: number }
  | { kind: "cron"; expr: string };

/** Live status of one producer, as surfaced by `GET /api/modules`. */
export interface ProducerStatus {
  producerId: string;
  /** The currently-armed trigger, or null if only fired manually. */
  trigger: Trigger | null;
  /** Epoch ms of the last tick, or null if it has never ticked. */
  lastTickAt: number | null;
  /** Last tick error message, or null when the last tick was clean. */
  lastError: string | null;
  /** Epoch ms the next interval/cron fire is due, or null. */
  nextFireAt: number | null;
}

/** A registered module and its producers' statuses. */
export interface ModuleStatus {
  id: string;
  producers: ProducerStatus[];
}

/**
 * The watched-query builder config for the ADO poller. Every field is optional:
 * a half-filled config degrades to a no-op poll rather than an error. Mirrors the
 * backend `WatchedWiqlConfig`.
 */
export interface WatchedQueryConfig {
  /** `me` → assigned to the current user; `people` → the listed identities;
   * `any` → no assignee constraint. */
  assignee_mode: "me" | "people" | "any";
  /** Identities OR-ed on assignee when `assignee_mode` is `people`. */
  people?: string[];
  /** Work-item states to OR-match. */
  states?: string[];
  /** Area-path roots to match UNDER. */
  area_paths?: string[];
  /** `current` limits to the current iteration; null/omitted watches all. */
  iteration?: "current" | null;
}

/** The ADO module's persisted config. Mirrors the backend `AdoModuleConfig`. */
export interface AdoModuleConfig {
  org?: string;
  project?: string;
  /** Name of the secret holding the PAT (never the value itself). */
  pat_secret_ref?: string;
  /** Master switch: only an enabled module arms its interval trigger. */
  enabled?: boolean;
  /** Poll cadence in seconds; falls back to a server default when unset. */
  interval_seconds?: number;
  /** The watched-query builder config. */
  watched?: WatchedQueryConfig;
  /** Overrides the ADO base URL (rarely needed). */
  base_url?: string;
}

/**
 * The statistical detectors a single Datadog watch may arm. All optional and
 * additive — a watch with an empty `detect` never fires. Mirrors the backend
 * `DatadogDetectConfig`; domain-neutral thresholds over an opaque grouped count.
 */
export interface DatadogDetectConfig {
  /** Fire when a group's count in the window is at least this. */
  min_count?: number;
  /** Fire when a group's count is at least this multiple of its trailing baseline. */
  spike_multiplier?: number;
  /** How many trailing windows the spike baseline averages over. */
  baseline_windows?: number;
  /** Fire when a group appears that was absent from the trailing baseline. */
  novel_groups?: boolean;
}

/**
 * One configured Datadog log watch: a query, the facet its counts are grouped
 * by, the window it counts over, and the detectors that decide when a group's
 * count is event-worthy. Mirrors the backend `DatadogWatchConfig`.
 */
export interface DatadogWatchConfig {
  /** A stable, human-chosen name for the watch. */
  name: string;
  /** The Datadog log search query the aggregation is filtered by. */
  query: string;
  /** The single facet the count is grouped by. */
  group_by: string;
  /** Window length in seconds; defaults to the module `interval_seconds`. */
  window_seconds?: number;
  /** The statistical detectors this watch arms. */
  detect?: DatadogDetectConfig;
  /** How many sample log lines to attach to an emitted event. */
  sample_limit?: number;
}

/** Additive config for the Datadog monitor-transition producer. */
export interface DatadogMonitorsConfig {
  /** Master switch for the monitor-state producer. */
  enabled?: boolean;
  /** Restrict to monitors carrying ALL of these tags; absent/empty = all. */
  monitor_tags?: string[];
}

/** The Datadog module's persisted config. Mirrors the backend `DatadogModuleConfig`. */
export interface DatadogModuleConfig {
  /** Master switch: only an enabled module arms its producers. */
  enabled?: boolean;
  /** Bare Datadog site domain (e.g. `us5.datadoghq.com`); default `datadoghq.com`. */
  site?: string;
  /** Name of the secret holding the Datadog API key. */
  api_key_secret_ref?: string;
  /** Name of the secret holding the Datadog Application key. */
  app_key_secret_ref?: string;
  /** Poll cadence in seconds; falls back to a server default when unset. */
  interval_seconds?: number;
  /** Config for the monitor-state producer. */
  monitors?: DatadogMonitorsConfig;
  /** The configured log watches. */
  watches?: DatadogWatchConfig[];
}

/** List every registered module with its producers' live statuses. */
export function listModules(): Promise<ModuleStatus[]> {
  return apiFetch<ModuleStatus[]>(`/modules`);
}

/** Read one module's stored config; `config` is null before anything is saved. */
export function getModuleConfig<T = Record<string, unknown>>(
  id: string,
): Promise<{ module_id: string; config: T | null }> {
  return apiFetch<{ module_id: string; config: T | null }>(
    `/modules/${id}/config`,
  );
}

/** Replace one module's config; resolves once the backend has reconciled it. */
export function putModuleConfig<T = Record<string, unknown>>(
  id: string,
  config: T,
): Promise<{ module_id: string; config: T }> {
  return apiFetch<{ module_id: string; config: T }>(`/modules/${id}/config`, {
    method: "PUT",
    body: config,
  });
}

/** The result of a module backfill: matched candidates and events emitted. */
export interface BackfillResult {
  /** Total items the producer's watched query matched. */
  candidates: number;
  /** Events actually emitted through intake (0 on a dry run). */
  emitted: number;
}

/**
 * Invoke a module's optional backfill hook, replaying its watched items through
 * the normal event intake. `dryRun` counts candidates without emitting; `limit`
 * caps how many are emitted. Rejects (with the server's message) when the module
 * does not support backfill or refuses (e.g. disabled/unconfigured).
 */
export function backfillModule(
  id: string,
  options: { limit?: number; dryRun: boolean },
): Promise<BackfillResult> {
  const body: { dry_run: boolean; limit?: number } = { dry_run: options.dryRun };
  if (options.limit !== undefined) body.limit = options.limit;
  return apiFetch<BackfillResult>(`/modules/${id}/backfill`, {
    method: "POST",
    body,
  });
}

/**
 * The `datadog` integration module — a READ-ONLY Datadog integration that sits
 * beside `ado` in the module registry.
 *
 * It wires the module id, its opaque config schema (with pre-persist validation),
 * a config-change hook, a cheap connectivity {@link DatadogModule.ping}, the two
 * aggregate-driven producers (statistical log-watch detectors + monitor-transition
 * emitters), and the two READ-ONLY investigation capabilities (`datadog.query_logs`,
 * `datadog.get_monitor`) that enrich a dispatch's prompt with fresh context.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) nothing here knows what the
 * watched logs or monitors *mean*. Intent lives entirely in the user's config
 * (a watch's `name`/`query`/`group_by`, the monitor tag filter) and, later, in
 * the event-type strings its producers will emit — never in a code branch. Every
 * Datadog call is a read (see {@link import("./client").DatadogClient}); all
 * output is recorded locally.
 */

import type { NewEvent } from "../../interfaces";
import { log, type Logger } from "../../log";
import { emitEvent } from "../../services/eventIntake";
import type { TriggerScheduler } from "../../services/triggerScheduler";
import type { OrchestratorModule } from "../registry";

import {
  DatadogClient,
  DATADOG_MAX_SAMPLE_LIMIT,
  type DatadogClientOptions,
} from "./client";
import {
  createLogWatchProducer,
  DATADOG_LOGS_ALERT_EVENT_TYPE,
  DATADOG_LOGWATCH_PRODUCER_ID,
  type DatadogProducerStatus,
  type LogWatchProducer,
} from "./logWatch";
import {
  createMonitorWatchProducer,
  DATADOG_MONITOR_PRODUCER_ID,
  DATADOG_MONITOR_TRANSITION_EVENT_TYPE,
  type MonitorWatchProducer,
} from "./monitorWatch";
import {
  createGetMonitorCapability,
  createQueryLogsCapability,
} from "./capability";

/** The module id and its `module_config` key. */
export const DATADOG_MODULE_ID = "datadog";

/** The `source` stamped on every event this module's producers emit. */
export const DATADOG_EVENT_SOURCE = "datadog";

/** Poll cadence used when a watch names no `interval_seconds`. */
export const DATADOG_DEFAULT_INTERVAL_SECONDS = 60;

/** Default number of trailing windows a spike baseline averages over. */
export const DATADOG_DEFAULT_BASELINE_WINDOWS = 12;

/** Default sample size a watch attaches to an emitted event. */
export const DATADOG_DEFAULT_SAMPLE_LIMIT = 5;

/**
 * The statistical detectors a single watch may arm. All optional and additive —
 * a watch with an empty `detect` never fires. Domain-neutral: these are plain
 * thresholds over an opaque grouped count, never a modelled concept.
 */
export interface DatadogDetectConfig {
  /** Fire when a group's count in the window is at least this. */
  min_count?: number;
  /** Fire when a group's count is at least this multiple of its trailing baseline. */
  spike_multiplier?: number;
  /**
   * How many trailing windows the spike baseline averages over; defaults to
   * {@link DATADOG_DEFAULT_BASELINE_WINDOWS}.
   */
  baseline_windows?: number;
  /** Fire when a group appears that was absent from the trailing baseline. */
  novel_groups?: boolean;
}

/**
 * One configured log watch: a query, the facet its counts are grouped by, the
 * window it counts over, and the detectors that decide when a group's count is
 * event-worthy.
 */
export interface DatadogWatchConfig {
  /** A stable, human-chosen name for the watch (used to key its producer/state). */
  name: string;
  /** The Datadog log search query the aggregation is filtered by. */
  query: string;
  /** The single facet the count is grouped by. */
  group_by: string;
  /** Window length in seconds; defaults to the module `interval_seconds`. */
  window_seconds?: number;
  /** The statistical detectors this watch arms. */
  detect?: DatadogDetectConfig;
  /**
   * How many sample log lines to attach to an emitted event; defaults to
   * {@link DATADOG_DEFAULT_SAMPLE_LIMIT}, capped at {@link DATADOG_MAX_SAMPLE_LIMIT}.
   */
  sample_limit?: number;
}

/** Additive config for the monitor-transition producer. */
export interface DatadogMonitorsConfig {
  /** Master switch for the monitor-state producer. */
  enabled?: boolean;
  /** Restrict to monitors carrying ALL of these tags; absent/empty = all. */
  monitor_tags?: string[];
}

/**
 * Data-only module config, persisted under `module_config` key `datadog`. Every
 * field is optional so a half-filled config never throws — it simply stays inert
 * until enabled and configured.
 */
export interface DatadogModuleConfig {
  /** Master switch: only an enabled module arms its producers. */
  enabled?: boolean;
  /** Bare Datadog site domain (e.g. `us5.datadoghq.com`); default `datadoghq.com`. */
  site?: string;
  /** Name of the secret (in the secret store) holding the Datadog API key. */
  api_key_secret_ref?: string;
  /** Name of the secret holding the Datadog Application key. */
  app_key_secret_ref?: string;
  /** Poll cadence in seconds; falls back to {@link DATADOG_DEFAULT_INTERVAL_SECONDS}. */
  interval_seconds?: number;
  /** Config for the monitor-state producer. */
  monitors?: DatadogMonitorsConfig;
  /** The configured log watches. */
  watches?: DatadogWatchConfig[];
}

/** Resolves a secret ref to its value, or `undefined` if unset. */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

/** The emit surface a producer needs; injectable so tests can capture events. */
export type EmitFn = (event: NewEvent) => Promise<unknown>;

/** Re-exported so the producer files can name the shared status shape. */
export type { DatadogProducerStatus };

/** Builds a read client from resolved connection options; injectable for tests. */
export type DatadogClientFactory = (opts: DatadogClientOptions) => DatadogClient;

/** Injected collaborators for {@link createDatadogModule}. */
export interface DatadogModuleDeps {
  /** Scheduler the module's producers re-arm whenever the config changes. Required. */
  scheduler: TriggerScheduler;
  /** Resolves the API + Application keys from their `*_secret_ref` names. Required. */
  resolveSecret: SecretResolver;
  /** Emits producer events; defaults to the real {@link emitEvent} on the app db. */
  emit?: EmitFn;
  /** Builds the Datadog read client; defaults to constructing a {@link DatadogClient}. */
  clientFactory?: DatadogClientFactory;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  clock?: () => number;
}

/** A constructed datadog module plus the handles tests and the API layer read. */
export interface DatadogModule {
  module: OrchestratorModule;
  /** The id of the statistical log-watch producer. */
  logWatchProducerId: string;
  /** The id of the monitor-transition producer. */
  monitorProducerId: string;
  /** A snapshot copy of the current log-watch producer status. */
  getLogWatchStatus(): DatadogProducerStatus;
  /** A snapshot copy of the current monitor producer status. */
  getMonitorStatus(): DatadogProducerStatus;
  /**
   * A cheap connectivity probe: build a client from the current config and issue
   * a bounded 1-result {@link DatadogClient.searchLogs} over the last minute.
   * Resolves on success; throws a clear error when the module is not configured,
   * or the typed client error (including a 429 rate-limit) on failure. Exposed on
   * the handle rather than as a router endpoint — the core modules router has no
   * generic ping seam to mirror.
   */
  ping(config?: unknown): Promise<void>;
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject any key on `obj` not in `allowed`, naming the offender. */
function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown ${where} field: ${key}`);
    }
  }
}

/** Assert an optional boolean field. */
function checkOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
}

/** Assert an optional non-empty string field. */
function checkOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
}

/** Assert a required non-empty string field. */
function checkRequiredString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

/** Assert an optional integer field within `[min, max]`. */
function checkOptionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
}

/** Assert an optional finite number field `>= min`. */
function checkOptionalNumber(value: unknown, field: string, min: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  if (value < min) {
    throw new Error(`${field} must be at least ${min}`);
  }
}

/** Assert an optional array-of-strings field. */
function checkOptionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((el) => typeof el !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
}

/** Validate one `detect` block. */
function validateDetect(value: unknown, where: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error(`${where} must be an object`);
  }
  rejectUnknownKeys(
    value,
    ["min_count", "spike_multiplier", "baseline_windows", "novel_groups"],
    where
  );
  checkOptionalNumber(value.min_count, `${where}.min_count`, 0);
  checkOptionalNumber(value.spike_multiplier, `${where}.spike_multiplier`, 0);
  checkOptionalInt(value.baseline_windows, `${where}.baseline_windows`, 1, 1000);
  checkOptionalBoolean(value.novel_groups, `${where}.novel_groups`);
}

/** Validate one `watches[]` entry. */
function validateWatch(value: unknown, where: string): void {
  if (!isPlainObject(value)) {
    throw new Error(`${where} must be an object`);
  }
  rejectUnknownKeys(
    value,
    ["name", "query", "group_by", "window_seconds", "detect", "sample_limit"],
    where
  );
  checkRequiredString(value.name, `${where}.name`);
  checkRequiredString(value.query, `${where}.query`);
  checkRequiredString(value.group_by, `${where}.group_by`);
  checkOptionalInt(value.window_seconds, `${where}.window_seconds`, 1, 86_400);
  checkOptionalInt(
    value.sample_limit,
    `${where}.sample_limit`,
    1,
    DATADOG_MAX_SAMPLE_LIMIT
  );
  validateDetect(value.detect, `${where}.detect`);
}

/** Validate the `monitors` block. */
function validateMonitors(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new Error("monitors must be an object");
  }
  rejectUnknownKeys(value, ["enabled", "monitor_tags"], "monitors");
  checkOptionalBoolean(value.enabled, "monitors.enabled");
  checkOptionalStringArray(value.monitor_tags, "monitors.monitor_tags");
}

/**
 * Shape-validate a candidate `datadog` config, throwing on the first problem.
 * Unknown keys are rejected at every level. Called from the modules router's
 * per-module validation seam BEFORE anything is persisted; the router renders a
 * throw as a 400.
 */
export function validateDatadogConfig(config: unknown): void {
  if (!isPlainObject(config)) {
    throw new Error("datadog config must be a JSON object");
  }
  rejectUnknownKeys(
    config,
    [
      "enabled",
      "site",
      "api_key_secret_ref",
      "app_key_secret_ref",
      "interval_seconds",
      "monitors",
      "watches",
    ],
    "datadog"
  );
  checkOptionalBoolean(config.enabled, "enabled");
  checkOptionalString(config.site, "site");
  checkOptionalString(config.api_key_secret_ref, "api_key_secret_ref");
  checkOptionalString(config.app_key_secret_ref, "app_key_secret_ref");
  checkOptionalInt(config.interval_seconds, "interval_seconds", 1, 86_400);
  validateMonitors(config.monitors);

  if (config.watches !== undefined) {
    if (!Array.isArray(config.watches)) {
      throw new Error("watches must be an array");
    }
    config.watches.forEach((watch, i) => validateWatch(watch, `watches[${i}]`));
  }
}

/**
 * Build the datadog module. Register the returned `module` with a
 * {@link import("../registry").ModuleRegistry}; its config is validated on every
 * write and reloaded on {@link OrchestratorModule.applyConfig}. Producers and
 * capabilities are added in later sibling tasks.
 */
export function createDatadogModule(deps: DatadogModuleDeps): DatadogModule {
  const { scheduler, resolveSecret } = deps;
  const clientFactory: DatadogClientFactory =
    deps.clientFactory ?? ((opts) => new DatadogClient(opts));
  const logger = (deps.logger ?? log).child({ component: "datadog" });

  let currentConfig: DatadogModuleConfig = {};

  // The two producers share the module's connection config (site + key refs) but
  // each keeps its own trigger, in-memory state, and status. Both build their
  // read client from the same injected clientFactory, so a test that fakes the
  // module's client fakes theirs too.
  const logWatch: LogWatchProducer = createLogWatchProducer({
    scheduler,
    resolveSecret,
    emit: deps.emit,
    clientFactory: deps.clientFactory,
    logger: deps.logger,
    clock: deps.clock,
  });
  const monitorWatch: MonitorWatchProducer = createMonitorWatchProducer({
    scheduler,
    resolveSecret,
    emit: deps.emit,
    clientFactory: deps.clientFactory,
    logger: deps.logger,
    clock: deps.clock,
  });

  /**
   * Reconcile the stored config: keep it for {@link ping} and forward it to each
   * producer so both re-derive their triggers and reset their state (the next
   * tick then reseeds silently).
   */
  function applyConfig(config: unknown): void {
    currentConfig = (config ?? {}) as DatadogModuleConfig;
    logWatch.applyConfig(currentConfig);
    monitorWatch.applyConfig(currentConfig);
  }

  /**
   * Resolve a read client from a config, throwing a clear error when the module
   * is under-configured. The keys are read from the secret store by their refs;
   * neither is logged.
   */
  async function resolveClient(
    cfg: DatadogModuleConfig
  ): Promise<DatadogClient> {
    const apiKey = await resolveSecret(cfg.api_key_secret_ref ?? "");
    if (!apiKey) {
      throw new Error(
        `Datadog API key secret unavailable for ref "${cfg.api_key_secret_ref ?? ""}"`
      );
    }
    const appKey = await resolveSecret(cfg.app_key_secret_ref ?? "");
    if (!appKey) {
      throw new Error(
        `Datadog Application key secret unavailable for ref "${cfg.app_key_secret_ref ?? ""}"`
      );
    }
    return clientFactory({ apiKey, appKey, site: cfg.site });
  }

  async function ping(config?: unknown): Promise<void> {
    const cfg = config === undefined ? currentConfig : ((config ?? {}) as DatadogModuleConfig);
    const client = await resolveClient(cfg);
    // A bounded, side-effect-free read over the last minute: proves the keys and
    // site resolve to a reachable, authorized API without fetching a real sample.
    await client.searchLogs({ query: "*", from: "now-1m", to: "now", limit: 1 });
    logger.debug("datadog ping ok");
  }

  // The two investigation capabilities share the module's connection config
  // (site + key refs) via the executor's owning-module-config fallback, and build
  // their read client from the same injected clientFactory as the producers, so a
  // test that fakes the module's client fakes theirs too.
  const queryLogsCapability = createQueryLogsCapability({
    resolveSecret,
    clientFactory: deps.clientFactory,
    now: deps.clock,
  });
  const getMonitorCapability = createGetMonitorCapability({
    resolveSecret,
    clientFactory: deps.clientFactory,
  });

  const module: OrchestratorModule = {
    id: DATADOG_MODULE_ID,
    producers: [logWatch.producer, monitorWatch.producer],
    capabilities: [queryLogsCapability, getMonitorCapability],
    // Advertise the event types these producers emit so the facets endpoint can
    // suggest them before any have been recorded (empty events table).
    eventTypes: [
      DATADOG_LOGS_ALERT_EVENT_TYPE,
      DATADOG_MONITOR_TRANSITION_EVENT_TYPE,
    ],
    validateConfig: validateDatadogConfig,
    applyConfig,
  };

  return {
    module,
    logWatchProducerId: DATADOG_LOGWATCH_PRODUCER_ID,
    monitorProducerId: DATADOG_MONITOR_PRODUCER_ID,
    getLogWatchStatus: () => logWatch.getStatus(),
    getMonitorStatus: () => monitorWatch.getStatus(),
    ping,
  };
}

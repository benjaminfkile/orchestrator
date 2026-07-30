/**
 * The Datadog investigation capabilities — bounded, READ-ONLY data operations a
 * playbook may be granted so an investigating agent gets FRESH Datadog context in
 * its prompt at dispatch time. Two independently-grantable capabilities live here:
 *
 *   - `datadog.query_logs`  — a compact page of recent matching log lines. When
 *     the triggering event is a Datadog log-alert event, its query + window +
 *     group default straight off the event payload, so a bare grant Just Works; a
 *     configured `query` template may reference the event via the same `{{...}}`
 *     engine the prompt/step templates use.
 *   - `datadog.get_monitor` — one monitor's definition + current group states,
 *     keyed by the event subject (a monitor id) or an explicitly configured id.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) nothing here knows what the logs
 * or monitors *mean*: it reads generic fields (a query, a count, a state string,
 * a threshold number) and formats them. Intent lives in the user's config, the
 * event payload, and the playbook prompt — never in a code branch. Every Datadog
 * call is a read (see {@link import("./client").DatadogClient}).
 *
 * DEGRADE, NEVER BREAK. A capability feeds context into a dispatch; a fetch
 * failure must not abort it. Every error path returns a {@link CapabilityResult}
 * whose content is a short "context unavailable" note, so a broken read simply
 * contributes an explanatory line instead of throwing.
 *
 * BOUNDS ARE HARD. `datadog.query_logs` never fetches more than
 * {@link DATADOG_QUERY_LOGS_MAX_LIMIT} lines regardless of config, and truncates
 * each message; no secret value ever appears in a rendered block (the only inputs
 * rendered are queries, timestamps, statuses, services, messages, and monitor
 * metadata — never a resolved key).
 */

import { renderTemplate, type PromptEvent } from "../../executor/prompt";
import type {
  Capability,
  CapabilityEvent,
  CapabilityInvocationContext,
  CapabilityResult,
} from "../registry";

import {
  DatadogClient,
  DATADOG_MAX_LOG_QUERY_LIMIT,
  DATADOG_MESSAGE_MAX_LENGTH,
  type DatadogClientOptions,
  type DatadogLogSample,
  type DatadogMonitorDefinition,
} from "./client";
import type { SecretResolver } from "./index";

/** The stable capability ids, as required by the task. */
export const DATADOG_QUERY_LOGS_CAPABILITY_ID = "datadog.query_logs";
export const DATADOG_GET_MONITOR_CAPABILITY_ID = "datadog.get_monitor";

/** Default and hard-max line counts for {@link createQueryLogsCapability}. */
export const DATADOG_QUERY_LOGS_DEFAULT_LIMIT = 20;
export const DATADOG_QUERY_LOGS_MAX_LIMIT = DATADOG_MAX_LOG_QUERY_LIMIT;

/**
 * Lookback used when neither the grant config nor the triggering event supplies a
 * window (15 minutes). Also the hard ceiling on a configured `window_seconds`.
 */
export const DATADOG_QUERY_LOGS_DEFAULT_WINDOW_SECONDS = 900;
export const DATADOG_QUERY_LOGS_MAX_WINDOW_SECONDS = 86_400;

/** Per-line message ceiling in the rendered block; keeps the context compact. */
export const DATADOG_QUERY_LOGS_MESSAGE_MAX = 200;

/**
 * The connection fields both capabilities need; they mirror the datadog module
 * config, so a grant with no explicit config inherits the module's persisted
 * connection settings (the executor supplies that fallback). Every field is
 * optional so a half-filled config degrades to an error note.
 */
export interface DatadogCapabilityConnConfig {
  /** Bare Datadog site domain (e.g. `us5.datadoghq.com`); defaults to `datadoghq.com`. */
  site?: string;
  /** Name of the secret holding the Datadog API key. */
  api_key_secret_ref?: string;
  /** Name of the secret holding the Datadog Application key. */
  app_key_secret_ref?: string;
}

/** Config for {@link createQueryLogsCapability}. */
export interface DatadogQueryLogsConfig extends DatadogCapabilityConnConfig {
  /**
   * The Datadog log search query. May contain `{{...}}` tokens resolved against
   * the triggering event. When omitted, the query defaults from a log-alert
   * event's payload (its query scoped to the tripped group).
   */
  query?: string;
  /** Window length in seconds; defaults to the event's own window, else the 15m lookback. */
  window_seconds?: number;
  /** Line cap; defaults to {@link DATADOG_QUERY_LOGS_DEFAULT_LIMIT}, hard-max {@link DATADOG_QUERY_LOGS_MAX_LIMIT}. */
  limit?: number;
}

/** Config for {@link createGetMonitorCapability}. */
export interface DatadogGetMonitorConfig extends DatadogCapabilityConnConfig {
  /** Explicit monitor id; overrides the event subject when set. */
  monitor_id?: number | string;
}

/** The read surface {@link createQueryLogsCapability} needs; {@link DatadogClient} satisfies it. */
export interface DatadogQueryLogsReadClient {
  queryLogs(params: {
    query: string;
    from: number | string;
    to: number | string;
    limit?: number;
  }): Promise<DatadogLogSample[]>;
}

/** The read surface {@link createGetMonitorCapability} needs; {@link DatadogClient} satisfies it. */
export interface DatadogGetMonitorReadClient {
  getMonitor(id: number): Promise<DatadogMonitorDefinition>;
}

/** Builds a read client from resolved connection options; injectable for tests. */
export type DatadogQueryLogsClientFactory = (
  opts: DatadogClientOptions
) => DatadogQueryLogsReadClient;
export type DatadogGetMonitorClientFactory = (
  opts: DatadogClientOptions
) => DatadogGetMonitorReadClient;

/** Injected collaborators for {@link createQueryLogsCapability}. */
export interface QueryLogsCapabilityDeps {
  /** Resolves the API + Application keys from their `*_secret_ref` names. Required. */
  resolveSecret: SecretResolver;
  /** Builds the read client; defaults to constructing a {@link DatadogClient}. */
  clientFactory?: DatadogQueryLogsClientFactory;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
}

/** Injected collaborators for {@link createGetMonitorCapability}. */
export interface GetMonitorCapabilityDeps {
  /** Resolves the API + Application keys from their `*_secret_ref` names. Required. */
  resolveSecret: SecretResolver;
  /** Builds the read client; defaults to constructing a {@link DatadogClient}. */
  clientFactory?: DatadogGetMonitorClientFactory;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the API + Application keys from a config and build a read client,
 * throwing a clear error when a key is unavailable. The keys are read from the
 * secret store by their refs; neither is logged or echoed into the error.
 */
async function connect<T>(
  cfg: DatadogCapabilityConnConfig,
  resolveSecret: SecretResolver,
  clientFactory: (opts: DatadogClientOptions) => T
): Promise<T> {
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

/** Clamp a requested count into `[1, max]`, defaulting when unset/invalid. */
function clampCount(raw: unknown, def: number, max: number): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : def;
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

/** Render a value to a short string, truncating with an ellipsis past `max`. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/* -------------------------------------------------------------------------- *
 * datadog.query_logs
 * -------------------------------------------------------------------------- */

/** Defaults pulled off a log-alert event payload for {@link createQueryLogsCapability}. */
interface LogEventDefaults {
  /** The event's query, scoped to its tripped group when both are present. */
  query?: string;
  /** The event's own window bounds (epoch ms), when present. */
  windowStart?: number;
  windowEnd?: number;
}

/**
 * Read query/window defaults off the triggering event's payload. A
 * `datadog.logs.alert` payload carries `{query, group_by, group, window_start,
 * window_end}` (see the log-watch producer); when present, the query is scoped to
 * the tripped group so a bare grant reproduces exactly the logs that fired. Reads
 * generic payload fields only — never branches on what they mean.
 */
function logEventDefaults(event?: CapabilityEvent): LogEventDefaults {
  const payload = event?.payload;
  if (!isRecord(payload)) return {};

  const baseQuery =
    typeof payload.query === "string" && payload.query.length > 0
      ? payload.query
      : undefined;
  const groupBy =
    typeof payload.group_by === "string" ? payload.group_by : undefined;
  const group = typeof payload.group === "string" ? payload.group : undefined;
  let query = baseQuery;
  if (baseQuery && groupBy && group) {
    query = `${baseQuery} ${groupBy}:${group}`;
  }

  const windowStart =
    typeof payload.window_start === "number" ? payload.window_start : undefined;
  const windowEnd =
    typeof payload.window_end === "number" ? payload.window_end : undefined;

  return { query, windowStart, windowEnd };
}

/** The resolved query window: absolute epoch-ms bounds plus its length in seconds. */
interface ResolvedWindow {
  from: number;
  to: number;
  windowSeconds: number;
}

/**
 * Resolve the log query window. A configured `window_seconds` (a "last N seconds"
 * lookback, capped) wins; else the event's own window is used verbatim so the
 * fetched lines match the alert; else the default 15-minute lookback.
 */
function resolveWindow(
  cfg: DatadogQueryLogsConfig,
  defaults: LogEventDefaults,
  now: () => number
): ResolvedWindow {
  if (
    typeof cfg.window_seconds === "number" &&
    Number.isFinite(cfg.window_seconds) &&
    cfg.window_seconds > 0
  ) {
    const windowSeconds = Math.min(
      Math.floor(cfg.window_seconds),
      DATADOG_QUERY_LOGS_MAX_WINDOW_SECONDS
    );
    const to = now();
    return { from: to - windowSeconds * 1000, to, windowSeconds };
  }
  if (
    defaults.windowStart !== undefined &&
    defaults.windowEnd !== undefined &&
    defaults.windowEnd > defaults.windowStart
  ) {
    return {
      from: defaults.windowStart,
      to: defaults.windowEnd,
      windowSeconds: Math.round(
        (defaults.windowEnd - defaults.windowStart) / 1000
      ),
    };
  }
  const to = now();
  return {
    from: to - DATADOG_QUERY_LOGS_DEFAULT_WINDOW_SECONDS * 1000,
    to,
    windowSeconds: DATADOG_QUERY_LOGS_DEFAULT_WINDOW_SECONDS,
  };
}

/** Render an epoch-ms instant as an ISO-8601 string, or "(unknown)" when invalid. */
function isoOrUnknown(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "(unknown)";
}

/** Render the compact logs block: a header plus one line per fetched log. */
function renderLogsBlock(
  query: string,
  window: ResolvedWindow,
  logs: DatadogLogSample[]
): string {
  const lines = [
    `Query: ${query}`,
    `Window: last ${window.windowSeconds}s (${isoOrUnknown(
      window.from
    )} → ${isoOrUnknown(window.to)})`,
    `Fetched: ${logs.length} log line(s) (newest first)`,
    "",
  ];
  if (logs.length === 0) {
    lines.push("(no matching logs)");
    return lines.join("\n");
  }
  for (const logLine of logs) {
    const ts = logLine.timestamp || "(no ts)";
    const status = logLine.status || "-";
    const service = logLine.service || "-";
    const message = truncate(
      logLine.message || "(empty)",
      DATADOG_QUERY_LOGS_MESSAGE_MAX
    );
    lines.push(`[${ts}] ${status} ${service}: ${message}`);
  }
  return lines.join("\n");
}

/**
 * Build the `datadog.query_logs` capability. Register the returned object on the
 * datadog module's `capabilities` array; the registry then exposes it by id in
 * `/api/capabilities` and the playbook editor picker.
 *
 * `fetch(config, subjectRef, context)` resolves the query (a configured `{{...}}`
 * template rendered against the event, else the event's own scoped query), the
 * window, and a bounded line count, then fetches and renders a compact block. ANY
 * failure degrades to a labelled note — it never throws.
 */
export function createQueryLogsCapability(
  deps: QueryLogsCapabilityDeps
): Capability {
  const { resolveSecret } = deps;
  const clientFactory: DatadogQueryLogsClientFactory =
    deps.clientFactory ?? ((opts) => new DatadogClient(opts));
  const now = deps.now ?? Date.now;

  async function fetch(
    config: unknown,
    _subjectRef: string,
    context?: CapabilityInvocationContext
  ): Promise<CapabilityResult> {
    const label = "Datadog logs";
    try {
      const cfg = (config ?? {}) as DatadogQueryLogsConfig;
      const event = context?.event;
      const defaults = logEventDefaults(event);

      let query: string;
      if (typeof cfg.query === "string" && cfg.query.length > 0) {
        // A configured template is rendered against the event with the shared
        // engine (event/payload tokens); no `env` is exposed, so no secret leaks.
        query = event
          ? renderTemplate(cfg.query, { id: 0, ...event } as PromptEvent)
          : cfg.query;
      } else if (defaults.query) {
        query = defaults.query;
      } else {
        throw new Error(
          "no query configured and the triggering event carries none"
        );
      }
      if (query.trim().length === 0) {
        throw new Error("resolved query is empty");
      }

      const limit = clampCount(
        cfg.limit,
        DATADOG_QUERY_LOGS_DEFAULT_LIMIT,
        DATADOG_QUERY_LOGS_MAX_LIMIT
      );
      const window = resolveWindow(cfg, defaults, now);

      const client = await connect(cfg, resolveSecret, clientFactory);
      const logs = await client.queryLogs({
        query,
        from: window.from,
        to: window.to,
        limit,
      });
      return { label, content: renderLogsBlock(query, window, logs) };
    } catch (err) {
      return {
        label,
        content: `(capability ${DATADOG_QUERY_LOGS_CAPABILITY_ID} unavailable: ${errorMessage(
          err
        )})`,
      };
    }
  }

  return { id: DATADOG_QUERY_LOGS_CAPABILITY_ID, fetch };
}

/* -------------------------------------------------------------------------- *
 * datadog.get_monitor
 * -------------------------------------------------------------------------- */

/**
 * Resolve the monitor id to fetch: an explicit `config.monitor_id` wins, else the
 * event subject (a `datadog.monitor.transition` subject_ref is the monitor id),
 * else a `monitor_id` on the event payload. Returns `undefined` when none yields a
 * positive integer.
 */
function resolveMonitorId(
  cfg: DatadogGetMonitorConfig,
  subjectRef: string,
  event?: CapabilityEvent
): number | undefined {
  if (cfg.monitor_id !== undefined) {
    const n = Number(cfg.monitor_id);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const fromSubject = Number(subjectRef);
  if (Number.isInteger(fromSubject) && fromSubject > 0) return fromSubject;
  const payload = event?.payload;
  if (
    isRecord(payload) &&
    typeof payload.monitor_id === "number" &&
    Number.isInteger(payload.monitor_id) &&
    payload.monitor_id > 0
  ) {
    return payload.monitor_id;
  }
  return undefined;
}

/** Render a `{key: value}` map into `- key: value` lines, or "(none)" when empty. */
function renderKeyValues(map: Record<string, unknown>): string[] {
  const keys = Object.keys(map);
  if (keys.length === 0) return ["(none)"];
  return keys.map((key) => `- ${key}: ${String(map[key])}`);
}

/** Render one monitor's definition + current states into a plaintext block. */
function renderMonitorBlock(monitor: DatadogMonitorDefinition): string {
  const lines: string[] = [
    `Name: ${monitor.name || "(unnamed)"}`,
    `Type: ${monitor.type || "(unknown)"}`,
    `Query: ${monitor.query || "(none)"}`,
    `Overall state: ${monitor.overall_state || "(unknown)"}`,
    `Tags: ${monitor.tags.length > 0 ? monitor.tags.join(", ") : "(none)"}`,
    `URL: ${monitor.url || "(none)"}`,
    "",
    "Thresholds:",
    ...renderKeyValues(monitor.thresholds),
    "",
    "Options:",
    ...renderKeyValues(monitor.options),
    "",
  ];
  if (monitor.groups.length === 0) {
    lines.push(
      `Group states: (ungrouped; overall ${monitor.overall_state || "(unknown)"})`
    );
  } else {
    lines.push(`Group states (${monitor.groups.length}):`);
    for (const g of monitor.groups) {
      lines.push(`- ${g.group || "(unnamed)"}: ${g.state || "(unknown)"}`);
    }
  }
  return lines.join("\n");
}

/**
 * Build the `datadog.get_monitor` capability. Register the returned object on the
 * datadog module's `capabilities` array; the registry then exposes it by id.
 *
 * `fetch(config, subjectRef, context)` resolves the monitor id (config override,
 * else the event subject/payload), fetches the monitor definition + current group
 * states, and renders a plaintext block. ANY failure degrades to a labelled note.
 */
export function createGetMonitorCapability(
  deps: GetMonitorCapabilityDeps
): Capability {
  const { resolveSecret } = deps;
  const clientFactory: DatadogGetMonitorClientFactory =
    deps.clientFactory ?? ((opts) => new DatadogClient(opts));

  async function fetch(
    config: unknown,
    subjectRef: string,
    context?: CapabilityInvocationContext
  ): Promise<CapabilityResult> {
    const cfg = (config ?? {}) as DatadogGetMonitorConfig;
    const id = resolveMonitorId(cfg, subjectRef, context?.event);
    const label = id ? `Datadog monitor ${id}` : "Datadog monitor";
    try {
      if (id === undefined) {
        throw new Error(
          "no monitor id configured and the triggering event has no monitor subject"
        );
      }
      const client = await connect(cfg, resolveSecret, clientFactory);
      const monitor = await client.getMonitor(id);
      return { label, content: renderMonitorBlock(monitor) };
    } catch (err) {
      return {
        label,
        content: `(capability ${DATADOG_GET_MONITOR_CAPABILITY_ID} unavailable: ${errorMessage(
          err
        )})`,
      };
    }
  }

  return { id: DATADOG_GET_MONITOR_CAPABILITY_ID, fetch };
}

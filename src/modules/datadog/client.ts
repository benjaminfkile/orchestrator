/**
 * Datadog REST client — READ-ONLY BY CONSTRUCTION.
 *
 * This client offers only read operations against Datadog's public API:
 *
 *   - {@link DatadogClient.aggregateLogs}     — count logs over a window, filtered
 *     by a query and grouped by ONE facet (`POST /api/v2/logs/analytics/aggregate`).
 *   - {@link DatadogClient.searchLogs}         — a bounded newest-first sample of
 *     matching log events (`POST /api/v2/logs/events/search`).
 *   - {@link DatadogClient.queryLogs}          — the same read as `searchLogs`, at
 *     the higher, capability-oriented page cap (on-demand investigation context).
 *   - {@link DatadogClient.listMonitorStates}  — monitor overall/group states,
 *     optionally filtered by monitor tags (`GET /api/v1/monitor`).
 *   - {@link DatadogClient.getMonitor}         — ONE monitor's definition + current
 *     states by id (`GET /api/v1/monitor/{id}`).
 *
 * There is NO method here that creates, mutates, or deletes anything in Datadog.
 * The two POSTs it issues are read queries (aggregate / search) that submit a
 * filter and receive matching data back. Per the ARCHITECTURE PRINCIPLE and the
 * READ-ONLY convention (see CLAUDE.md), external-service integrations are
 * read-only by construction; all output is consumed locally.
 *
 * SECURITY: authentication is a Datadog API key + Application key, sent as the
 * `DD-API-KEY` and `DD-APPLICATION-KEY` headers. Both keys are supplied by the
 * caller from module config / the secret store (by their `*_secret_ref` names) —
 * this module NEVER reads `process.env` directly. The keys travel only in those
 * two headers, never in a URL, a body, or a thrown error, so they cannot leak
 * through a log line or a rejection.
 */

/** The bare site domain used when config names none. */
export const DATADOG_DEFAULT_SITE = "datadoghq.com";

/** Default per-request timeout; a slow Datadog response aborts to a typed error. */
export const DATADOG_DEFAULT_TIMEOUT_MS = 15_000;

/** The hard cap on a {@link DatadogClient.searchLogs} sample; bounded on purpose. */
export const DATADOG_MAX_SAMPLE_LIMIT = 25;

/**
 * The hard cap on a {@link DatadogClient.queryLogs} result. Larger than the
 * post-trip {@link DATADOG_MAX_SAMPLE_LIMIT} because an investigation capability
 * fetches a bounded page of context on demand (still bounded on purpose).
 */
export const DATADOG_MAX_LOG_QUERY_LIMIT = 50;

/** Log messages are truncated to this many characters in a sample. */
export const DATADOG_MESSAGE_MAX_LENGTH = 500;

/** Default `group_by` cap for {@link DatadogClient.aggregateLogs}. */
export const DATADOG_DEFAULT_GROUP_LIMIT = 100;

/**
 * Strip any protocol/trailing slash from a configured site and fall back to the
 * default. The stored value is a BARE domain (e.g. `us5.datadoghq.com`,
 * `datadoghq.eu`); we tolerate an accidental scheme for robustness.
 */
function normalizeSite(site?: string): string {
  const raw = (site ?? "").trim();
  if (!raw) return DATADOG_DEFAULT_SITE;
  return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Resolve the REST API base URL from a bare site domain: `https://api.<site>`.
 * `datadoghq.com` (the default) → `https://api.datadoghq.com`;
 * `datadoghq.eu` → `https://api.datadoghq.eu`; `us5.datadoghq.com` →
 * `https://api.us5.datadoghq.com`.
 */
export function resolveDatadogApiBaseUrl(site?: string): string {
  return `https://api.${normalizeSite(site)}`;
}

/**
 * Resolve the WEB APP base URL for a bare site domain, used only to synthesize a
 * monitor's browser `url` (the API does not return one). The primary US1/EU/gov
 * sites carry no region subdomain and serve the app from `app.<site>`; the
 * regionalized sites (us3/us5/ap1) already encode the region in the domain and
 * serve the app from the site host itself.
 */
export function resolveDatadogAppBaseUrl(site?: string): string {
  const s = normalizeSite(site);
  const appHost = /^(datadoghq\.com|datadoghq\.eu|ddog-gov\.com)$/i.test(s)
    ? `app.${s}`
    : s;
  return `https://${appHost}`;
}

/** Fields carried by a {@link DatadogApiError}. */
export interface DatadogApiErrorFields {
  /** HTTP status of the failing response (0 for a client-side timeout). */
  httpStatus: number;
  /** Human-readable message from Datadog's error envelope, or a status default. */
  message: string;
  /** The `errors` strings from Datadog's envelope, when present. */
  errors: string[];
}

/**
 * A typed error raised for any non-2xx Datadog response (and for a request
 * timeout, with `httpStatus === 0`). The message comes from Datadog's
 * `{ errors: [...] }` envelope when present. The request body is never included,
 * so neither key can leak through a rejection.
 *
 * A `429` is a NORMAL "skip this tick" outcome, not a crash: callers detect it
 * via {@link DatadogApiError.rateLimited} and back off rather than failing hard.
 */
export class DatadogApiError extends Error implements DatadogApiErrorFields {
  readonly httpStatus: number;
  readonly errors: string[];

  constructor(fields: DatadogApiErrorFields) {
    super(fields.message);
    this.name = "DatadogApiError";
    this.httpStatus = fields.httpStatus;
    this.errors = fields.errors;
  }

  /** True for a rate-limit (`429`): a normal skip-this-tick outcome. */
  get rateLimited(): boolean {
    return this.httpStatus === 429;
  }
}

/** The `fetch` surface this client depends on; injectable for tests. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Construction options for {@link DatadogClient}. */
export interface DatadogClientOptions {
  /**
   * Datadog API key, supplied by the caller from the secret store. NEVER read
   * from `process.env` here and never logged or echoed into an error.
   */
  apiKey: string;
  /**
   * Datadog Application key, supplied by the caller from the secret store. Same
   * hygiene as {@link DatadogClientOptions.apiKey}.
   */
  appKey: string;
  /** Bare site domain (e.g. `us5.datadoghq.com`); defaults to `datadoghq.com`. */
  site?: string;
  /**
   * Base URL of the Datadog REST host. Defaults to the site-derived
   * `https://api.<site>`; overridable so tests can target a mock server.
   */
  baseUrl?: string;
  /** Per-request timeout in ms; defaults to {@link DATADOG_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Per-call options common to every read operation. */
export interface DatadogRequestOptions {
  /** Optional caller {@link AbortSignal}; aborting rejects the returned promise. */
  signal?: AbortSignal;
}

/** Parameters for {@link DatadogClient.aggregateLogs}. */
export interface DatadogAggregateLogsParams {
  /** Datadog log search query the aggregation is filtered by. */
  query: string;
  /** Window start — an epoch-ms number or a relative expression (`now-15m`). */
  from: string | number;
  /** Window end — an epoch-ms number or a relative expression (`now`). */
  to: string | number;
  /** The single facet the count is grouped by. */
  groupBy: string;
  /** Max distinct groups to return; defaults to {@link DATADOG_DEFAULT_GROUP_LIMIT}. */
  limit?: number;
}

/** One grouped count returned by {@link DatadogClient.aggregateLogs}. */
export interface DatadogLogGroupCount {
  /** The facet value this bucket counts; "" when the API omits it. */
  group: string;
  /** The count of matching logs in this bucket. */
  count: number;
}

/** Parameters for {@link DatadogClient.searchLogs}. */
export interface DatadogSearchLogsParams {
  /** Datadog log search query. */
  query: string;
  /** Window start — an epoch-ms number or a relative expression (`now-15m`). */
  from: string | number;
  /** Window end — an epoch-ms number or a relative expression (`now`). */
  to: string | number;
  /**
   * Max events to fetch; clamped into `[1, {@link DATADOG_MAX_SAMPLE_LIMIT}]`.
   * Defaults to {@link DATADOG_MAX_SAMPLE_LIMIT}.
   */
  limit?: number;
}

/** One log event in a {@link DatadogClient.searchLogs} sample. */
export interface DatadogLogSample {
  /** The event timestamp, as Datadog reports it (ISO-8601); "" when absent. */
  timestamp: string;
  /** The event status/level (e.g. `error`, `info`); "" when absent. */
  status: string;
  /** The originating service; "" when absent. */
  service: string;
  /** The log message, TRUNCATED to {@link DATADOG_MESSAGE_MAX_LENGTH} chars. */
  message: string;
}

/** Parameters for {@link DatadogClient.listMonitorStates}. */
export interface DatadogListMonitorStatesParams {
  /**
   * Restrict to monitors matching ALL of these monitor tags. Absent/empty lists
   * every monitor the keys can read.
   */
  monitorTags?: string[];
  /** Which group states to include; defaults to `all`. */
  groupStates?: string;
}

/** One monitor's group-level state. */
export interface DatadogMonitorGroupState {
  /** The group key (e.g. `host:web-01`). */
  group: string;
  /** The group's state (e.g. `OK`, `Alert`, `No Data`); "" when absent. */
  state: string;
}

/** A monitor's overall + per-group state, as mapped from `GET /api/v1/monitor`. */
export interface DatadogMonitorState {
  id: number;
  name: string;
  query: string;
  /** The monitor's overall state (e.g. `OK`, `Alert`); "" when absent. */
  overall_state: string;
  /** Per-group states; empty when the monitor is not grouped or has no groups. */
  groups: DatadogMonitorGroupState[];
  /** The monitor's browser URL, synthesized from the site (see the class doc). */
  url: string;
}

/**
 * A single monitor's full definition + current states, as mapped from
 * `GET /api/v1/monitor/{id}`. Extends {@link DatadogMonitorState} (id, name,
 * query, overall_state, groups, url) with the definition fields an investigation
 * capability renders: its type, tags, alert thresholds, and a bounded summary of
 * notable scalar options. No secret ever appears in any of these fields.
 */
export interface DatadogMonitorDefinition extends DatadogMonitorState {
  /** The monitor type (e.g. `metric alert`, `log alert`); "" when absent. */
  type: string;
  /** The monitor's tags, in API order. */
  tags: string[];
  /** Alert/recovery thresholds from `options.thresholds`; only present keys. */
  thresholds: Record<string, number>;
  /** A bounded map of notable scalar options (see {@link MONITOR_OPTION_KEYS}). */
  options: Record<string, string | number | boolean>;
}

/**
 * The scalar `options.*` keys {@link DatadogClient.getMonitor} surfaces, in a
 * stable render order. These are Datadog API field names (wire keys, i.e. data),
 * not domain concepts — no code path branches on what any of them *means*.
 */
const MONITOR_OPTION_KEYS = [
  "notify_no_data",
  "no_data_timeframe",
  "evaluation_delay",
  "renotify_interval",
  "new_group_delay",
  "timeout_h",
  "require_full_window",
] as const;

/** The numeric threshold keys mapped from `options.thresholds`, in render order. */
const MONITOR_THRESHOLD_KEYS = [
  "critical",
  "critical_recovery",
  "warning",
  "warning_recovery",
  "ok",
  "unknown",
] as const;

/** Coerce any value to a string, mapping non-strings to "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Clamp a requested limit into `[1, cap]`, defaulting to `cap` when non-finite. */
function clampLimit(limit: number, cap: number): number {
  if (!Number.isFinite(limit)) return cap;
  return Math.max(1, Math.min(cap, Math.floor(limit)));
}

/** Truncate a message to `max` chars, appending an ellipsis when it was cut. */
function truncateMessage(message: string, max: number): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max)}…`;
}

/** Parse a non-2xx Datadog response body into a typed {@link DatadogApiError}. */
function toDatadogError(status: number, body: string): DatadogApiError {
  let errors: string[] = [];
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    if (Array.isArray(parsed.errors)) {
      errors = parsed.errors.filter((e): e is string => typeof e === "string");
    }
  } catch {
    // Non-JSON error body (e.g. an HTML gateway page): fall through to a
    // status-derived default. The raw body is intentionally not surfaced.
  }
  const message =
    errors.length > 0
      ? errors.join("; ")
      : `Datadog request failed with HTTP ${status}`;
  return new DatadogApiError({ httpStatus: status, message, errors });
}

/**
 * Issue one JSON request against Datadog and parse its body. Resolves the parsed
 * JSON on a 2xx; throws {@link DatadogApiError} on any non-2xx or on a timeout.
 * The keys are carried only in the `DD-API-KEY` / `DD-APPLICATION-KEY` headers
 * and never appear in a thrown error. A per-request timeout is enforced with an
 * internal {@link AbortController}, composed with any caller-provided signal.
 */
export async function requestJson<T>(
  fetchImpl: FetchLike,
  apiKey: string,
  appKey: string,
  url: string,
  method: "GET" | "POST",
  jsonBody: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  const headers: Record<string, string> = {
    "DD-API-KEY": apiKey,
    "DD-APPLICATION-KEY": appKey,
    accept: "application/json",
  };
  let body: string | undefined;
  if (jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(jsonBody);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort);
  }

  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await fetchImpl(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new DatadogApiError({
        httpStatus: 0,
        message: `Datadog request timed out after ${timeoutMs}ms`,
        errors: [],
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }

  const text = await res.text();
  if (!res.ok) {
    throw toDatadogError(res.status, text);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * READ-ONLY Datadog REST client. Construct one per configured
 * apiKey/appKey/site triple; it is stateless beyond those, its base URL, and its
 * timeout.
 */
export class DatadogClient {
  private readonly apiKey: string;
  private readonly appKey: string;
  private readonly baseUrl: string;
  private readonly appBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: DatadogClientOptions) {
    this.apiKey = options.apiKey;
    this.appKey = options.appKey;
    this.baseUrl = (
      options.baseUrl ?? resolveDatadogApiBaseUrl(options.site)
    ).replace(/\/+$/, "");
    this.appBaseUrl = resolveDatadogAppBaseUrl(options.site);
    this.timeoutMs = options.timeoutMs ?? DATADOG_DEFAULT_TIMEOUT_MS;
    // The global fetch is used unless a test injects its own.
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * Issue one JSON request and parse its body. Delegates to the shared
   * {@link requestJson} helper: resolves the parsed JSON on a 2xx, throws
   * {@link DatadogApiError} on any non-2xx or timeout, and keeps both keys out of
   * the request URL, body, and any thrown error.
   */
  private async requestJson<T>(
    url: string,
    method: "GET" | "POST",
    jsonBody: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    return requestJson<T>(
      this.fetchImpl,
      this.apiKey,
      this.appKey,
      url,
      method,
      jsonBody,
      this.timeoutMs,
      signal
    );
  }

  /**
   * Count logs matching `query` over `[from, to]`, grouped by ONE facet.
   * `POST {base}/api/v2/logs/analytics/aggregate` with a single `count` compute
   * and one `group_by`. Returns one `{group, count}` per bucket in the API's own
   * order; an absent/empty result yields `[]`.
   *
   * This is a read query — it submits a filter and receives counts back.
   */
  async aggregateLogs(
    params: DatadogAggregateLogsParams,
    opts: DatadogRequestOptions = {}
  ): Promise<DatadogLogGroupCount[]> {
    const url = `${this.baseUrl}/api/v2/logs/analytics/aggregate`;
    const requestBody = {
      data: {
        type: "aggregate_request",
        attributes: {
          compute: [{ aggregation: "count", type: "total" }],
          filter: {
            query: params.query,
            from: String(params.from),
            to: String(params.to),
          },
          group_by: [
            {
              facet: params.groupBy,
              limit: params.limit ?? DATADOG_DEFAULT_GROUP_LIMIT,
            },
          ],
        },
      },
    };
    const result = await this.requestJson<{ data?: { buckets?: unknown[] } }>(
      url,
      "POST",
      requestBody,
      opts.signal
    );
    const buckets = Array.isArray(result.data?.buckets)
      ? (result.data!.buckets as unknown[])
      : [];
    return buckets.map((b) => normalizeAggregateBucket(b, params.groupBy));
  }

  /**
   * Fetch a bounded, newest-first sample of logs matching `query` over
   * `[from, to]`. `POST {base}/api/v2/logs/events/search` with `sort: "-timestamp"`
   * and `page.limit` clamped to {@link DATADOG_MAX_SAMPLE_LIMIT}. Each event maps
   * to `{timestamp, status, service, message}` with the message truncated to
   * {@link DATADOG_MESSAGE_MAX_LENGTH} chars. An absent/empty result yields `[]`.
   */
  async searchLogs(
    params: DatadogSearchLogsParams,
    opts: DatadogRequestOptions = {}
  ): Promise<DatadogLogSample[]> {
    return this.searchLogEvents(params, DATADOG_MAX_SAMPLE_LIMIT, opts);
  }

  /**
   * Fetch a bounded, newest-first page of logs matching `query` over `[from, to]`
   * for on-demand investigation, `page.limit` clamped to
   * {@link DATADOG_MAX_LOG_QUERY_LIMIT} (the higher, capability-oriented cap).
   * Otherwise identical to {@link DatadogClient.searchLogs}: same read endpoint,
   * same `{timestamp, status, service, message}` mapping with a truncated message.
   */
  async queryLogs(
    params: DatadogSearchLogsParams,
    opts: DatadogRequestOptions = {}
  ): Promise<DatadogLogSample[]> {
    return this.searchLogEvents(params, DATADOG_MAX_LOG_QUERY_LIMIT, opts);
  }

  /**
   * The shared read path behind {@link DatadogClient.searchLogs} and
   * {@link DatadogClient.queryLogs}: `POST {base}/api/v2/logs/events/search` with
   * `sort: "-timestamp"` and `page.limit` clamped to `cap`. An absent/empty result
   * yields `[]`.
   */
  private async searchLogEvents(
    params: DatadogSearchLogsParams,
    cap: number,
    opts: DatadogRequestOptions
  ): Promise<DatadogLogSample[]> {
    const url = `${this.baseUrl}/api/v2/logs/events/search`;
    const limit = clampLimit(params.limit ?? cap, cap);
    const requestBody = {
      filter: {
        query: params.query,
        from: String(params.from),
        to: String(params.to),
      },
      sort: "-timestamp",
      page: { limit },
    };
    const result = await this.requestJson<{ data?: unknown[] }>(
      url,
      "POST",
      requestBody,
      opts.signal
    );
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map(normalizeLogSample);
  }

  /**
   * List monitor states, optionally filtered to monitors carrying ALL of
   * `monitorTags`. `GET {base}/api/v1/monitor?group_states=all[&monitor_tags=...]`.
   * Each monitor maps to `{id, name, query, overall_state, groups, url}` where
   * `groups` is the per-group state map flattened to `[{group, state}]` and `url`
   * is synthesized from the site. An absent/empty result yields `[]`.
   *
   * This is a read — it never creates, edits, mutes, or deletes a monitor.
   */
  async listMonitorStates(
    params: DatadogListMonitorStatesParams = {},
    opts: DatadogRequestOptions = {}
  ): Promise<DatadogMonitorState[]> {
    const search = new URLSearchParams();
    search.set("group_states", params.groupStates ?? "all");
    if (params.monitorTags && params.monitorTags.length > 0) {
      search.set("monitor_tags", params.monitorTags.join(","));
    }
    const url = `${this.baseUrl}/api/v1/monitor?${search.toString()}`;
    const result = await this.requestJson<unknown[]>(
      url,
      "GET",
      undefined,
      opts.signal
    );
    const monitors = Array.isArray(result) ? result : [];
    return monitors.map((m) => normalizeMonitor(m, this.appBaseUrl));
  }

  /**
   * Read ONE monitor's full definition + current group states by id.
   * `GET {base}/api/v1/monitor/{id}?group_states=all`. Maps to a
   * {@link DatadogMonitorDefinition} — the state fields plus type, tags, alert
   * thresholds, and a bounded summary of notable scalar options. A non-2xx (e.g.
   * a `404` for an unknown id) throws {@link DatadogApiError}.
   *
   * This is a read — it never creates, edits, mutes, or deletes a monitor.
   */
  async getMonitor(
    id: number,
    opts: DatadogRequestOptions = {}
  ): Promise<DatadogMonitorDefinition> {
    const url = `${this.baseUrl}/api/v1/monitor/${encodeURIComponent(
      String(id)
    )}?group_states=all`;
    const result = await this.requestJson<unknown>(
      url,
      "GET",
      undefined,
      opts.signal
    );
    return normalizeMonitorDefinition(result, this.appBaseUrl);
  }
}

/** Coerce one aggregate bucket into a typed {@link DatadogLogGroupCount}. */
function normalizeAggregateBucket(
  raw: unknown,
  facet: string
): DatadogLogGroupCount {
  const obj = (raw ?? {}) as {
    by?: Record<string, unknown>;
    computes?: Record<string, unknown>;
  };
  const by = obj.by && typeof obj.by === "object" ? obj.by : {};
  const rawGroup = by[facet];
  const group =
    rawGroup === undefined || rawGroup === null ? "" : String(rawGroup);
  // A single-compute aggregate keys the count under an alias (`c0` by default);
  // take the first numeric value rather than depend on that alias.
  let count = 0;
  const computes = obj.computes && typeof obj.computes === "object" ? obj.computes : {};
  for (const value of Object.values(computes)) {
    if (typeof value === "number") {
      count = value;
      break;
    }
  }
  return { group, count };
}

/** Coerce one log event into a typed {@link DatadogLogSample}. */
function normalizeLogSample(raw: unknown): DatadogLogSample {
  const obj = (raw ?? {}) as { attributes?: unknown };
  const attrs =
    obj.attributes && typeof obj.attributes === "object"
      ? (obj.attributes as Record<string, unknown>)
      : {};
  return {
    timestamp: str(attrs.timestamp),
    status: str(attrs.status),
    service: str(attrs.service),
    message: truncateMessage(str(attrs.message), DATADOG_MESSAGE_MAX_LENGTH),
  };
}

/** Coerce one monitor into a typed {@link DatadogMonitorState}. */
function normalizeMonitor(raw: unknown, appBaseUrl: string): DatadogMonitorState {
  const obj = (raw ?? {}) as {
    id?: unknown;
    name?: unknown;
    query?: unknown;
    overall_state?: unknown;
    state?: unknown;
  };
  const id = typeof obj.id === "number" ? obj.id : 0;
  const groups: DatadogMonitorGroupState[] = [];
  const state = obj.state && typeof obj.state === "object" ? (obj.state as { groups?: unknown }) : {};
  const rawGroups =
    state.groups && typeof state.groups === "object"
      ? (state.groups as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(rawGroups)) {
    const g = (value ?? {}) as { name?: unknown; status?: unknown };
    groups.push({
      group: typeof g.name === "string" ? g.name : key,
      state: str(g.status),
    });
  }
  return {
    id,
    name: str(obj.name),
    query: str(obj.query),
    overall_state: str(obj.overall_state),
    groups,
    url: id ? `${appBaseUrl}/monitors/${id}` : "",
  };
}

/**
 * Coerce one monitor's full definition into a typed
 * {@link DatadogMonitorDefinition}: the state fields (via {@link normalizeMonitor})
 * plus its type, string tags, numeric alert thresholds, and a bounded map of the
 * notable scalar options in {@link MONITOR_OPTION_KEYS}. Only present, correctly
 * typed keys are surfaced; everything else is dropped.
 */
function normalizeMonitorDefinition(
  raw: unknown,
  appBaseUrl: string
): DatadogMonitorDefinition {
  const state = normalizeMonitor(raw, appBaseUrl);
  const obj = (raw ?? {}) as { type?: unknown; tags?: unknown; options?: unknown };

  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string")
    : [];

  const options =
    obj.options && typeof obj.options === "object"
      ? (obj.options as Record<string, unknown>)
      : {};

  const rawThresholds =
    options.thresholds && typeof options.thresholds === "object"
      ? (options.thresholds as Record<string, unknown>)
      : {};
  const thresholds: Record<string, number> = {};
  for (const key of MONITOR_THRESHOLD_KEYS) {
    const value = rawThresholds[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      thresholds[key] = value;
    }
  }

  const summary: Record<string, string | number | boolean> = {};
  for (const key of MONITOR_OPTION_KEYS) {
    const value = options[key];
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      summary[key] = value;
    }
  }

  return {
    ...state,
    type: str(obj.type),
    tags,
    thresholds,
    options: summary,
  };
}

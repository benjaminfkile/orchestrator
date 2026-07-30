/**
 * The Datadog log-watch producer — a single producer, registered under the id
 * `datadog.logwatch`, that on each `tick()` runs every configured watch's cheap
 * AGGREGATION query, maintains an in-memory trailing baseline per (watch, group),
 * and emits ONE generic event per group that trips a statistical detector.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) this file learns nothing about
 * what the watched logs *mean*. It counts an opaque grouped facet, compares that
 * count to a data-driven threshold / trailing baseline / novelty check, and — on
 * a trip — attaches a bounded sample and emits a SINGLE generic event type
 * (`datadog.logs.alert`). Rules discriminate on the payload (which detectors
 * fired, the count, the group), so the intent never enters a code branch. It
 * NEVER emits per log line: the aggregate is the unit of work and the only reason
 * it ever reaches for raw log lines is the small post-trip sample.
 *
 * BASELINE & SEEDING. Per (watch, group) it keeps a ring buffer of the last
 * `baseline_windows` counts; the baseline is their mean (a 0-count window for an
 * already-known group is folded in as a 0 so a quiet group's baseline decays).
 * The baselines live only in memory, so a restart loses them: the FIRST tick
 * after start — and the first tick after any config change — SEEDS SILENTLY,
 * populating the buffers and emitting nothing, exactly like the ado snapshot.
 * Only subsequent ticks evaluate detectors and emit.
 *
 * FAIL-QUIET. A tick that fails (auth, 429, network) logs a warning and emits
 * nothing; the baselines are left untouched so the next tick simply retries. A
 * tick is also bounded: at most {@link DATADOG_MAX_GROUPS_PER_TICK} groups are
 * processed per watch, and a truncation is logged (never silent).
 *
 * READ-ONLY. Every Datadog call this producer makes is a read (see {@link
 * import("./client").DatadogClient}); all output is recorded locally as events.
 */

import type { NewEvent } from "../../interfaces";
import { log, type Logger } from "../../log";
import { emitEvent } from "../../services/eventIntake";
import type { Trigger, TriggerScheduler } from "../../services/triggerScheduler";
import type { Producer } from "../registry";

import {
  DatadogClient,
  resolveDatadogAppBaseUrl,
  type DatadogClientOptions,
  type DatadogLogGroupCount,
  type DatadogLogSample,
} from "./client";
import {
  DATADOG_DEFAULT_BASELINE_WINDOWS,
  DATADOG_DEFAULT_INTERVAL_SECONDS,
  DATADOG_DEFAULT_SAMPLE_LIMIT,
  DATADOG_EVENT_SOURCE,
  type DatadogModuleConfig,
  type DatadogWatchConfig,
  type EmitFn,
  type SecretResolver,
} from "./index";

/** The stable producer id for the log-watch producer, as required by the task. */
export const DATADOG_LOGWATCH_PRODUCER_ID = "datadog.logwatch";

/** The `subject_kind` stamped on every event this producer emits. */
export const DATADOG_LOG_SUBJECT_KIND = "log_group";

/**
 * The SINGLE generic event `type` this producer emits — rules discriminate on
 * the payload (`detectors`, `count`, `group`), never on distinct type strings, so
 * the code stays intent-free (see the architecture principle).
 */
export const DATADOG_LOGS_ALERT_EVENT_TYPE = "datadog.logs.alert";

/** Detector labels recorded in `payload.detectors` — the strings rules match on. */
export const DATADOG_DETECTOR_THRESHOLD = "threshold";
export const DATADOG_DETECTOR_SPIKE = "spike";
export const DATADOG_DETECTOR_NOVEL = "novel";

/**
 * Hard cap on the number of groups processed per watch per tick. A watch whose
 * aggregate returns more is truncated to this many, and the truncation is logged
 * (never silent) — the cap bounds how many events one tick can emit.
 */
export const DATADOG_MAX_GROUPS_PER_TICK = 50;

/** The read-only Datadog surface this producer uses; {@link DatadogClient} satisfies it. */
export interface DatadogLogWatchReadClient {
  aggregateLogs(params: {
    query: string;
    from: number;
    to: number;
    groupBy: string;
    limit?: number;
  }): Promise<DatadogLogGroupCount[]>;
  searchLogs(params: {
    query: string;
    from: number;
    to: number;
    limit?: number;
  }): Promise<DatadogLogSample[]>;
}

/** Builds a read client from resolved connection options; injectable for tests. */
export type DatadogLogWatchClientFactory = (
  opts: DatadogClientOptions
) => DatadogLogWatchReadClient;

/** Injected collaborators for {@link createLogWatchProducer}. */
export interface LogWatchProducerDeps {
  /** Scheduler the producer re-arms whenever its config changes. */
  scheduler: TriggerScheduler;
  /** Resolves the API + Application keys from their `*_secret_ref` names. Required. */
  resolveSecret: SecretResolver;
  /** Emits detector events; defaults to the real {@link emitEvent} on the app db. */
  emit?: EmitFn;
  /** Builds the Datadog read client; defaults to constructing a {@link DatadogClient}. */
  clientFactory?: DatadogLogWatchClientFactory;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  clock?: () => number;
}

/** The observable status of the producer, surfaced for the modules API. */
export interface DatadogProducerStatus {
  running: boolean;
  last_tick_at: number | null;
  /** Count of tracked (watch, group) baselines after the most recent tick. */
  seeded_count: number;
  last_error: string | null;
}

/** A constructed log-watch producer plus the handles the module wires in. */
export interface LogWatchProducer {
  producer: Producer;
  /** Re-derive the trigger and reset baselines; call from the module's applyConfig. */
  applyConfig(config: DatadogModuleConfig | undefined): void;
  /** A snapshot copy of the current producer status. */
  getStatus(): DatadogProducerStatus;
}

/** In-memory trailing state for one watch, keyed by group. */
interface WatchState {
  /** group → ring buffer of the last `baseline_windows` counts. */
  baselines: Map<string, number[]>;
  /** Every group key ever seen for this watch (backs the novelty detector). */
  seen: Set<string>;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when a watch arms at least one detector; a watch with none never fires. */
function hasDetectors(watch: DatadogWatchConfig): boolean {
  const d = watch.detect;
  if (!d) return false;
  return (
    d.min_count !== undefined ||
    d.spike_multiplier !== undefined ||
    d.novel_groups === true
  );
}

/** The arithmetic mean of a buffer; 0 for an empty buffer. */
function mean(buf: number[]): number {
  if (buf.length === 0) return 0;
  let total = 0;
  for (const v of buf) total += v;
  return total / buf.length;
}

/** Push `count` into a group's ring buffer, trimming to `maxLen` from the front. */
function pushRing(
  state: WatchState,
  group: string,
  count: number,
  maxLen: number
): void {
  let buf = state.baselines.get(group);
  if (!buf) {
    buf = [];
    state.baselines.set(group, buf);
  }
  buf.push(count);
  while (buf.length > maxLen) buf.shift();
}

/**
 * Build the Datadog Logs Explorer deep link for a query over a window — a
 * display-only convenience carried on the event so an operator can jump straight
 * to the matching logs. Synthesized from the site's web-app host.
 */
function buildExplorerUrl(
  appBaseUrl: string,
  query: string,
  fromMs: number,
  toMs: number
): string {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("from_ts", String(fromMs));
  params.set("to_ts", String(toMs));
  params.set("live", "false");
  return `${appBaseUrl}/logs?${params.toString()}`;
}

/**
 * Scope a watch's query to a single group for the post-trip sample. Reserved and
 * attribute facets share the `facet:value` search syntax, so appending
 * `<group_by>:<group>` narrows the sample to the tripped group. An empty group
 * key (the API omitted the facet) leaves the query unscoped.
 */
function scopeQueryToGroup(
  query: string,
  groupBy: string,
  group: string
): string {
  if (!group) return query;
  return `${query} ${groupBy}:${group}`;
}

/** Derive the producer trigger from config: enabled + at least one watch → interval. */
function triggerFromConfig(cfg: DatadogModuleConfig): Trigger {
  if (
    cfg.enabled &&
    Array.isArray(cfg.watches) &&
    cfg.watches.some(hasDetectors)
  ) {
    const seconds =
      typeof cfg.interval_seconds === "number" && cfg.interval_seconds > 0
        ? cfg.interval_seconds
        : DATADOG_DEFAULT_INTERVAL_SECONDS;
    return { kind: "interval", seconds };
  }
  return { kind: "manual" };
}

/**
 * Build the Datadog log-watch producer. The owning module registers the returned
 * `producer` and forwards every config write to {@link LogWatchProducer.applyConfig},
 * which re-derives the trigger AND resets the baselines so the next tick reseeds
 * silently.
 */
export function createLogWatchProducer(
  deps: LogWatchProducerDeps
): LogWatchProducer {
  const { scheduler, resolveSecret } = deps;
  const emit: EmitFn = deps.emit ?? ((event) => emitEvent(event));
  const clientFactory: DatadogLogWatchClientFactory =
    deps.clientFactory ?? ((opts) => new DatadogClient(opts));
  const logger = (deps.logger ?? log).child({ component: "datadogLogWatch" });
  const clock = deps.clock ?? Date.now;

  const watchStates = new Map<string, WatchState>();
  let currentConfig: DatadogModuleConfig | undefined;
  let seeded = false;

  const status: DatadogProducerStatus = {
    running: false,
    last_tick_at: null,
    seeded_count: 0,
    last_error: null,
  };

  /** Fetch or lazily create the in-memory state for a watch. */
  function ensureState(name: string): WatchState {
    let state = watchStates.get(name);
    if (!state) {
      state = { baselines: new Map(), seen: new Set() };
      watchStates.set(name, state);
    }
    return state;
  }

  /** Total number of tracked (watch, group) baselines, for the status. */
  function baselineCount(): number {
    let total = 0;
    for (const state of watchStates.values()) total += state.seen.size;
    return total;
  }

  /**
   * Resolve a read client from the current config, throwing a clear error when a
   * key secret is unavailable. The keys are read from the secret store by their
   * refs; neither is logged.
   */
  async function resolveClient(
    cfg: DatadogModuleConfig
  ): Promise<DatadogLogWatchReadClient> {
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

  /**
   * Aggregate one watch over its window, capped at
   * {@link DATADOG_MAX_GROUPS_PER_TICK}. Probes one past the cap so a truncation
   * is observable, logs it (never silent), and returns the capped buckets plus the
   * window bounds used.
   */
  async function aggregateWatch(
    client: DatadogLogWatchReadClient,
    cfg: DatadogModuleConfig,
    watch: DatadogWatchConfig
  ): Promise<{ counts: DatadogLogGroupCount[]; from: number; to: number }> {
    const windowSeconds =
      watch.window_seconds ??
      cfg.interval_seconds ??
      DATADOG_DEFAULT_INTERVAL_SECONDS;
    const to = clock();
    const from = to - windowSeconds * 1000;
    const raw = await client.aggregateLogs({
      query: watch.query,
      from,
      to,
      groupBy: watch.group_by,
      // Probe one past the cap so we can tell a truncation from an exact fit.
      limit: DATADOG_MAX_GROUPS_PER_TICK + 1,
    });
    if (raw.length > DATADOG_MAX_GROUPS_PER_TICK) {
      logger.warn("log watch aggregate truncated to group cap", {
        watch: watch.name,
        returned: raw.length,
        cap: DATADOG_MAX_GROUPS_PER_TICK,
      });
    }
    return {
      counts: raw.slice(0, DATADOG_MAX_GROUPS_PER_TICK),
      from,
      to,
    };
  }

  /**
   * Evaluate a watch's detectors for one already-seeded group and, when any fire,
   * fetch a bounded sample and emit ONE event listing every detector that fired.
   */
  async function evaluateGroup(
    client: DatadogLogWatchReadClient,
    cfg: DatadogModuleConfig,
    watch: DatadogWatchConfig,
    state: WatchState,
    group: string,
    count: number,
    from: number,
    to: number
  ): Promise<void> {
    const detect = watch.detect ?? {};
    // Trailing baseline: the mean of the PRIOR windows, before this tick's count
    // is folded in. An empty/never-seen buffer means baseline 0.
    const baseline = mean(state.baselines.get(group) ?? []);
    const isNovel = !state.seen.has(group);

    const detectors: string[] = [];
    if (detect.min_count !== undefined && count >= detect.min_count) {
      detectors.push(DATADOG_DETECTOR_THRESHOLD);
    }
    if (
      detect.spike_multiplier !== undefined &&
      baseline > 0 &&
      count >= detect.spike_multiplier * baseline
    ) {
      detectors.push(DATADOG_DETECTOR_SPIKE);
    }
    if (detect.novel_groups === true && isNovel) {
      detectors.push(DATADOG_DETECTOR_NOVEL);
    }
    if (detectors.length === 0) return;

    const sampleLimit = watch.sample_limit ?? DATADOG_DEFAULT_SAMPLE_LIMIT;
    const samples = await client.searchLogs({
      query: scopeQueryToGroup(watch.query, watch.group_by, group),
      from,
      to,
      limit: sampleLimit,
    });
    const explorerUrl = buildExplorerUrl(
      resolveDatadogAppBaseUrl(cfg.site),
      watch.query,
      from,
      to
    );

    await emit({
      source: DATADOG_EVENT_SOURCE,
      type: DATADOG_LOGS_ALERT_EVENT_TYPE,
      subject_kind: DATADOG_LOG_SUBJECT_KIND,
      subject_ref: `${watch.name}/${group}`,
      dedupe_key: `datadog:${watch.name}:${group}`,
      payload: {
        watch: watch.name,
        query: watch.query,
        group_by: watch.group_by,
        group,
        detectors,
        count,
        baseline,
        window_start: from,
        window_end: to,
        samples,
        explorer_url: explorerUrl,
      },
    });
  }

  /**
   * Fold one tick's counts for a watch into its baselines: push each present
   * group's count and mark it seen, then push a 0 for every already-known group
   * that produced no logs this window so a quiet group's baseline decays.
   */
  function updateBaselines(
    state: WatchState,
    watch: DatadogWatchConfig,
    counts: DatadogLogGroupCount[]
  ): void {
    const maxLen =
      watch.detect?.baseline_windows ?? DATADOG_DEFAULT_BASELINE_WINDOWS;
    const present = new Set<string>();
    for (const { group, count } of counts) {
      present.add(group);
      pushRing(state, group, count, maxLen);
      state.seen.add(group);
    }
    for (const group of state.seen) {
      if (!present.has(group)) pushRing(state, group, 0, maxLen);
    }
  }

  /** Run one poll: for each watch, seed silently or detect-and-emit. */
  async function tick(): Promise<void> {
    status.running = true;
    status.last_tick_at = clock();
    try {
      const cfg = currentConfig;
      const watches = (cfg?.watches ?? []).filter(hasDetectors);
      if (!cfg || !cfg.enabled || watches.length === 0) {
        // Nothing to poll (disabled or no armed watch): a clean no-op.
        status.last_error = null;
        return;
      }

      const client = await resolveClient(cfg);

      if (!seeded) {
        // Silent (re)seed: populate every baseline and emit nothing, so a restart
        // or reconfigure never replays the current firehose as a storm.
        watchStates.clear();
        for (const watch of watches) {
          const { counts } = await aggregateWatch(client, cfg, watch);
          updateBaselines(ensureState(watch.name), watch, counts);
        }
        seeded = true;
        status.seeded_count = baselineCount();
        status.last_error = null;
        logger.info("seeded log-watch baselines silently", {
          count: status.seeded_count,
        });
        return;
      }

      for (const watch of watches) {
        const state = ensureState(watch.name);
        const { counts, from, to } = await aggregateWatch(client, cfg, watch);
        for (const { group, count } of counts) {
          await evaluateGroup(client, cfg, watch, state, group, count, from, to);
        }
        // Only fold the counts in AFTER detection, so this window's count is
        // never part of its own trailing baseline and novelty is judged against
        // the prior `seen` set.
        updateBaselines(state, watch, counts);
      }
      status.seeded_count = baselineCount();
      status.last_error = null;
    } catch (err) {
      status.last_error = errorMessage(err);
      logger.warn("datadog log-watch tick failed", { error: status.last_error });
    } finally {
      status.running = false;
    }
  }

  /**
   * Re-derive the trigger and RESET the baselines on every config change, so the
   * very next tick reseeds silently rather than replaying the firehose.
   */
  function applyConfig(config: DatadogModuleConfig | undefined): void {
    currentConfig = config ?? {};
    watchStates.clear();
    seeded = false;
    status.seeded_count = 0;
    scheduler.applyTrigger(
      DATADOG_LOGWATCH_PRODUCER_ID,
      triggerFromConfig(currentConfig)
    );
  }

  const producer: Producer = {
    id: DATADOG_LOGWATCH_PRODUCER_ID,
    tick,
    defaultTrigger: { kind: "manual" },
  };

  return {
    producer,
    applyConfig,
    getStatus: () => ({ ...status }),
  };
}

/**
 * The Datadog monitor-transition producer — a single producer, registered under
 * the id `datadog.monitor`, that on each `tick()` reads the current state of the
 * configured monitors and DIFFS them against an in-memory snapshot to emit a
 * generic event whenever a monitor's (or a monitor group's) state CHANGES.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) this file learns nothing about
 * what a monitor *means*. It compares opaque `state` strings per `monitorId+group`
 * and, on a change, emits `datadog.monitor.transition`; that event `type` string
 * is the only place a domain word ever appears. Rules discriminate on the payload
 * (`from_state`, `to_state`, `group`), never in a code branch. There is NO event
 * when a state is unchanged.
 *
 * SNAPSHOT & SEEDING. The snapshot is `Map<"<id>::<group>", state>`. The FIRST
 * tick after start — and the first tick after any config change — SEEDS SILENTLY:
 * it records the current states and emits nothing, so a restart (or a reconfigure)
 * never replays every already-alerting monitor as a flood. Only subsequent ticks
 * diff and emit, and a change is only emitted against a KNOWN prior state — a
 * newly-appearing monitor/group is recorded silently, then its next change fires.
 *
 * FAIL-QUIET. A tick that fails (auth, 429, network) logs a warning and emits
 * nothing; the snapshot is left untouched so the next tick simply retries.
 *
 * READ-ONLY. `listMonitorStates` never creates, edits, mutes, or deletes a
 * monitor; all output is recorded locally as events.
 */

import type { NewEvent } from "../../interfaces";
import { log, type Logger } from "../../log";
import { emitEvent } from "../../services/eventIntake";
import type { Trigger, TriggerScheduler } from "../../services/triggerScheduler";
import type { Producer } from "../registry";

import {
  DatadogClient,
  type DatadogClientOptions,
  type DatadogMonitorState,
} from "./client";
import {
  DATADOG_DEFAULT_INTERVAL_SECONDS,
  DATADOG_EVENT_SOURCE,
  type DatadogModuleConfig,
  type DatadogProducerStatus,
  type EmitFn,
  type SecretResolver,
} from "./index";

/** The stable producer id for the monitor producer, as required by the task. */
export const DATADOG_MONITOR_PRODUCER_ID = "datadog.monitor";

/** The `subject_kind` stamped on every event this producer emits. */
export const DATADOG_MONITOR_SUBJECT_KIND = "monitor";

/** The event `type` string — the sole place a domain word is allowed to appear. */
export const DATADOG_MONITOR_TRANSITION_EVENT_TYPE =
  "datadog.monitor.transition";

/**
 * The synthetic group key used for a monitor that carries no per-group states —
 * its overall state is tracked under this single key.
 */
export const DATADOG_MONITOR_OVERALL_GROUP = "*";

/** The read-only Datadog surface this producer uses; {@link DatadogClient} satisfies it. */
export interface DatadogMonitorReadClient {
  listMonitorStates(params?: {
    monitorTags?: string[];
  }): Promise<DatadogMonitorState[]>;
}

/** Builds a read client from resolved connection options; injectable for tests. */
export type DatadogMonitorClientFactory = (
  opts: DatadogClientOptions
) => DatadogMonitorReadClient;

/** Injected collaborators for {@link createMonitorWatchProducer}. */
export interface MonitorWatchProducerDeps {
  /** Scheduler the producer re-arms whenever its config changes. */
  scheduler: TriggerScheduler;
  /** Resolves the API + Application keys from their `*_secret_ref` names. Required. */
  resolveSecret: SecretResolver;
  /** Emits transition events; defaults to the real {@link emitEvent} on the app db. */
  emit?: EmitFn;
  /** Builds the Datadog read client; defaults to constructing a {@link DatadogClient}. */
  clientFactory?: DatadogMonitorClientFactory;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  clock?: () => number;
}

/** A constructed monitor producer plus the handles the module wires in. */
export interface MonitorWatchProducer {
  producer: Producer;
  /** Re-derive the trigger and reset the snapshot; call from the module's applyConfig. */
  applyConfig(config: DatadogModuleConfig | undefined): void;
  /** A snapshot copy of the current producer status. */
  getStatus(): DatadogProducerStatus;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The snapshot key for one monitor's group-level (or overall) state. */
function stateKey(id: number, group: string): string {
  return `${id}::${group}`;
}

/**
 * Flatten one monitor into its tracked `{group, state}` rows: the per-group
 * states when the monitor is grouped, else a single row for its overall state
 * under {@link DATADOG_MONITOR_OVERALL_GROUP}.
 */
function monitorRows(
  monitor: DatadogMonitorState
): { group: string; state: string }[] {
  if (monitor.groups.length > 0) {
    return monitor.groups.map((g) => ({ group: g.group, state: g.state }));
  }
  return [
    { group: DATADOG_MONITOR_OVERALL_GROUP, state: monitor.overall_state },
  ];
}

/** Derive the producer trigger from config: enabled + monitors.enabled → interval. */
function triggerFromConfig(cfg: DatadogModuleConfig): Trigger {
  if (cfg.enabled && cfg.monitors?.enabled) {
    const seconds =
      typeof cfg.interval_seconds === "number" && cfg.interval_seconds > 0
        ? cfg.interval_seconds
        : DATADOG_DEFAULT_INTERVAL_SECONDS;
    return { kind: "interval", seconds };
  }
  return { kind: "manual" };
}

/**
 * Build the Datadog monitor-transition producer. The owning module registers the
 * returned `producer` and forwards every config write to
 * {@link MonitorWatchProducer.applyConfig}, which re-derives the trigger AND
 * resets the snapshot so the next tick reseeds silently.
 */
export function createMonitorWatchProducer(
  deps: MonitorWatchProducerDeps
): MonitorWatchProducer {
  const { scheduler, resolveSecret } = deps;
  const emit: EmitFn = deps.emit ?? ((event) => emitEvent(event));
  const clientFactory: DatadogMonitorClientFactory =
    deps.clientFactory ?? ((opts) => new DatadogClient(opts));
  const logger = (deps.logger ?? log).child({ component: "datadogMonitor" });
  const clock = deps.clock ?? Date.now;

  const snapshot = new Map<string, string>();
  let currentConfig: DatadogModuleConfig | undefined;
  let seeded = false;

  const status: DatadogProducerStatus = {
    running: false,
    last_tick_at: null,
    seeded_count: 0,
    last_error: null,
  };

  /**
   * Resolve a read client from the current config, throwing a clear error when a
   * key secret is unavailable. The keys are read from the secret store by their
   * refs; neither is logged.
   */
  async function resolveClient(
    cfg: DatadogModuleConfig
  ): Promise<DatadogMonitorReadClient> {
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

  /** Run one poll: list monitor states, then seed silently or diff-and-emit. */
  async function tick(): Promise<void> {
    status.running = true;
    status.last_tick_at = clock();
    try {
      const cfg = currentConfig;
      if (!cfg || !cfg.enabled || !cfg.monitors?.enabled) {
        // Nothing to poll (disabled): a clean no-op.
        status.last_error = null;
        return;
      }

      const client = await resolveClient(cfg);
      const monitors = await client.listMonitorStates({
        monitorTags: cfg.monitors.monitor_tags,
      });

      if (!seeded) {
        snapshot.clear();
        for (const monitor of monitors) {
          for (const { group, state } of monitorRows(monitor)) {
            snapshot.set(stateKey(monitor.id, group), state);
          }
        }
        seeded = true;
        status.seeded_count = snapshot.size;
        status.last_error = null;
        logger.info("seeded monitor snapshot silently", {
          count: snapshot.size,
        });
        return;
      }

      for (const monitor of monitors) {
        for (const { group, state } of monitorRows(monitor)) {
          const key = stateKey(monitor.id, group);
          const prev = snapshot.get(key);
          // Emit only a change against a KNOWN prior state; a newly-seen monitor
          // or group is recorded silently and fires on its next change.
          if (prev !== undefined && prev !== state) {
            await emit({
              source: DATADOG_EVENT_SOURCE,
              type: DATADOG_MONITOR_TRANSITION_EVENT_TYPE,
              subject_kind: DATADOG_MONITOR_SUBJECT_KIND,
              subject_ref: String(monitor.id),
              dedupe_key: `datadog:monitor:${monitor.id}:${group}`,
              payload: {
                monitor_id: monitor.id,
                name: monitor.name,
                query: monitor.query,
                group,
                from_state: prev,
                to_state: state,
                url: monitor.url,
              },
            });
          }
          snapshot.set(key, state);
        }
      }
      status.seeded_count = snapshot.size;
      status.last_error = null;
    } catch (err) {
      status.last_error = errorMessage(err);
      logger.warn("datadog monitor tick failed", { error: status.last_error });
    } finally {
      status.running = false;
    }
  }

  /**
   * Re-derive the trigger and RESET the snapshot on every config change, so the
   * very next tick reseeds silently rather than replaying every monitor state.
   */
  function applyConfig(config: DatadogModuleConfig | undefined): void {
    currentConfig = config ?? {};
    snapshot.clear();
    seeded = false;
    status.seeded_count = 0;
    scheduler.applyTrigger(
      DATADOG_MONITOR_PRODUCER_ID,
      triggerFromConfig(currentConfig)
    );
  }

  const producer: Producer = {
    id: DATADOG_MONITOR_PRODUCER_ID,
    tick,
    defaultTrigger: { kind: "manual" },
  };

  return {
    producer,
    applyConfig,
    getStatus: () => ({ ...status }),
  };
}

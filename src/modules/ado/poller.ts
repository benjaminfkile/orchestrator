/**
 * The Azure DevOps work-item poller — a single producer, registered under the id
 * `ado.workitem`, that on each `tick()` runs the module's watched WIQL query,
 * batch-fetches the matching work items, and DIFFS them against an in-memory
 * snapshot to emit generic events.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) this file learns nothing about
 * what the polled items *mean*. It compares opaque per-item facets — state,
 * assignee, area, iteration, tags, and the item's last-changed timestamp — and
 * turns each kind of change into an event whose `type` string is the only place
 * an intent word ever appears. The core downstream never branches on those
 * strings; rules and playbooks (user data) do.
 *
 * SNAPSHOT & SEEDING. The snapshot is
 * `Map<id, {state, assignee, area, iteration, tags, changed}>`.
 * The FIRST tick after start — and the first tick after any config change —
 * SEEDS SILENTLY: it populates the snapshot and emits nothing, so a restart (or a
 * re-configure) never replays the whole board as a flood of "created" events.
 * Only subsequent ticks diff and emit.
 *
 * READ-ONLY. Every ADO call this producer makes is a read (see {@link
 * import("./client").ADOClient}); all output is recorded locally as events.
 */

import type { NewEvent } from "../../interfaces";
import { log, type Logger } from "../../log";
import { emitEvent } from "../../services/eventIntake";
import type { Trigger, TriggerScheduler } from "../../services/triggerScheduler";
import type {
  BackfillOptions,
  BackfillResult,
  OrchestratorModule,
  Producer,
} from "../registry";

import {
  createGetWorkItemCapability,
  createGetWorkItemLinksCapability,
  createQueryWorkItemsCapability,
  createSprintRollupCapability,
  type AdoBoardClientFactory,
  type AdoCapabilityClientFactory,
  type AdoLinksClientFactory,
} from "./capability";
import {
  ADOClient,
  type ADOClientOptions,
  type ADOComment,
  type ADOWorkItem,
} from "./client";
import {
  ADO_PR_EVENT_CREATED,
  ADO_PR_EVENT_UPDATED,
  ADO_PR_PRODUCER_ID,
  createPullRequestProducer,
  type AdoPrClientFactory,
  type PullRequestsConfig,
} from "./pr";
import { buildWatchedWiql, type WatchedWiqlConfig } from "./wiql";
import {
  buildWorkItemPayload,
  identityPayload,
  toWorkItemView,
  type WorkItemView,
} from "./workItemPayload";

/** The module id this producer lives under, and its `module_config` key. */
export const ADO_MODULE_ID = "ado";
/** The stable producer id, as required by the task. */
export const ADO_PRODUCER_ID = "ado.workitem";

/** The `source` stamped on every event this producer emits. */
export const ADO_EVENT_SOURCE = "ado";
/** The `subject_kind` stamped on every event this producer emits. */
export const ADO_SUBJECT_KIND = "work_item";

/** Event `type` strings — the sole place a domain word is allowed to appear. */
export const ADO_EVENT_CREATED = "ado.workitem.created";
export const ADO_EVENT_ASSIGNED = "ado.workitem.assigned";
export const ADO_EVENT_STATE_CHANGED = "ado.workitem.state_changed";
export const ADO_EVENT_AREA_CHANGED = "ado.workitem.area_changed";
export const ADO_EVENT_ITERATION_CHANGED = "ado.workitem.iteration_changed";
export const ADO_EVENT_TAGGED = "ado.workitem.tagged";
export const ADO_EVENT_UPDATED = "ado.workitem.updated";
export const ADO_EVENT_COMMENT_CREATED = "ado.workitem.comment.created";

/** Poll cadence used when the module is enabled but names no `interval_seconds`. */
export const ADO_DEFAULT_INTERVAL_SECONDS = 60;

/**
 * Data-only module config, persisted under `module_config` key `ado`. Every field
 * is optional so a half-filled config never throws — an incomplete config simply
 * yields a manual trigger and a no-op tick.
 */
export interface AdoModuleConfig {
  /** Azure DevOps organization. */
  org?: string;
  /** Azure DevOps project. */
  project?: string;
  /** Name of the secret (in the secret store) holding the PAT. */
  pat_secret_ref?: string;
  /** Master switch: only an enabled module arms an interval trigger. */
  enabled?: boolean;
  /** Poll cadence in seconds; falls back to {@link ADO_DEFAULT_INTERVAL_SECONDS}. */
  interval_seconds?: number;
  /** The watched-query builder config passed to {@link buildWatchedWiql}. */
  watched?: WatchedWiqlConfig;
  /**
   * Additive config for the `ado.pullrequest` producer. Absent/disabled leaves
   * that producer on a manual trigger; the work-item producer is unaffected.
   */
  pull_requests?: PullRequestsConfig;
  /** Overrides the ADO base URL (tests point this at a mock host). */
  base_url?: string;
}

/**
 * The facets of a work item the poller diffs. Domain-neutral: these are just the
 * values whose changes map to event types, never a modelled concept.
 */
interface WorkItemSnapshot {
  state: string;
  assignee: string;
  area: string;
  iteration: string;
  tags: string[];
  changed: string;
  /** `System.CommentCount` at the last tick; a rise triggers one comments read. */
  commentCount: number;
  /** Highest comment id already emitted (0 until the first comments read). */
  lastCommentId: number;
}

/**
 * The observable status of the producer, surfaced for the modules API. `running`
 * is true while a tick is in flight; `seeded_count` is the snapshot size after
 * the most recent (re)seed.
 */
export interface AdoProducerStatus {
  running: boolean;
  last_tick_at: number | null;
  seeded_count: number;
  last_error: string | null;
}

/** The emit surface this producer needs; injectable so tests can capture events. */
export type EmitFn = (event: NewEvent) => Promise<unknown>;

/** Resolves a secret ref (e.g. the PAT) to its value, or `undefined` if unset. */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

/** The read-only ADO surface this producer uses; {@link ADOClient} satisfies it. */
export interface AdoReadClient {
  runWiql(query: string): Promise<number[]>;
  getWorkItems(ids: number[]): Promise<ADOWorkItem[]>;
  getWorkItemComments(id: number): Promise<ADOComment[]>;
}

/** Builds a read client from resolved connection options; injectable for tests. */
export type AdoClientFactory = (opts: ADOClientOptions) => AdoReadClient;

/** Injected collaborators for {@link createAdoModule}. */
export interface AdoModuleDeps {
  /** Scheduler the module re-arms whenever its config changes. */
  scheduler: TriggerScheduler;
  /** Resolves the PAT from its `pat_secret_ref`. Required. */
  resolveSecret: SecretResolver;
  /** Emits diffed events; defaults to the real {@link emitEvent} on the app db. */
  emit?: EmitFn;
  /** Builds the ADO read client; defaults to constructing an {@link ADOClient}. */
  clientFactory?: AdoClientFactory;
  /**
   * Builds the read client for the `ado.get_work_item` capability (which also
   * reads comments); defaults to constructing an {@link ADOClient}. Injectable
   * so the wired module's capability can be exercised without a network.
   */
  capabilityClientFactory?: AdoCapabilityClientFactory;
  /**
   * Builds the read client for the board capabilities (`ado.query_work_items`
   * and `ado.sprint_rollup`), which run WIQL and batch-fetch items; defaults to
   * constructing an {@link ADOClient}. Injectable so the wired capabilities can
   * be exercised without a network.
   */
  boardCapabilityClientFactory?: AdoBoardClientFactory;
  /**
   * Builds the read client for the `ado.get_work_item_links` capability (which
   * batch-fetches the subject, its ancestors, and its children/related items);
   * defaults to constructing an {@link ADOClient}. Injectable so the wired
   * capability can be exercised without a network.
   */
  linksCapabilityClientFactory?: AdoLinksClientFactory;
  /**
   * Builds the read client for the `ado.pullrequest` producer (which lists PRs
   * and resolves repo clone URLs); defaults to constructing an {@link ADOClient}.
   * Injectable so the producer can be exercised without a network.
   */
  pullRequestClientFactory?: AdoPrClientFactory;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  clock?: () => number;
}

/** A constructed ADO module plus handles tests and the API layer read. */
export interface AdoModule {
  module: OrchestratorModule;
  producerId: string;
  /** The id of the pull-request producer registered alongside the work-item one. */
  pullRequestProducerId: string;
  /** A snapshot copy of the current work-item producer status. */
  getStatus(): AdoProducerStatus;
  /** A snapshot copy of the current pull-request producer status. */
  getPullRequestStatus(): AdoProducerStatus;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when `next` is a strictly later change-timestamp than `prev`. ISO-8601
 * `ChangedDate` values parse cleanly; if either fails to parse we fall back to a
 * plain inequality so a real change is never swallowed.
 */
function changedAdvanced(prev: string, next: string): boolean {
  if (!next) return false;
  const prevTs = Date.parse(prev);
  const nextTs = Date.parse(next);
  if (Number.isFinite(prevTs) && Number.isFinite(nextTs)) {
    return nextTs > prevTs;
  }
  return next !== prev;
}

/** Capture the diffed facets of a view into a snapshot entry. */
function snapshotOf(v: WorkItemView, lastCommentId = 0): WorkItemSnapshot {
  return {
    state: v.state,
    assignee: v.assignee,
    area: v.area_path,
    iteration: v.iteration_path,
    tags: v.tags,
    changed: v.changed,
    commentCount: v.comment_count,
    lastCommentId,
  };
}

/** Derive the producer trigger from config: enabled + org + project → interval. */
function triggerFromConfig(cfg: AdoModuleConfig): Trigger {
  if (cfg.enabled && cfg.org && cfg.project) {
    const seconds =
      typeof cfg.interval_seconds === "number" && cfg.interval_seconds > 0
        ? cfg.interval_seconds
        : ADO_DEFAULT_INTERVAL_SECONDS;
    return { kind: "interval", seconds };
  }
  return { kind: "manual" };
}

/**
 * Build the ADO work-item poller module.
 *
 * Register the returned `module` with a {@link import("../registry").ModuleRegistry}
 * and arm the producer on its `defaultTrigger`; thereafter every config write
 * flows through {@link OrchestratorModule.applyConfig}, which re-derives the
 * trigger AND resets the snapshot so the next tick reseeds silently.
 */
export function createAdoModule(deps: AdoModuleDeps): AdoModule {
  const { scheduler, resolveSecret } = deps;
  const emit: EmitFn = deps.emit ?? ((event) => emitEvent(event));
  const clientFactory: AdoClientFactory =
    deps.clientFactory ?? ((opts) => new ADOClient(opts));
  const logger = (deps.logger ?? log).child({ component: "adoPoller" });
  const clock = deps.clock ?? Date.now;

  const snapshot = new Map<number, WorkItemSnapshot>();
  let currentConfig: AdoModuleConfig | undefined;
  let seeded = false;

  // The pull-request producer shares the module's connection config (org/project/
  // PAT ref/base_url) but keeps its own snapshot, trigger, and status.
  const pullRequests = createPullRequestProducer({
    scheduler,
    resolveSecret,
    emit: deps.emit,
    clientFactory: deps.pullRequestClientFactory,
    logger: deps.logger,
    clock: deps.clock,
  });

  const status: AdoProducerStatus = {
    running: false,
    last_tick_at: null,
    seeded_count: 0,
    last_error: null,
  };

  /** Emit every event a NEW (previously-unseen) item warrants. */
  async function emitForNew(v: WorkItemView): Promise<void> {
    const base = buildWorkItemPayload(v);
    await emit({
      source: ADO_EVENT_SOURCE,
      type: ADO_EVENT_CREATED,
      subject_kind: ADO_SUBJECT_KIND,
      subject_ref: String(v.id),
      payload: base,
      dedupe_key: `${ADO_EVENT_CREATED}:${v.id}`,
    });
    if (v.assignee) {
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_ASSIGNED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, previous_assignee: null },
        dedupe_key: `${ADO_EVENT_ASSIGNED}:${v.id}:${v.assignee}`,
      });
    }
    for (const tag of v.tags) {
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_TAGGED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, added_tag: tag },
        dedupe_key: `${ADO_EVENT_TAGGED}:${v.id}:${tag}`,
      });
    }
  }

  /**
   * Emit one `comment.created` per comment added since the prior snapshot.
   * Only called when `System.CommentCount` rose, so the common tick issues no
   * comments read. Returns the highest comment id now accounted for. Before the
   * first read the snapshot knows only a count, so the newest `delta` comments
   * (by id) are treated as the new ones; afterwards ids above lastCommentId are.
   */
  async function emitNewComments(
    v: WorkItemView,
    prev: WorkItemSnapshot,
    client: AdoReadClient,
    base: Record<string, unknown>
  ): Promise<number> {
    const comments = (await client.getWorkItemComments(v.id))
      .filter((c) => typeof c.id === "number" && c.id > 0)
      .sort((a, b) => a.id - b.id);
    const delta = Math.max(0, v.comment_count - prev.commentCount);
    const fresh =
      prev.lastCommentId > 0
        ? comments.filter((c) => c.id > prev.lastCommentId)
        : comments.slice(Math.max(0, comments.length - delta));
    for (const c of fresh) {
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_COMMENT_CREATED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: {
          ...base,
          comment_id: c.id,
          author: identityPayload(c.createdBy),
          content: c.text,
          created_date: c.createdDate,
        },
        dedupe_key: `${ADO_EVENT_COMMENT_CREATED}:${v.id}:${c.id}`,
      });
    }
    return comments.length > 0 ? comments[comments.length - 1].id : prev.lastCommentId;
  }

  /**
   * Emit every event a CHANGED item warrants, given its prior snapshot. Returns
   * the highest comment id accounted for, to carry into the next snapshot.
   */
  async function emitForChanged(
    v: WorkItemView,
    prev: WorkItemSnapshot,
    client: AdoReadClient
  ): Promise<number> {
    const base = buildWorkItemPayload(v);
    let lastCommentId = prev.lastCommentId;
    if (v.comment_count > prev.commentCount) {
      lastCommentId = await emitNewComments(v, prev, client, base);
    }
    // Whether any facet-specific change fired; only when none did does a bare
    // ChangedDate advance collapse to a single "updated" event.
    let specificChange = false;

    if (v.assignee !== prev.assignee) {
      specificChange = true;
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_ASSIGNED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, previous_assignee: prev.assignee || null },
        dedupe_key: `${ADO_EVENT_ASSIGNED}:${v.id}:${v.assignee}`,
      });
    }

    if (v.state !== prev.state) {
      specificChange = true;
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_STATE_CHANGED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, previous_state: prev.state },
        dedupe_key: `${ADO_EVENT_STATE_CHANGED}:${v.id}:${v.state}`,
      });
    }

    if (v.area_path !== prev.area) {
      specificChange = true;
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_AREA_CHANGED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, previous_area: prev.area },
        dedupe_key: `${ADO_EVENT_AREA_CHANGED}:${v.id}:${v.area_path}`,
      });
    }

    if (v.iteration_path !== prev.iteration) {
      specificChange = true;
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_ITERATION_CHANGED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, previous_iteration: prev.iteration },
        dedupe_key: `${ADO_EVENT_ITERATION_CHANGED}:${v.id}:${v.iteration_path}`,
      });
    }

    const prevTags = new Set(prev.tags);
    for (const tag of v.tags) {
      if (prevTags.has(tag)) continue;
      specificChange = true;
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_TAGGED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, added_tag: tag },
        dedupe_key: `${ADO_EVENT_TAGGED}:${v.id}:${tag}`,
      });
    }

    const commentAdded = v.comment_count > prev.commentCount;
    if (!specificChange && !commentAdded && changedAdvanced(prev.changed, v.changed)) {
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_UPDATED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: { ...base, changed_date: v.changed },
        dedupe_key: `${ADO_EVENT_UPDATED}:${v.id}:${v.changed}`,
      });
    }
    return lastCommentId;
  }

  /**
   * Resolve a read client from the current config, throwing a clear error when
   * the module is disabled or under-configured. Shared by {@link tick} (via its
   * own guard) and {@link backfill}; the latter depends on exactly the same
   * connection config the poller uses, so it refuses identically.
   */
  async function resolveClient(
    org: string,
    project: string,
    cfg: AdoModuleConfig
  ): Promise<AdoReadClient> {
    const pat = await resolveSecret(cfg.pat_secret_ref ?? "");
    if (!pat) {
      throw new Error(
        `ADO PAT secret unavailable for ref "${cfg.pat_secret_ref ?? ""}"`
      );
    }
    return clientFactory({ org, project, pat, baseUrl: cfg.base_url });
  }

  /**
   * The SINGLE candidate query/fetch shared by {@link tick} and
   * {@link backfill}, so the two candidate sets are constructed identically and
   * can never drift. The result is scoped to the module's configured project two
   * independent ways: (1) `client` is built for that project's project-scoped
   * WIQL route (see {@link resolveClient}), and (2) {@link buildWatchedWiql} is
   * passed the same project so the query carries a `[System.TeamProject]` clause.
   * Either alone bounds the result to the configured project; together a work
   * item from any other project in the same organization can never be a
   * candidate — for a poll tick OR a backfill.
   */
  async function fetchWatchedViews(
    client: AdoReadClient,
    cfg: AdoModuleConfig
  ): Promise<WorkItemView[]> {
    const query = buildWatchedWiql(cfg.watched ?? { assignee_mode: "any" }, {
      project: cfg.project,
    });
    const ids = await client.runWiql(query);
    return (await client.getWorkItems(ids)).map(toWorkItemView);
  }

  /**
   * Operator-triggered backfill: replay the CURRENTLY-watched work items through
   * the normal event intake as `ado.workitem.created` events — the same WIQL
   * builder, the same connection config, and the exact same {@link buildWorkItemPayload}
   * shape a first-seen item produces on a poll tick. Existing rules therefore
   * fire with zero rule changes, and because every event flows through the same
   * {@link emit} the dedupe cooldown and the intake caps all apply unchanged.
   *
   * CRITICAL: this deliberately does NOT read or write `snapshot`/`seeded`, so a
   * backfill leaves the producer's change-tracking state exactly as it found it —
   * the next {@link tick} behaves as if the backfill never happened (no
   * double-fires, no missed changes).
   *
   * Refuses (throws) when the module is disabled or missing org/project, since it
   * depends on the same config the poller does.
   */
  async function backfill(options: BackfillOptions): Promise<BackfillResult> {
    const cfg = currentConfig;
    if (!cfg || !cfg.enabled || !cfg.org || !cfg.project) {
      throw new Error(
        "ado backfill requires the module to be enabled with org and project set"
      );
    }

    const client = await resolveClient(cfg.org, cfg.project, cfg);
    const views = await fetchWatchedViews(client, cfg);

    // Oldest first by change date so a limit-capped backfill triages the
    // longest-waiting items first. Parsed ISO timestamps sort cleanly; an
    // unparseable one sorts as 0 (oldest), harmless for a manual replay.
    const ordered = [...views].sort(
      (a, b) => (Date.parse(a.changed) || 0) - (Date.parse(b.changed) || 0)
    );
    const candidates = ordered.length;
    const selected =
      typeof options.limit === "number"
        ? ordered.slice(0, options.limit)
        : ordered;

    if (options.dryRun) {
      return { candidates, emitted: 0 };
    }

    let emitted = 0;
    for (const v of selected) {
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_CREATED,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: String(v.id),
        payload: buildWorkItemPayload(v),
        dedupe_key: `${ADO_EVENT_CREATED}:${v.id}`,
      });
      emitted += 1;
    }
    return { candidates, emitted };
  }

  /** Run one poll: fetch, then either seed silently or diff-and-emit. */
  async function tick(): Promise<void> {
    status.running = true;
    status.last_tick_at = clock();
    try {
      const cfg = currentConfig;
      if (!cfg || !cfg.enabled || !cfg.org || !cfg.project) {
        // Nothing to poll (disabled or under-configured): a clean no-op.
        status.last_error = null;
        return;
      }

      const client = await resolveClient(cfg.org, cfg.project, cfg);
      const views = await fetchWatchedViews(client, cfg);

      if (!seeded) {
        snapshot.clear();
        for (const v of views) snapshot.set(v.id, snapshotOf(v));
        seeded = true;
        status.seeded_count = snapshot.size;
        status.last_error = null;
        logger.info("seeded snapshot silently", { count: snapshot.size });
        return;
      }

      for (const v of views) {
        const prev = snapshot.get(v.id);
        if (!prev) {
          await emitForNew(v);
          snapshot.set(v.id, snapshotOf(v));
        } else {
          const lastCommentId = await emitForChanged(v, prev, client);
          snapshot.set(v.id, snapshotOf(v, lastCommentId));
        }
      }
      status.seeded_count = snapshot.size;
      status.last_error = null;
    } catch (err) {
      status.last_error = errorMessage(err);
      logger.error("ado poll tick failed", { error: status.last_error });
    } finally {
      status.running = false;
    }
  }

  /**
   * Re-derive the trigger and RESET the snapshot on every config change, so the
   * very next tick reseeds silently rather than replaying the board.
   */
  function applyConfig(config: unknown): void {
    currentConfig = (config ?? {}) as AdoModuleConfig;
    snapshot.clear();
    seeded = false;
    status.seeded_count = 0;
    scheduler.applyTrigger(ADO_PRODUCER_ID, triggerFromConfig(currentConfig));
    // Forward the same config to the pull-request producer so it reconciles its
    // own trigger and reseeds its own snapshot.
    pullRequests.applyConfig(currentConfig);
  }

  const producer: Producer = {
    id: ADO_PRODUCER_ID,
    tick,
    backfill,
    defaultTrigger: { kind: "manual" },
  };

  const getWorkItemCapability = createGetWorkItemCapability({
    resolveSecret,
    clientFactory: deps.capabilityClientFactory,
  });
  const queryWorkItemsCapability = createQueryWorkItemsCapability({
    resolveSecret,
    clientFactory: deps.boardCapabilityClientFactory,
    now: clock,
  });
  const sprintRollupCapability = createSprintRollupCapability({
    resolveSecret,
    clientFactory: deps.boardCapabilityClientFactory,
    now: clock,
  });
  const workItemLinksCapability = createGetWorkItemLinksCapability({
    resolveSecret,
    clientFactory: deps.linksCapabilityClientFactory,
  });

  const module: OrchestratorModule = {
    id: ADO_MODULE_ID,
    producers: [producer, pullRequests.producer],
    capabilities: [
      getWorkItemCapability,
      queryWorkItemsCapability,
      sprintRollupCapability,
      workItemLinksCapability,
    ],
    // Advertise the event types these producers can emit so the facets endpoint
    // can suggest them before any have been recorded (empty events table).
    eventTypes: [
      ADO_EVENT_CREATED,
      ADO_EVENT_ASSIGNED,
      ADO_EVENT_STATE_CHANGED,
      ADO_EVENT_AREA_CHANGED,
      ADO_EVENT_ITERATION_CHANGED,
      ADO_EVENT_TAGGED,
      ADO_EVENT_UPDATED,
      ADO_PR_EVENT_CREATED,
      ADO_PR_EVENT_UPDATED,
    ],
    applyConfig,
  };

  return {
    module,
    producerId: ADO_PRODUCER_ID,
    pullRequestProducerId: ADO_PR_PRODUCER_ID,
    getStatus: () => ({ ...status }),
    getPullRequestStatus: () => pullRequests.getStatus(),
  };
}

/**
 * The Azure DevOps pull-request poller — a second producer, registered under the
 * id `ado.pullrequest`, that on each `tick()` lists the project's ACTIVE pull
 * requests, optionally narrows them to a configured set of watched creators, and
 * DIFFS them against an in-memory snapshot to emit generic events.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) this file learns nothing about
 * what a pull request *means*. It emits `ado.pullrequest.created` for a
 * newly-seen PR, `ado.pullrequest.updated` when a known PR's status or draft
 * flag changes, `ado.pullrequest.pushed` per new iteration, `.comment.created`
 * per new thread comment, `.thread.status_changed`, `.vote` per reviewer vote
 * change, and `.completed` / `.abandoned` when a PR leaves the active list;
 * those event `type` strings are the only place a domain word ever appears. The
 * event payload carries `repo_remote_url` (+ its scheme-stripped
 * `repo_remote_url_hostpath` for authenticated clones) and `source_branch`,
 * which together are enough for a playbook to clone the exact branch under review.
 *
 * SNAPSHOT & SEEDING. The snapshot holds, per PR, the status, draft flag,
 * source commit, last iteration id, each thread's status and last comment id,
 * and each reviewer's vote. The FIRST tick after
 * start — and the first tick after any config change — SEEDS SILENTLY: it
 * populates the snapshot and emits nothing, so a restart (or a re-configure)
 * never replays every open PR as a flood of "created" events. Only subsequent
 * ticks diff and emit.
 *
 * READ-ONLY. Every ADO call this producer makes is a read (see {@link
 * import("./client").ADOClient}); it never PATCHes or POSTs to ADO. All output is
 * recorded locally as events.
 */

import type { NewEvent } from "../../interfaces";
import { log, type Logger } from "../../log";
import { emitEvent } from "../../services/eventIntake";
import type { Trigger, TriggerScheduler } from "../../services/triggerScheduler";
import type { Producer } from "../registry";

import {
  ADOClient,
  type ADOClientOptions,
  type ADOIdentityRef,
  type ADOIterationChange,
  type ADOPullRequest,
  type ADOPullRequestIteration,
  type ADOPullRequestThread,
  type ADORepositoryRef,
} from "./client";
import {
  ADO_DEFAULT_INTERVAL_SECONDS,
  ADO_EVENT_SOURCE,
  type AdoProducerStatus,
  type EmitFn,
  type SecretResolver,
} from "./poller";

/** The stable producer id for the pull-request producer, as required by the task. */
export const ADO_PR_PRODUCER_ID = "ado.pullrequest";

/** The `subject_kind` stamped on every event this producer emits. */
export const ADO_PR_SUBJECT_KIND = "pull_request";

/** Event `type` strings — the sole place a domain word is allowed to appear. */
export const ADO_PR_EVENT_CREATED = "ado.pullrequest.created";
export const ADO_PR_EVENT_UPDATED = "ado.pullrequest.updated";
export const ADO_PR_EVENT_PUSHED = "ado.pullrequest.pushed";
export const ADO_PR_EVENT_COMMENT_CREATED = "ado.pullrequest.comment.created";
export const ADO_PR_EVENT_THREAD_STATUS_CHANGED =
  "ado.pullrequest.thread.status_changed";
export const ADO_PR_EVENT_VOTE = "ado.pullrequest.vote";
export const ADO_PR_EVENT_COMPLETED = "ado.pullrequest.completed";
export const ADO_PR_EVENT_ABANDONED = "ado.pullrequest.abandoned";

/** Statuses that end a pull request; mapped to their own event types. */
const TERMINAL_EVENT_BY_STATUS: Record<string, string> = {
  completed: ADO_PR_EVENT_COMPLETED,
  abandoned: ADO_PR_EVENT_ABANDONED,
};

/** Human labels for ADO's numeric reviewer votes. */
const VOTE_LABELS: Record<number, string> = {
  10: "approved",
  5: "approved_with_suggestions",
  0: "no_vote",
  [-5]: "waiting_for_author",
  [-10]: "rejected",
};

/** Comment types ADO generates itself; not emitted as comment events. */
const GENERATED_COMMENT_TYPES = new Set(["system", "codeChange"]);

/** Prefix stripped from a full ref name to yield a bare branch name. */
const REFS_HEADS_PREFIX = "refs/heads/";

/**
 * The additive pull-request config, nested under `pull_requests` in the `ado`
 * module config. Every field is optional so a half-filled config never throws.
 */
export interface PullRequestsConfig {
  /** Master switch: only an enabled sub-producer arms an interval trigger. */
  enabled?: boolean;
  /** Poll cadence in seconds; falls back to the module default. */
  interval_seconds?: number;
  /**
   * Watched creator identities (uniqueName or displayName). A PR is considered
   * only if its `createdBy` matches one of these; an empty/absent list = any.
   */
  creators?: string[];
}

/**
 * The connection + pull-request config this producer reads. A structural subset
 * of the module's `AdoModuleConfig`, declared here so this file never imports the
 * work-item config type (keeping the two producers decoupled).
 */
export interface AdoPrConnectionConfig {
  org?: string;
  project?: string;
  pat_secret_ref?: string;
  base_url?: string;
  pull_requests?: PullRequestsConfig;
}

/** The read-only ADO surface this producer uses; {@link ADOClient} satisfies it. */
export interface AdoPrReadClient {
  listPullRequests(): Promise<ADOPullRequest[]>;
  getRepository(repositoryId: string): Promise<ADORepositoryRef>;
  getPullRequest(repositoryId: string, pullRequestId: number): Promise<ADOPullRequest>;
  listPullRequestIterations(
    repositoryId: string,
    pullRequestId: number
  ): Promise<ADOPullRequestIteration[]>;
  listIterationChanges(
    repositoryId: string,
    pullRequestId: number,
    iterationId: number
  ): Promise<ADOIterationChange[]>;
  listPullRequestThreads(
    repositoryId: string,
    pullRequestId: number
  ): Promise<ADOPullRequestThread[]>;
}

/** Builds a read client from resolved connection options; injectable for tests. */
export type AdoPrClientFactory = (opts: ADOClientOptions) => AdoPrReadClient;

/** Injected collaborators for {@link createPullRequestProducer}. */
export interface PullRequestProducerDeps {
  /** Scheduler the producer re-arms whenever its config changes. */
  scheduler: TriggerScheduler;
  /** Resolves the PAT from its `pat_secret_ref`. Required. */
  resolveSecret: SecretResolver;
  /** Emits diffed events; defaults to the real {@link emitEvent} on the app db. */
  emit?: EmitFn;
  /** Builds the ADO read client; defaults to constructing an {@link ADOClient}. */
  clientFactory?: AdoPrClientFactory;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  clock?: () => number;
}

/** A constructed pull-request producer plus the handles the module wires in. */
export interface PullRequestProducer {
  producer: Producer;
  /** Re-derive the trigger and reset the snapshot; call from the module's applyConfig. */
  applyConfig(config: AdoPrConnectionConfig | undefined): void;
  /** A snapshot copy of the current producer status. */
  getStatus(): AdoProducerStatus;
}

/** Per-thread facets the poller diffs. */
interface ThreadSnapshot {
  status: string;
  lastCommentId: number;
}

/** The facets of a PR the poller diffs. */
interface PrSnapshot {
  status: string;
  isDraft: boolean;
  repositoryId: string;
  sourceCommit: string;
  lastIterationId: number;
  threads: Map<number, ThreadSnapshot>;
  votes: Map<string, number>;
}

/** Key a reviewer by its identity id, falling back to the unique name. */
function reviewerKey(r: { id: string; uniqueName: string }): string {
  return r.id !== "" ? r.id : r.uniqueName;
}

/** Label for a numeric vote; unknown values stringify. */
function voteLabel(vote: number): string {
  return VOTE_LABELS[vote] ?? String(vote);
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip the `refs/heads/` prefix so a full ref name becomes a bare branch. */
function normalizeBranch(ref: string): string {
  return ref.startsWith(REFS_HEADS_PREFIX)
    ? ref.slice(REFS_HEADS_PREFIX.length)
    : ref;
}

/**
 * Reduce a clone URL to its bare `host/path`, dropping the scheme and any
 * embedded `user[:pass]@` userinfo. Emitted alongside the full `repo_remote_url`
 * so a playbook can compose an authenticated clone URL by prefixing its own
 * credentials — `https://<creds>@<repo_remote_url_hostpath>` — without the
 * template engine needing to strip a scheme it has no transform for.
 */
function toHostPath(remoteUrl: string): string {
  if (remoteUrl === "") return "";
  const withoutScheme = remoteUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const at = withoutScheme.indexOf("@");
  const firstSlash = withoutScheme.indexOf("/");
  // Only an '@' that precedes the first path separator is userinfo; a later '@'
  // belongs to the path and is left untouched.
  if (at !== -1 && (firstSlash === -1 || at < firstSlash)) {
    return withoutScheme.slice(at + 1);
  }
  return withoutScheme;
}

/** Reduce a `createdBy` value to `{ uniqueName, displayName }`. */
function createdByPayload(
  raw: ADOIdentityRef | string
): { uniqueName: string; displayName: string } {
  if (typeof raw === "string") {
    return { uniqueName: raw, displayName: raw };
  }
  return {
    uniqueName: raw.uniqueName ?? "",
    displayName: raw.displayName ?? "",
  };
}

/**
 * Build the event base payload for one pull request, given its resolved HTTPS
 * clone URL. This is the SINGLE definition: the poller uses it for every event
 * type it emits, and the on-demand materialize path calls it too so the
 * manually-materialized event is byte-for-byte the shape a first-seen poll would
 * emit. Keep additions synchronized across both call sites by editing here only.
 */
export function buildPullRequestPayload(
  pr: ADOPullRequest,
  remoteUrl: string
): Record<string, unknown> {
  return {
    id: pr.pullRequestId,
    title: pr.title,
    repository: pr.repository.name ?? "",
    repo_remote_url: remoteUrl,
    repo_remote_url_hostpath: toHostPath(remoteUrl),
    source_branch: normalizeBranch(pr.sourceRefName),
    target_branch: normalizeBranch(pr.targetRefName),
    created_by: createdByPayload(pr.createdBy),
    status: pr.status,
    is_draft: pr.isDraft,
    url: pr.url,
  };
}

/**
 * True when a PR passes the watched-creator filter. An empty/absent `creators`
 * list matches any PR; otherwise the PR's `createdBy` uniqueName OR displayName
 * must appear in the list.
 */
function matchesCreator(pr: ADOPullRequest, creators: string[]): boolean {
  if (creators.length === 0) return true;
  const by = pr.createdBy;
  const uniqueName = typeof by === "string" ? by : by.uniqueName ?? "";
  const displayName = typeof by === "string" ? "" : by.displayName ?? "";
  return (
    (uniqueName !== "" && creators.includes(uniqueName)) ||
    (displayName !== "" && creators.includes(displayName))
  );
}

/** Derive the producer trigger from config: enabled + org + project → interval. */
function triggerFromConfig(cfg: AdoPrConnectionConfig): Trigger {
  const prCfg = cfg.pull_requests;
  if (prCfg?.enabled && cfg.org && cfg.project) {
    const seconds =
      typeof prCfg.interval_seconds === "number" && prCfg.interval_seconds > 0
        ? prCfg.interval_seconds
        : ADO_DEFAULT_INTERVAL_SECONDS;
    return { kind: "interval", seconds };
  }
  return { kind: "manual" };
}

/**
 * Build the ADO pull-request poller producer. The owning module registers the
 * returned `producer` and forwards every config write to {@link
 * PullRequestProducer.applyConfig}, which re-derives the trigger AND resets the
 * snapshot so the next tick reseeds silently.
 */
export function createPullRequestProducer(
  deps: PullRequestProducerDeps
): PullRequestProducer {
  const { scheduler, resolveSecret } = deps;
  const emit: EmitFn = deps.emit ?? ((event) => emitEvent(event));
  const clientFactory: AdoPrClientFactory =
    deps.clientFactory ?? ((opts) => new ADOClient(opts));
  const logger = (deps.logger ?? log).child({ component: "adoPrPoller" });
  const clock = deps.clock ?? Date.now;

  const snapshot = new Map<number, PrSnapshot>();
  let currentConfig: AdoPrConnectionConfig | undefined;
  let seeded = false;

  const status: AdoProducerStatus = {
    running: false,
    last_tick_at: null,
    seeded_count: 0,
    last_error: null,
  };

  /**
   * Resolve a PR's HTTPS clone URL. Prefer the `remoteUrl` embedded in the list
   * response's repository object; fall back to a per-repo lookup (cached within a
   * tick) when the list omits it, so `repo_remote_url` is always clone-ready.
   */
  async function resolveRemoteUrl(
    pr: ADOPullRequest,
    client: AdoPrReadClient,
    cache: Map<string, string>
  ): Promise<string> {
    const repo = pr.repository;
    if (repo.remoteUrl) return repo.remoteUrl;
    const id = repo.id;
    if (!id) return "";
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const resolved = await client.getRepository(id);
    const url = resolved.remoteUrl ?? "";
    cache.set(id, url);
    return url;
  }

  /**
   * Read a PR's current iterations and threads into a fresh snapshot entry.
   * Used when seeding and when a PR is first seen, so pre-existing pushes and
   * comments are recorded without being emitted.
   */
  async function captureState(
    pr: ADOPullRequest,
    client: AdoPrReadClient
  ): Promise<PrSnapshot> {
    const repositoryId = pr.repository.id ?? "";
    const entry: PrSnapshot = {
      status: pr.status,
      isDraft: pr.isDraft,
      repositoryId,
      sourceCommit: pr.sourceCommit,
      lastIterationId: 0,
      threads: new Map(),
      votes: new Map(pr.reviewers.map((r) => [reviewerKey(r), r.vote])),
    };
    if (repositoryId === "") return entry;
    const iterations = await client.listPullRequestIterations(repositoryId, pr.pullRequestId);
    for (const it of iterations) {
      if (it.id > entry.lastIterationId) entry.lastIterationId = it.id;
    }
    const threads = await client.listPullRequestThreads(repositoryId, pr.pullRequestId);
    for (const t of threads) {
      entry.threads.set(t.id, {
        status: t.status,
        lastCommentId: Math.max(0, ...t.comments.map((c) => c.id)),
      });
    }
    return entry;
  }

  /** Common payload fields plus the PR's clone URL, for the secondary events. */
  async function basePayload(
    pr: ADOPullRequest,
    client: AdoPrReadClient,
    cache: Map<string, string>
  ): Promise<Record<string, unknown>> {
    return buildPullRequestPayload(pr, await resolveRemoteUrl(pr, client, cache));
  }

  /** Emit one `pushed` event per iteration newer than the snapshot's. */
  async function diffPushes(
    pr: ADOPullRequest,
    prev: PrSnapshot,
    client: AdoPrReadClient,
    cache: Map<string, string>
  ): Promise<void> {
    if (prev.repositoryId === "" || prev.sourceCommit === pr.sourceCommit) return;
    const iterations = await client.listPullRequestIterations(
      prev.repositoryId,
      pr.pullRequestId
    );
    let previousCommit = prev.sourceCommit;
    for (const it of iterations) {
      if (it.id <= prev.lastIterationId) {
        previousCommit = it.sourceCommit;
        continue;
      }
      const changes = await client.listIterationChanges(
        prev.repositoryId,
        pr.pullRequestId,
        it.id
      );
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_PR_EVENT_PUSHED,
        subject_kind: ADO_PR_SUBJECT_KIND,
        subject_ref: String(pr.pullRequestId),
        payload: {
          ...(await basePayload(pr, client, cache)),
          iteration_id: it.id,
          source_commit: it.sourceCommit,
          previous_source_commit: previousCommit,
          changed_files: changes.map((c) => ({ path: c.path, change_type: c.changeType })),
        },
        dedupe_key: `${ADO_PR_EVENT_PUSHED}:${pr.pullRequestId}:${it.id}`,
      });
      previousCommit = it.sourceCommit;
      prev.lastIterationId = it.id;
    }
    prev.sourceCommit = pr.sourceCommit;
  }

  /** Emit comment and thread-status events for anything new since the snapshot. */
  async function diffThreads(
    pr: ADOPullRequest,
    prev: PrSnapshot,
    client: AdoPrReadClient,
    cache: Map<string, string>
  ): Promise<void> {
    if (prev.repositoryId === "") return;
    const threads = await client.listPullRequestThreads(prev.repositoryId, pr.pullRequestId);
    for (const t of threads) {
      if (t.isDeleted) continue;
      const known = prev.threads.get(t.id);
      const lastSeen = known?.lastCommentId ?? 0;
      let maxId = lastSeen;
      const fresh = t.comments
        .filter((c) => c.id > lastSeen && !c.isDeleted && !GENERATED_COMMENT_TYPES.has(c.commentType))
        .sort((a, b) => a.id - b.id);
      for (const c of fresh) {
        await emit({
          source: ADO_EVENT_SOURCE,
          type: ADO_PR_EVENT_COMMENT_CREATED,
          subject_kind: ADO_PR_SUBJECT_KIND,
          subject_ref: String(pr.pullRequestId),
          payload: {
            ...(await basePayload(pr, client, cache)),
            thread_id: t.id,
            comment_id: c.id,
            parent_comment_id: c.parentCommentId,
            author: createdByPayload(c.author),
            content: c.content,
            file_path: t.filePath,
            line: t.line,
            thread_status: t.status,
            published_at: c.publishedDate,
          },
          dedupe_key: `${ADO_PR_EVENT_COMMENT_CREATED}:${pr.pullRequestId}:${t.id}:${c.id}`,
        });
      }
      for (const c of t.comments) if (c.id > maxId) maxId = c.id;
      if (known && known.status !== t.status) {
        await emit({
          source: ADO_EVENT_SOURCE,
          type: ADO_PR_EVENT_THREAD_STATUS_CHANGED,
          subject_kind: ADO_PR_SUBJECT_KIND,
          subject_ref: String(pr.pullRequestId),
          payload: {
            ...(await basePayload(pr, client, cache)),
            thread_id: t.id,
            status: t.status,
            previous_status: known.status,
            file_path: t.filePath,
            line: t.line,
          },
          dedupe_key: `${ADO_PR_EVENT_THREAD_STATUS_CHANGED}:${pr.pullRequestId}:${t.id}:${t.status}`,
        });
      }
      prev.threads.set(t.id, { status: t.status, lastCommentId: maxId });
    }
  }

  /** Emit a `vote` event for every reviewer whose vote changed. */
  async function diffVotes(
    pr: ADOPullRequest,
    prev: PrSnapshot,
    client: AdoPrReadClient,
    cache: Map<string, string>
  ): Promise<void> {
    for (const r of pr.reviewers) {
      const key = reviewerKey(r);
      const before = prev.votes.get(key) ?? 0;
      if (before === r.vote) {
        prev.votes.set(key, r.vote);
        continue;
      }
      await emit({
        source: ADO_EVENT_SOURCE,
        type: ADO_PR_EVENT_VOTE,
        subject_kind: ADO_PR_SUBJECT_KIND,
        subject_ref: String(pr.pullRequestId),
        payload: {
          ...(await basePayload(pr, client, cache)),
          reviewer: { uniqueName: r.uniqueName, displayName: r.displayName },
          vote: r.vote,
          vote_label: voteLabel(r.vote),
          previous_vote: before,
          previous_vote_label: voteLabel(before),
          is_required: r.isRequired,
        },
        dedupe_key: `${ADO_PR_EVENT_VOTE}:${pr.pullRequestId}:${key}:${r.vote}`,
      });
      prev.votes.set(key, r.vote);
    }
  }

  /**
   * A snapshot PR missing from the active list: read it once to learn whether it
   * completed or was abandoned, emit that, and forget it. Anything else (still
   * active but filtered out, or unreadable) is dropped silently.
   */
  async function diffVanished(
    id: number,
    prev: PrSnapshot,
    client: AdoPrReadClient,
    cache: Map<string, string>
  ): Promise<void> {
    snapshot.delete(id);
    if (prev.repositoryId === "") return;
    let pr: ADOPullRequest;
    try {
      pr = await client.getPullRequest(prev.repositoryId, id);
    } catch (err) {
      logger.warn("could not read a pull request that left the active list", {
        pullRequestId: id,
        error: errorMessage(err),
      });
      return;
    }
    const type = TERMINAL_EVENT_BY_STATUS[pr.status];
    if (!type) return;
    await emit({
      source: ADO_EVENT_SOURCE,
      type,
      subject_kind: ADO_PR_SUBJECT_KIND,
      subject_ref: String(id),
      payload: {
        ...(await basePayload(pr, client, cache)),
        previous_status: prev.status,
      },
      dedupe_key: `${type}:${id}`,
    });
  }

  /** Run one poll: list, filter, then either seed silently or diff-and-emit. */
  async function tick(): Promise<void> {
    status.running = true;
    status.last_tick_at = clock();
    try {
      const cfg = currentConfig;
      const prCfg = cfg?.pull_requests;
      if (!cfg || !prCfg?.enabled || !cfg.org || !cfg.project) {
        // Nothing to poll (disabled or under-configured): a clean no-op.
        status.last_error = null;
        return;
      }

      const pat = await resolveSecret(cfg.pat_secret_ref ?? "");
      if (!pat) {
        throw new Error(
          `ADO PAT secret unavailable for ref "${cfg.pat_secret_ref ?? ""}"`
        );
      }

      const client = clientFactory({
        org: cfg.org,
        project: cfg.project,
        pat,
        baseUrl: cfg.base_url,
      });
      const creators = prCfg.creators ?? [];
      const prs = (await client.listPullRequests()).filter((pr) =>
        matchesCreator(pr, creators)
      );

      if (!seeded) {
        snapshot.clear();
        for (const pr of prs) {
          snapshot.set(pr.pullRequestId, await captureState(pr, client));
        }
        seeded = true;
        status.seeded_count = snapshot.size;
        status.last_error = null;
        logger.info("seeded pull-request snapshot silently", {
          count: snapshot.size,
        });
        return;
      }

      const repoUrlCache = new Map<string, string>();
      const seen = new Set<number>();
      for (const pr of prs) {
        seen.add(pr.pullRequestId);
        const prev = snapshot.get(pr.pullRequestId);
        if (!prev) {
          const remoteUrl = await resolveRemoteUrl(pr, client, repoUrlCache);
          await emit({
            source: ADO_EVENT_SOURCE,
            type: ADO_PR_EVENT_CREATED,
            subject_kind: ADO_PR_SUBJECT_KIND,
            subject_ref: String(pr.pullRequestId),
            payload: buildPullRequestPayload(pr, remoteUrl),
            dedupe_key: `${ADO_PR_EVENT_CREATED}:${pr.pullRequestId}`,
          });
          snapshot.set(pr.pullRequestId, await captureState(pr, client));
          continue;
        }
        if (prev.status !== pr.status || prev.isDraft !== pr.isDraft) {
          const remoteUrl = await resolveRemoteUrl(pr, client, repoUrlCache);
          await emit({
            source: ADO_EVENT_SOURCE,
            type: ADO_PR_EVENT_UPDATED,
            subject_kind: ADO_PR_SUBJECT_KIND,
            subject_ref: String(pr.pullRequestId),
            payload: {
              ...buildPullRequestPayload(pr, remoteUrl),
              previous_status: prev.status,
              previous_is_draft: prev.isDraft,
            },
            dedupe_key: `${ADO_PR_EVENT_UPDATED}:${pr.pullRequestId}:${pr.status}:${pr.isDraft ? "draft" : "ready"}`,
          });
          prev.status = pr.status;
          prev.isDraft = pr.isDraft;
        }
        await diffPushes(pr, prev, client, repoUrlCache);
        await diffThreads(pr, prev, client, repoUrlCache);
        await diffVotes(pr, prev, client, repoUrlCache);
      }
      for (const [id, prev] of [...snapshot.entries()]) {
        if (!seen.has(id)) await diffVanished(id, prev, client, repoUrlCache);
      }
      status.seeded_count = snapshot.size;
      status.last_error = null;
    } catch (err) {
      status.last_error = errorMessage(err);
      logger.error("ado pull-request poll tick failed", {
        error: status.last_error,
      });
    } finally {
      status.running = false;
    }
  }

  /**
   * Re-derive the trigger and RESET the snapshot on every config change, so the
   * very next tick reseeds silently rather than replaying every open PR.
   */
  function applyConfig(config: AdoPrConnectionConfig | undefined): void {
    currentConfig = config ?? {};
    snapshot.clear();
    seeded = false;
    status.seeded_count = 0;
    scheduler.applyTrigger(ADO_PR_PRODUCER_ID, triggerFromConfig(currentConfig));
  }

  const producer: Producer = {
    id: ADO_PR_PRODUCER_ID,
    tick,
    defaultTrigger: { kind: "manual" },
  };

  return {
    producer,
    applyConfig,
    getStatus: () => ({ ...status }),
  };
}

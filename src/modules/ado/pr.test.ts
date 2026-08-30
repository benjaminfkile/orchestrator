import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../../db/db";
import { runMigrations } from "../../db/migrate";
import type { NewEvent } from "../../interfaces";
import { createLogger } from "../../log";
import { emitEvent } from "../../services/eventIntake";
import { TriggerScheduler } from "../../services/triggerScheduler";

import type {
  ADOIdentityRef,
  ADOIterationChange,
  ADOPullRequest,
  ADOPullRequestIteration,
  ADOPullRequestThread,
  ADORepositoryRef,
  ADOReviewer,
} from "./client";
import {
  createAdoModule,
  type AdoModuleConfig,
} from "./poller";
import {
  ADO_PR_EVENT_ABANDONED,
  ADO_PR_EVENT_COMMENT_CREATED,
  ADO_PR_EVENT_COMPLETED,
  ADO_PR_EVENT_CREATED,
  ADO_PR_EVENT_PUSHED,
  ADO_PR_EVENT_THREAD_STATUS_CHANGED,
  ADO_PR_EVENT_VOTE,
  ADO_PR_EVENT_UPDATED,
  ADO_PR_PRODUCER_ID,
  ADO_PR_SUBJECT_KIND,
} from "./pr";

/** Build a raw pull request; only the fields the producer reads are populated. */
function pr(
  id: number,
  fields: {
    title?: string;
    status?: string;
    isDraft?: boolean;
    sourceCommit?: string;
    reviewers?: ADOReviewer[];
    source?: string;
    target?: string;
    createdBy?: ADOIdentityRef | string;
    repoName?: string;
    repoId?: string;
    remoteUrl?: string | undefined;
    url?: string;
  } = {}
): ADOPullRequest {
  const repository: ADORepositoryRef = {
    id: fields.repoId ?? "repo-1",
    name: fields.repoName ?? "web",
    webUrl: "https://dev.azure.com/o/p/_git/web",
  };
  if ("remoteUrl" in fields) {
    repository.remoteUrl = fields.remoteUrl;
  } else {
    repository.remoteUrl = "https://dev.azure.com/o/p/_git/web";
  }
  return {
    pullRequestId: id,
    title: fields.title ?? `pr ${id}`,
    status: fields.status ?? "active",
    isDraft: fields.isDraft ?? false,
    sourceCommit: fields.sourceCommit ?? "c0",
    reviewers: fields.reviewers ?? [],
    sourceRefName: fields.source ?? "refs/heads/feature/x",
    targetRefName: fields.target ?? "refs/heads/main",
    createdBy: fields.createdBy ?? { uniqueName: "ada@x.com", displayName: "Ada" },
    repository,
    url: fields.url ?? `https://dev.azure.com/o/p/_apis/git/pullRequests/${id}`,
  };
}

/** A mutable fake ADO PR read client backed by an in-memory list. */
class FakePrClient {
  board: ADOPullRequest[] = [];
  /** PRs readable by id even when not active (completed/abandoned). */
  archive: ADOPullRequest[] = [];
  repos = new Map<string, ADORepositoryRef>();
  iterations = new Map<number, ADOPullRequestIteration[]>();
  changes = new Map<string, ADOIterationChange[]>();
  threads = new Map<number, ADOPullRequestThread[]>();
  getRepositoryCalls: string[] = [];

  async listPullRequests(): Promise<ADOPullRequest[]> {
    return this.board;
  }
  async getRepository(repositoryId: string): Promise<ADORepositoryRef> {
    this.getRepositoryCalls.push(repositoryId);
    return this.repos.get(repositoryId) ?? {};
  }
  async getPullRequest(_repositoryId: string, pullRequestId: number): Promise<ADOPullRequest> {
    const found = [...this.board, ...this.archive].find((p) => p.pullRequestId === pullRequestId);
    if (!found) throw new Error("not found");
    return found;
  }
  async listPullRequestIterations(_r: string, pullRequestId: number): Promise<ADOPullRequestIteration[]> {
    return this.iterations.get(pullRequestId) ?? [];
  }
  async listIterationChanges(_r: string, pullRequestId: number, iterationId: number): Promise<ADOIterationChange[]> {
    return this.changes.get(`${pullRequestId}:${iterationId}`) ?? [];
  }
  async listPullRequestThreads(_r: string, pullRequestId: number): Promise<ADOPullRequestThread[]> {
    return this.threads.get(pullRequestId) ?? [];
  }
}

const BASE_CONFIG: AdoModuleConfig = {
  org: "o",
  project: "p",
  pat_secret_ref: "ado_pat",
  enabled: true,
  interval_seconds: 30,
  watched: { assignee_mode: "any" },
  pull_requests: { enabled: true, interval_seconds: 30 },
};

/** Schedulers created by {@link setup}, stopped after each test so no timer leaks. */
const activeSchedulers: TriggerScheduler[] = [];

afterEach(() => {
  while (activeSchedulers.length) activeSchedulers.pop()!.stop();
});

/** Wire a module against a capturing emit and a fake PR client, ready to tick. */
function setup(config: AdoModuleConfig = BASE_CONFIG) {
  const emitted: NewEvent[] = [];
  const client = new FakePrClient();
  const scheduler = new TriggerScheduler({
    resolveTick: () => undefined,
    logger: createLogger({ sink: () => {} }),
  });
  activeSchedulers.push(scheduler);

  const mod = createAdoModule({
    scheduler,
    resolveSecret: async () => "the-pat",
    emit: async (event) => {
      emitted.push(event);
    },
    pullRequestClientFactory: () => client,
    logger: createLogger({ sink: () => {} }),
  });

  const producer = mod.module.producers!.find(
    (p) => p.id === ADO_PR_PRODUCER_ID
  )!;
  const tick = () => producer.tick();
  mod.module.applyConfig!(config);

  return { emitted, client, scheduler, mod, tick };
}

/** Events emitted of a given type. */
function ofType(emitted: NewEvent[], type: string): NewEvent[] {
  return emitted.filter((e) => e.type === type);
}

describe("ado pull-request producer", () => {
  it("registers a producer with the required id", () => {
    const { mod } = setup();
    expect(mod.pullRequestProducerId).toBe(ADO_PR_PRODUCER_ID);
    expect(
      mod.module.producers!.some((p) => p.id === ADO_PR_PRODUCER_ID)
    ).toBe(true);
  });

  describe("silent seeding", () => {
    it("emits nothing on the first tick and records the seeded count", async () => {
      const { emitted, client, mod, tick } = setup();
      client.board = [pr(1), pr(2), pr(3)];

      await tick();

      expect(emitted).toHaveLength(0);
      const status = mod.getPullRequestStatus();
      expect(status.seeded_count).toBe(3);
      expect(status.last_error).toBeNull();
      expect(status.last_tick_at).not.toBeNull();
      expect(status.running).toBe(false);
    });

    it("does not treat already-seeded PRs as created on the next tick", async () => {
      const { emitted, client, tick } = setup();
      client.board = [pr(1)];
      await tick(); // seed
      await tick(); // no changes
      expect(emitted).toHaveLength(0);
    });

    it("a failed first tick does not count as seeded; the next tick reseeds", async () => {
      const emitted: NewEvent[] = [];
      const client = new FakePrClient();
      const scheduler = new TriggerScheduler({
        resolveTick: () => undefined,
        logger: createLogger({ sink: () => {} }),
      });
      activeSchedulers.push(scheduler);
      let pat: string | undefined = undefined;
      const mod = createAdoModule({
        scheduler,
        resolveSecret: async () => pat,
        emit: async (e) => {
          emitted.push(e);
        },
        pullRequestClientFactory: () => client,
        logger: createLogger({ sink: () => {} }),
      });
      mod.module.applyConfig!(BASE_CONFIG);
      const producer = mod.module.producers!.find(
        (p) => p.id === ADO_PR_PRODUCER_ID
      )!;
      client.board = [pr(1)];

      await producer.tick();
      expect(mod.getPullRequestStatus().last_error).toMatch(
        /PAT secret unavailable/
      );
      expect(mod.getPullRequestStatus().seeded_count).toBe(0);

      pat = "the-pat";
      await producer.tick();
      expect(emitted).toHaveLength(0);
      expect(mod.getPullRequestStatus().seeded_count).toBe(1);
      expect(mod.getPullRequestStatus().last_error).toBeNull();
    });
  });

  describe("new PRs", () => {
    it("emits created with a clone-able payload for a brand-new PR", async () => {
      const { emitted, client, tick } = setup();
      client.board = [];
      await tick(); // seed empty

      client.board = [
        pr(7, {
          title: "Fix bug",
          source: "refs/heads/feature/fix",
          target: "refs/heads/develop",
          repoName: "svc",
          remoteUrl: "https://dev.azure.com/o/p/_git/svc",
          createdBy: { uniqueName: "bob@x.com", displayName: "Bob" },
        }),
      ];
      await tick();

      const created = ofType(emitted, ADO_PR_EVENT_CREATED);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        source: "ado",
        subject_kind: ADO_PR_SUBJECT_KIND,
        subject_ref: "7",
        dedupe_key: `${ADO_PR_EVENT_CREATED}:7`,
      });
      expect(created[0].payload).toEqual({
        id: 7,
        title: "Fix bug",
        repository: "svc",
        repo_remote_url: "https://dev.azure.com/o/p/_git/svc",
        repo_remote_url_hostpath: "dev.azure.com/o/p/_git/svc",
        source_branch: "feature/fix",
        target_branch: "develop",
        created_by: { uniqueName: "bob@x.com", displayName: "Bob" },
        status: "active",
        is_draft: false,
        url: expect.any(String),
      });
    });

    it("strips scheme and embedded userinfo for the clone-ready hostpath", async () => {
      const { emitted, client, tick } = setup();
      client.board = [];
      await tick();

      client.board = [
        pr(8, { remoteUrl: "https://org@dev.azure.com/org/proj/_git/repo" }),
      ];
      await tick();

      const created = ofType(emitted, ADO_PR_EVENT_CREATED);
      expect(
        (created[0].payload as { repo_remote_url_hostpath: string })
          .repo_remote_url_hostpath
      ).toBe("dev.azure.com/org/proj/_git/repo");
    });

    it("resolves the clone URL via getRepository when the list omits remoteUrl", async () => {
      const { emitted, client, tick } = setup();
      client.board = [];
      await tick();

      client.repos.set("repo-9", {
        id: "repo-9",
        name: "svc",
        remoteUrl: "https://dev.azure.com/o/p/_git/svc",
      });
      client.board = [pr(3, { repoId: "repo-9", remoteUrl: undefined })];
      await tick();

      const created = ofType(emitted, ADO_PR_EVENT_CREATED);
      expect(created).toHaveLength(1);
      expect(
        (created[0].payload as { repo_remote_url: string }).repo_remote_url
      ).toBe("https://dev.azure.com/o/p/_git/svc");
      expect(client.getRepositoryCalls).toEqual(["repo-9"]);
    });
  });

  describe("watched-creator filter", () => {
    it("ignores PRs whose creator is not in the watched list", async () => {
      const { emitted, client, mod, tick } = setup({
        ...BASE_CONFIG,
        pull_requests: {
          enabled: true,
          interval_seconds: 30,
          creators: ["ada@x.com"],
        },
      });
      // Seed empty.
      client.board = [];
      await tick();

      client.board = [
        pr(1, { createdBy: { uniqueName: "ada@x.com", displayName: "Ada" } }),
        pr(2, { createdBy: { uniqueName: "eve@x.com", displayName: "Eve" } }),
      ];
      await tick();

      const created = ofType(emitted, ADO_PR_EVENT_CREATED);
      expect(created.map((e) => e.subject_ref)).toEqual(["1"]);
      // The un-watched PR never even enters the snapshot.
      expect(mod.getPullRequestStatus().seeded_count).toBe(1);
    });

    it("matches a watched creator by displayName too", async () => {
      const { emitted, client, tick } = setup({
        ...BASE_CONFIG,
        pull_requests: {
          enabled: true,
          interval_seconds: 30,
          creators: ["Ada"],
        },
      });
      client.board = [];
      await tick();
      client.board = [
        pr(1, { createdBy: { uniqueName: "ada@x.com", displayName: "Ada" } }),
      ];
      await tick();
      expect(ofType(emitted, ADO_PR_EVENT_CREATED)).toHaveLength(1);
    });
  });

  describe("status changes", () => {
    it("emits updated with previous_status on a status change", async () => {
      const { emitted, client, tick } = setup();
      client.board = [pr(1, { status: "active" })];
      await tick(); // seed

      client.board = [pr(1, { status: "completed" })];
      await tick();

      const updated = ofType(emitted, ADO_PR_EVENT_UPDATED);
      expect(updated).toHaveLength(1);
      expect(updated[0].dedupe_key).toBe(
        `${ADO_PR_EVENT_UPDATED}:1:completed:ready`
      );
      expect(updated[0].payload).toMatchObject({
        status: "completed",
        previous_status: "active",
      });
    });

    it("emits updated with previous_is_draft when a draft becomes ready", async () => {
      const { emitted, client, tick } = setup();
      client.board = [pr(1, { isDraft: true })];
      await tick(); // seed

      client.board = [pr(1, { isDraft: false })];
      await tick();

      const updated = ofType(emitted, ADO_PR_EVENT_UPDATED);
      expect(updated).toHaveLength(1);
      expect(updated[0].dedupe_key).toBe(
        `${ADO_PR_EVENT_UPDATED}:1:active:ready`
      );
      expect(updated[0].payload).toMatchObject({
        status: "active",
        is_draft: false,
        previous_status: "active",
        previous_is_draft: true,
      });
    });

    it("carries is_draft on created for a draft PR", async () => {
      const { emitted, client, tick } = setup();
      await tick(); // seed empty
      client.board = [pr(2, { isDraft: true })];
      await tick();
      const created = ofType(emitted, ADO_PR_EVENT_CREATED);
      expect(created).toHaveLength(1);
      expect(created[0].payload).toMatchObject({ is_draft: true });
    });

    it("emits nothing when a PR is entirely unchanged", async () => {
      const { emitted, client, tick } = setup();
      client.board = [pr(1, { status: "active" })];
      await tick();
      await tick();
      expect(emitted).toHaveLength(0);
    });
  });

  describe("config change reseeds", () => {
    it("resets the snapshot so the next tick seeds silently again", async () => {
      const { emitted, client, mod, tick } = setup();
      client.board = [pr(1, { status: "active" })];
      await tick(); // seed

      client.board = [pr(1, { status: "completed" })];
      await tick();
      expect(ofType(emitted, ADO_PR_EVENT_UPDATED)).toHaveLength(1);
      emitted.length = 0;

      mod.module.applyConfig!({
        ...BASE_CONFIG,
        pull_requests: { enabled: true, interval_seconds: 45 },
      });
      expect(mod.getPullRequestStatus().seeded_count).toBe(0);

      client.board = [pr(1, { status: "abandoned" })];
      await tick();
      expect(emitted).toHaveLength(0);
      expect(mod.getPullRequestStatus().seeded_count).toBe(1);
    });
  });

  describe("trigger derivation", () => {
    it("enabled + org + project → interval trigger", () => {
      const { scheduler } = setup();
      expect(
        scheduler.getProducerStatus(ADO_PR_PRODUCER_ID)?.trigger
      ).toEqual({ kind: "interval", seconds: 30 });
    });

    it("defaults the interval when interval_seconds is absent", () => {
      const { scheduler } = setup({
        ...BASE_CONFIG,
        pull_requests: { enabled: true },
      });
      expect(
        scheduler.getProducerStatus(ADO_PR_PRODUCER_ID)?.trigger
      ).toEqual({ kind: "interval", seconds: 60 });
    });

    it("disabled pull_requests → manual trigger, and tick is a no-op", async () => {
      const { emitted, client, mod, scheduler, tick } = setup({
        ...BASE_CONFIG,
        pull_requests: { enabled: false },
      });
      expect(
        scheduler.getProducerStatus(ADO_PR_PRODUCER_ID)?.trigger
      ).toEqual({ kind: "manual" });

      client.board = [pr(1)];
      await tick();
      expect(emitted).toHaveLength(0);
      expect(mod.getPullRequestStatus().last_error).toBeNull();
    });

    it("absent pull_requests config → manual trigger", () => {
      const { scheduler } = setup({ ...BASE_CONFIG, pull_requests: undefined });
      expect(
        scheduler.getProducerStatus(ADO_PR_PRODUCER_ID)?.trigger
      ).toEqual({ kind: "manual" });
    });
  });

  describe("read-only surface", () => {
    it("never calls a client method that mutates ADO", async () => {
      const { client, tick } = setup();
      // The fake client only exposes reads; assert the producer touched exactly
      // those. Any write would require a method the injected client does not have.
      client.board = [pr(1)];
      await tick();
      client.board = [pr(1, { status: "completed" })];
      await tick();

      const methods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(client)
      ).filter((n) => n !== "constructor");
      const forbidden = /(create|update|patch|delete|post|put|write|vote|abandon|complete)/i;
      for (const name of methods) {
        expect(name).not.toMatch(forbidden);
      }
    });
  });
});

describe("ado pull-request dedupe (real db + emitEvent)", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-adopr-"));
    file = path.join(dir, "test.sqlite");
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("folds repeated same-key status changes within the cooldown window", async () => {
    const client = new FakePrClient();
    const scheduler = new TriggerScheduler({
      resolveTick: () => undefined,
      logger: createLogger({ sink: () => {} }),
    });
    const mod = createAdoModule({
      scheduler,
      resolveSecret: async () => "the-pat",
      emit: (event) => emitEvent(event, db),
      pullRequestClientFactory: () => client,
      logger: createLogger({ sink: () => {} }),
    });
    mod.module.applyConfig!(BASE_CONFIG);
    const producer = mod.module.producers!.find(
      (p) => p.id === ADO_PR_PRODUCER_ID
    )!;

    // Seed at status active.
    client.board = [pr(1, { status: "active" })];
    await producer.tick();

    // active → completed: emits & inserts updated:1:completed:ready.
    client.board = [pr(1, { status: "completed" })];
    await producer.tick();
    // completed → active: a different key, inserts updated:1:active:ready.
    client.board = [pr(1, { status: "active" })];
    await producer.tick();
    // active → completed again: SAME key as the first change; the cooldown folds it.
    client.board = [pr(1, { status: "completed" })];
    await producer.tick();

    const rows = await db("events")
      .where({ type: ADO_PR_EVENT_UPDATED })
      .orderBy("id", "asc");
    // Three emits, one folded away by the dedupe cooldown → two persisted events.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `${ADO_PR_EVENT_UPDATED}:1:completed:ready`,
      `${ADO_PR_EVENT_UPDATED}:1:active:ready`,
    ]);

    scheduler.stop();
  });
});

describe("ado pull-request activity events", () => {
  function thread(
    id: number,
    status: string,
    comments: Array<{ id: number; parent?: number; type?: string; deleted?: boolean; content?: string }>,
    file = "/src/a.ts",
    line: number | null = 12
  ): ADOPullRequestThread {
    return {
      id,
      status,
      filePath: file,
      line,
      isDeleted: false,
      comments: comments.map((c) => ({
        id: c.id,
        parentCommentId: c.parent ?? null,
        author: { uniqueName: "rev@x.com", displayName: "Rev" },
        content: c.content ?? `comment ${c.id}`,
        commentType: c.type ?? "text",
        isDeleted: c.deleted ?? false,
        publishedDate: "2026-08-30T00:00:00Z",
      })),
    };
  }
  const reviewer = (vote: number, id = "r1"): ADOReviewer => ({
    id,
    uniqueName: "rev@x.com",
    displayName: "Rev",
    vote,
    isRequired: true,
  });

  it("emits one pushed event per new iteration with its changed files", async () => {
    const { emitted, client, tick } = setup();
    client.board = [pr(1, { sourceCommit: "c1" })];
    client.iterations.set(1, [{ id: 1, sourceCommit: "c1" }]);
    await tick(); // seed

    client.board = [pr(1, { sourceCommit: "c3" })];
    client.iterations.set(1, [
      { id: 1, sourceCommit: "c1" },
      { id: 2, sourceCommit: "c2" },
      { id: 3, sourceCommit: "c3" },
    ]);
    client.changes.set("1:2", [{ path: "/src/a.ts", changeType: "edit" }]);
    client.changes.set("1:3", [{ path: "/src/b.ts", changeType: "add" }]);
    await tick();

    const pushed = ofType(emitted, ADO_PR_EVENT_PUSHED);
    expect(pushed).toHaveLength(2);
    expect(pushed[0].dedupe_key).toBe(`${ADO_PR_EVENT_PUSHED}:1:2`);
    expect(pushed[0].payload).toMatchObject({
      id: 1,
      iteration_id: 2,
      source_commit: "c2",
      previous_source_commit: "c1",
      changed_files: [{ path: "/src/a.ts", change_type: "edit" }],
    });
    expect(pushed[1].payload).toMatchObject({
      iteration_id: 3,
      source_commit: "c3",
      previous_source_commit: "c2",
      changed_files: [{ path: "/src/b.ts", change_type: "add" }],
    });

    await tick();
    expect(ofType(emitted, ADO_PR_EVENT_PUSHED)).toHaveLength(2);
  });

  it("records a new PR's existing pushes and comments without emitting them", async () => {
    const { emitted, client, tick } = setup();
    await tick(); // seed empty
    client.board = [pr(4, { sourceCommit: "c9" })];
    client.iterations.set(4, [{ id: 1, sourceCommit: "c9" }]);
    client.threads.set(4, [thread(40, "active", [{ id: 400 }])]);
    await tick();

    expect(ofType(emitted, ADO_PR_EVENT_CREATED)).toHaveLength(1);
    expect(ofType(emitted, ADO_PR_EVENT_PUSHED)).toHaveLength(0);
    expect(ofType(emitted, ADO_PR_EVENT_COMMENT_CREATED)).toHaveLength(0);
  });

  it("emits comment.created for top-level comments and replies, skipping generated comments", async () => {
    const { emitted, client, tick } = setup();
    client.board = [pr(1)];
    client.threads.set(1, [thread(10, "active", [{ id: 100 }])]);
    await tick(); // seed

    client.threads.set(1, [
      thread(10, "active", [
        { id: 100 },
        { id: 101, parent: 100, content: "reply" },
        { id: 102, type: "system" },
      ]),
      thread(11, "active", [{ id: 110, content: "new thread" }], "", null),
    ]);
    await tick();

    const comments = ofType(emitted, ADO_PR_EVENT_COMMENT_CREATED);
    expect(comments).toHaveLength(2);
    expect(comments[0].dedupe_key).toBe(`${ADO_PR_EVENT_COMMENT_CREATED}:1:10:101`);
    expect(comments[0].payload).toMatchObject({
      thread_id: 10,
      comment_id: 101,
      parent_comment_id: 100,
      author: { uniqueName: "rev@x.com", displayName: "Rev" },
      content: "reply",
      file_path: "/src/a.ts",
      line: 12,
      thread_status: "active",
    });
    expect(comments[1].payload).toMatchObject({
      thread_id: 11,
      comment_id: 110,
      parent_comment_id: null,
      file_path: "",
      line: null,
    });

    await tick();
    expect(ofType(emitted, ADO_PR_EVENT_COMMENT_CREATED)).toHaveLength(2);
  });

  it("emits thread.status_changed when a thread is resolved", async () => {
    const { emitted, client, tick } = setup();
    client.board = [pr(1)];
    client.threads.set(1, [thread(10, "active", [{ id: 100 }])]);
    await tick(); // seed

    client.threads.set(1, [thread(10, "fixed", [{ id: 100 }])]);
    await tick();

    const changed = ofType(emitted, ADO_PR_EVENT_THREAD_STATUS_CHANGED);
    expect(changed).toHaveLength(1);
    expect(changed[0].dedupe_key).toBe(`${ADO_PR_EVENT_THREAD_STATUS_CHANGED}:1:10:fixed`);
    expect(changed[0].payload).toMatchObject({
      thread_id: 10,
      status: "fixed",
      previous_status: "active",
      file_path: "/src/a.ts",
    });
  });

  it("emits vote when a reviewer's vote changes, with labels", async () => {
    const { emitted, client, tick } = setup();
    client.board = [pr(1, { reviewers: [reviewer(0)] })];
    await tick(); // seed

    client.board = [pr(1, { reviewers: [reviewer(-5)] })];
    await tick();
    client.board = [pr(1, { reviewers: [reviewer(10), reviewer(5, "r2")] })];
    await tick();

    const votes = ofType(emitted, ADO_PR_EVENT_VOTE);
    expect(votes).toHaveLength(3);
    expect(votes[0].dedupe_key).toBe(`${ADO_PR_EVENT_VOTE}:1:r1:-5`);
    expect(votes[0].payload).toMatchObject({
      reviewer: { uniqueName: "rev@x.com", displayName: "Rev" },
      vote: -5,
      vote_label: "waiting_for_author",
      previous_vote: 0,
      previous_vote_label: "no_vote",
      is_required: true,
    });
    expect(votes[1].payload).toMatchObject({ vote: 10, vote_label: "approved", previous_vote: -5 });
    expect(votes[2].payload).toMatchObject({ vote: 5, vote_label: "approved_with_suggestions", previous_vote: 0 });
  });

  it("emits completed or abandoned when a PR leaves the active list", async () => {
    const { emitted, client, tick } = setup();
    client.board = [pr(1), pr(2)];
    await tick(); // seed

    client.board = [];
    client.archive = [pr(1, { status: "completed" }), pr(2, { status: "abandoned" })];
    await tick();

    const completed = ofType(emitted, ADO_PR_EVENT_COMPLETED);
    const abandoned = ofType(emitted, ADO_PR_EVENT_ABANDONED);
    expect(completed).toHaveLength(1);
    expect(completed[0].dedupe_key).toBe(`${ADO_PR_EVENT_COMPLETED}:1`);
    expect(completed[0].payload).toMatchObject({ id: 1, status: "completed", previous_status: "active" });
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].payload).toMatchObject({ id: 2, status: "abandoned" });

    await tick();
    expect(ofType(emitted, ADO_PR_EVENT_COMPLETED)).toHaveLength(1);
  });

  it("drops a vanished PR silently when it is still active (filtered out) or unreadable", async () => {
    const { emitted, client, tick } = setup();
    client.board = [pr(1), pr(2)];
    await tick(); // seed
    client.board = [];
    client.archive = [pr(1, { status: "active" })];
    await tick();
    expect(emitted).toHaveLength(0);
  });
});

import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";

import { createDb } from "../../db/db";
import { runMigrations } from "../../db/migrate";
import { createPlaybook } from "../../db/playbooks";
import { createRule } from "../../db/rules";
import { setSetting } from "../../db/settings";
import type { NewEvent } from "../../interfaces";
import { createLogger } from "../../log";
import { emitEvent } from "../../services/eventIntake";
import { TriggerScheduler } from "../../services/triggerScheduler";

import type { ADOWorkItem, ADOIdentityRef } from "./client";
import {
  ADO_EVENT_AREA_CHANGED,
  ADO_EVENT_ASSIGNED,
  ADO_EVENT_CREATED,
  ADO_EVENT_ITERATION_CHANGED,
  ADO_EVENT_STATE_CHANGED,
  ADO_EVENT_TAGGED,
  ADO_EVENT_UPDATED,
  ADO_PRODUCER_ID,
  ADO_SUBJECT_KIND,
  createAdoModule,
  type AdoModuleConfig,
} from "./poller";

/** Build a raw work item; only the fields the poller reads are populated. */
function wi(
  id: number,
  fields: {
    title?: string;
    state?: string;
    type?: string;
    assignee?: ADOIdentityRef | string;
    area?: string;
    iteration?: string;
    tags?: string;
    changed?: string;
    url?: string;
  } = {}
): ADOWorkItem {
  return {
    id,
    url: fields.url ?? `https://dev.azure.com/o/p/_apis/wit/workItems/${id}`,
    fields: {
      "System.Title": fields.title ?? `item ${id}`,
      "System.State": fields.state ?? "New",
      "System.WorkItemType": fields.type ?? "Task",
      "System.AssignedTo": fields.assignee,
      "System.AreaPath": fields.area ?? "Proj\\Area",
      "System.IterationPath": fields.iteration ?? "Proj\\Sprint 1",
      "System.Tags": fields.tags,
      "System.ChangedDate": fields.changed ?? "2026-07-13T10:00:00Z",
    },
  };
}

/** A mutable fake ADO read client backed by an in-memory board of items. */
class FakeAdoClient {
  board: ADOWorkItem[] = [];
  async runWiql(): Promise<number[]> {
    return this.board.map((item) => item.id);
  }
  async getWorkItems(ids: number[]): Promise<ADOWorkItem[]> {
    const byId = new Map(this.board.map((item) => [item.id, item]));
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is ADOWorkItem => item !== undefined);
  }
}

const BASE_CONFIG: AdoModuleConfig = {
  org: "o",
  project: "p",
  pat_secret_ref: "ado_pat",
  enabled: true,
  interval_seconds: 30,
  watched: { assignee_mode: "any" },
};

/** Schedulers created by {@link setup}, stopped after each test so no timer leaks. */
const activeSchedulers: TriggerScheduler[] = [];

afterEach(() => {
  while (activeSchedulers.length) activeSchedulers.pop()!.stop();
});

/** Wire a module against a capturing emit and a fake client, ready to tick. */
function setup(config: AdoModuleConfig = BASE_CONFIG) {
  const emitted: NewEvent[] = [];
  const client = new FakeAdoClient();
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
    clientFactory: () => client,
    logger: createLogger({ sink: () => {} }),
  });

  const tick = () => mod.module.producers![0].tick();
  const backfill = (opts: { limit?: number; dryRun: boolean }) =>
    mod.module.producers![0].backfill!(opts);
  mod.module.applyConfig!(config);

  return { emitted, client, scheduler, mod, tick, backfill };
}

/** Events emitted of a given type. */
function ofType(emitted: NewEvent[], type: string): NewEvent[] {
  return emitted.filter((e) => e.type === type);
}

describe("ado work-item poller", () => {
  describe("capability registration", () => {
    it("registers the work-item, board, and links capabilities by id", () => {
      const { mod } = setup();
      expect(mod.module.capabilities?.map((c) => c.id)).toEqual([
        "ado.get_work_item",
        "ado.query_work_items",
        "ado.sprint_rollup",
        "ado.get_work_item_links",
      ]);
    });
  });

  describe("silent seeding", () => {
    it("emits nothing on the first tick and records the seeded count", async () => {
      const { emitted, client, mod, tick } = setup();
      client.board = [wi(1), wi(2), wi(3)];

      await tick();

      expect(emitted).toHaveLength(0);
      const status = mod.getStatus();
      expect(status.seeded_count).toBe(3);
      expect(status.last_error).toBeNull();
      expect(status.last_tick_at).not.toBeNull();
      expect(status.running).toBe(false);
    });

    it("does not treat already-seeded items as created on the next tick", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1)];
      await tick(); // seed
      await tick(); // no changes

      expect(emitted).toHaveLength(0);
    });

    it("a failed first tick does not count as seeded; the next tick reseeds", async () => {
      const emitted: NewEvent[] = [];
      const client = new FakeAdoClient();
      const scheduler = new TriggerScheduler({
        resolveTick: () => undefined,
        logger: createLogger({ sink: () => {} }),
      });
      let pat: string | undefined = undefined;
      const mod = createAdoModule({
        scheduler,
        resolveSecret: async () => pat,
        emit: async (e) => {
          emitted.push(e);
        },
        clientFactory: () => client,
        logger: createLogger({ sink: () => {} }),
      });
      mod.module.applyConfig!(BASE_CONFIG);
      client.board = [wi(1)];

      // First tick fails (no PAT): nothing seeded, error recorded.
      await mod.module.producers![0].tick();
      expect(mod.getStatus().last_error).toMatch(/PAT secret unavailable/);
      expect(mod.getStatus().seeded_count).toBe(0);

      // With the secret now resolvable the next tick seeds silently.
      pat = "the-pat";
      await mod.module.producers![0].tick();
      expect(emitted).toHaveLength(0);
      expect(mod.getStatus().seeded_count).toBe(1);
      expect(mod.getStatus().last_error).toBeNull();
      scheduler.stop();
    });
  });

  describe("new items", () => {
    it("emits created for a brand-new id", async () => {
      const { emitted, client, tick } = setup();
      client.board = [];
      await tick(); // seed empty

      client.board = [
        wi(7, {
          title: "T",
          state: "Active",
          type: "Bug",
          area: "A\\B",
          iteration: "A\\Backlog",
        }),
      ];
      await tick();

      const created = ofType(emitted, ADO_EVENT_CREATED);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        source: "ado",
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: "7",
        dedupe_key: `${ADO_EVENT_CREATED}:7`,
      });
      expect(created[0].payload).toEqual({
        id: 7,
        title: "T",
        state: "Active",
        work_item_type: "Bug",
        assignee: "",
        area_path: "A\\B",
        iteration_path: "A\\Backlog",
        tags: [],
        // The payload url is the human web-UI url; the REST API url is kept as
        // api_url. The default wi() url is the _apis/wit/workItems shape.
        url: "https://dev.azure.com/o/p/_workitems/edit/7",
        api_url: "https://dev.azure.com/o/p/_apis/wit/workItems/7",
      });
    });

    it("a new item with an assignee and tags also emits assigned + one tagged per tag", async () => {
      const { emitted, client, tick } = setup();
      client.board = [];
      await tick();

      client.board = [
        wi(9, {
          assignee: { uniqueName: "alice@x.com", displayName: "Alice" },
          tags: "red; blue",
        }),
      ];
      await tick();

      expect(ofType(emitted, ADO_EVENT_CREATED)).toHaveLength(1);

      const assigned = ofType(emitted, ADO_EVENT_ASSIGNED);
      expect(assigned).toHaveLength(1);
      expect(assigned[0].dedupe_key).toBe(`${ADO_EVENT_ASSIGNED}:9:alice@x.com`);
      expect(assigned[0].payload).toMatchObject({
        assignee: "alice@x.com",
        previous_assignee: null,
      });

      const tagged = ofType(emitted, ADO_EVENT_TAGGED);
      expect(tagged).toHaveLength(2);
      expect(tagged.map((t) => t.dedupe_key)).toEqual([
        `${ADO_EVENT_TAGGED}:9:red`,
        `${ADO_EVENT_TAGGED}:9:blue`,
      ]);
      expect(tagged.map((t) => (t.payload as { added_tag: string }).added_tag)).toEqual([
        "red",
        "blue",
      ]);
    });

    it("a new item without an assignee emits no assigned event", async () => {
      const { emitted, client, tick } = setup();
      client.board = [];
      await tick();
      client.board = [wi(4)];
      await tick();

      expect(ofType(emitted, ADO_EVENT_ASSIGNED)).toHaveLength(0);
    });
  });

  describe("diffs on existing items", () => {
    it("emits assigned with previous_assignee on an assignee change", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { assignee: "alice@x.com" })];
      await tick();

      client.board = [wi(1, { assignee: "bob@x.com" })];
      await tick();

      const assigned = ofType(emitted, ADO_EVENT_ASSIGNED);
      expect(assigned).toHaveLength(1);
      expect(assigned[0].dedupe_key).toBe(`${ADO_EVENT_ASSIGNED}:1:bob@x.com`);
      expect(assigned[0].payload).toMatchObject({
        assignee: "bob@x.com",
        previous_assignee: "alice@x.com",
      });
    });

    it("emits state_changed with previous_state on a state change", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { state: "New" })];
      await tick();

      client.board = [wi(1, { state: "Active" })];
      await tick();

      const changed = ofType(emitted, ADO_EVENT_STATE_CHANGED);
      expect(changed).toHaveLength(1);
      expect(changed[0].dedupe_key).toBe(`${ADO_EVENT_STATE_CHANGED}:1:Active`);
      expect(changed[0].payload).toMatchObject({
        state: "Active",
        previous_state: "New",
      });
    });

    it("emits area_changed with previous_area on an area-path move", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { area: "Proj\\Old" })];
      await tick();

      client.board = [wi(1, { area: "Proj\\FX" })];
      await tick();

      const areaChanged = ofType(emitted, ADO_EVENT_AREA_CHANGED);
      expect(areaChanged).toHaveLength(1);
      expect(areaChanged[0].dedupe_key).toBe(
        `${ADO_EVENT_AREA_CHANGED}:1:Proj\\FX`
      );
      expect(areaChanged[0].payload).toMatchObject({
        area_path: "Proj\\FX",
        previous_area: "Proj\\Old",
      });
      // A moved item does not also collapse to a bare "updated" event.
      expect(ofType(emitted, ADO_EVENT_UPDATED)).toHaveLength(0);
    });

    it("emits iteration_changed with previous_iteration on an iteration-path move", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { iteration: "Proj\\Sprint 1" })];
      await tick();

      client.board = [wi(1, { iteration: "Proj\\Backlog" })];
      await tick();

      const iterChanged = ofType(emitted, ADO_EVENT_ITERATION_CHANGED);
      expect(iterChanged).toHaveLength(1);
      expect(iterChanged[0].dedupe_key).toBe(
        `${ADO_EVENT_ITERATION_CHANGED}:1:Proj\\Backlog`
      );
      expect(iterChanged[0].payload).toMatchObject({
        iteration_path: "Proj\\Backlog",
        previous_iteration: "Proj\\Sprint 1",
      });
      expect(ofType(emitted, ADO_EVENT_UPDATED)).toHaveLength(0);
    });

    it("emits one tagged per newly-added tag, ignoring pre-existing ones", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { tags: "red" })];
      await tick();

      client.board = [wi(1, { tags: "red; blue; green" })];
      await tick();

      const tagged = ofType(emitted, ADO_EVENT_TAGGED);
      expect(tagged.map((t) => t.dedupe_key)).toEqual([
        `${ADO_EVENT_TAGGED}:1:blue`,
        `${ADO_EVENT_TAGGED}:1:green`,
      ]);
    });

    it("emits updated only when ChangedDate advanced and nothing else changed", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { changed: "2026-07-13T10:00:00Z" })];
      await tick();

      client.board = [wi(1, { changed: "2026-07-13T12:00:00Z" })];
      await tick();

      const updated = ofType(emitted, ADO_EVENT_UPDATED);
      expect(updated).toHaveLength(1);
      expect(updated[0].dedupe_key).toBe(
        `${ADO_EVENT_UPDATED}:1:2026-07-13T12:00:00Z`
      );
      expect(updated[0].payload).toMatchObject({
        changed_date: "2026-07-13T12:00:00Z",
      });
    });

    it("does NOT emit updated when a facet-specific change also occurred", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { state: "New", changed: "2026-07-13T10:00:00Z" })];
      await tick();

      // Both the state and the ChangedDate advance: only state_changed fires.
      client.board = [wi(1, { state: "Active", changed: "2026-07-13T12:00:00Z" })];
      await tick();

      expect(ofType(emitted, ADO_EVENT_STATE_CHANGED)).toHaveLength(1);
      expect(ofType(emitted, ADO_EVENT_UPDATED)).toHaveLength(0);
    });

    it("emits nothing when an item is entirely unchanged", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { state: "Active", changed: "2026-07-13T10:00:00Z" })];
      await tick();
      await tick();
      expect(emitted).toHaveLength(0);
    });

    it("treats an unassignment as an assignee change to the empty identity", async () => {
      const { emitted, client, tick } = setup();
      client.board = [wi(1, { assignee: "alice@x.com" })];
      await tick();
      client.board = [wi(1, { assignee: undefined })];
      await tick();

      const assigned = ofType(emitted, ADO_EVENT_ASSIGNED);
      expect(assigned).toHaveLength(1);
      expect(assigned[0].dedupe_key).toBe(`${ADO_EVENT_ASSIGNED}:1:`);
      expect(assigned[0].payload).toMatchObject({
        assignee: "",
        previous_assignee: "alice@x.com",
      });
    });
  });

  describe("config change reseeds", () => {
    it("resets the snapshot so the next tick seeds silently again", async () => {
      const { emitted, client, mod, tick } = setup();
      client.board = [wi(1, { state: "New" })];
      await tick(); // seed

      client.board = [wi(1, { state: "Active" })];
      await tick(); // one state_changed
      expect(ofType(emitted, ADO_EVENT_STATE_CHANGED)).toHaveLength(1);
      emitted.length = 0;

      // A config change wipes the snapshot; the next tick reseeds and emits nothing
      // even though the board differs from the pre-reseed snapshot.
      mod.module.applyConfig!({ ...BASE_CONFIG, interval_seconds: 45 });
      expect(mod.getStatus().seeded_count).toBe(0);

      client.board = [wi(1, { state: "Resolved" })];
      await tick();
      expect(emitted).toHaveLength(0);
      expect(mod.getStatus().seeded_count).toBe(1);

      // And the tick AFTER the reseed diffs against the fresh baseline.
      client.board = [wi(1, { state: "Closed" })];
      await tick();
      expect(ofType(emitted, ADO_EVENT_STATE_CHANGED)).toHaveLength(1);
      expect(ofType(emitted, ADO_EVENT_STATE_CHANGED)[0].payload).toMatchObject({
        previous_state: "Resolved",
      });
    });
  });

  describe("backfill", () => {
    it("replays every watched item as a created event with the poller's payload shape", async () => {
      const item = wi(7, {
        title: "T",
        state: "Active",
        type: "Bug",
        assignee: { uniqueName: "alice@x.com", displayName: "Alice" },
        area: "A\\B",
        iteration: "A\\Backlog",
        tags: "red; blue",
      });

      // Poll path: seed empty, then let the item appear so emitForNew fires.
      const poll = setup();
      poll.client.board = [];
      await poll.tick();
      poll.client.board = [item];
      await poll.tick();
      const pollCreated = ofType(poll.emitted, ADO_EVENT_CREATED)[0];

      // Backfill path: the watched query returns the same item.
      const bf = setup();
      bf.client.board = [item];
      const result = await bf.backfill({ dryRun: false });
      const bfCreated = ofType(bf.emitted, ADO_EVENT_CREATED);

      expect(result).toEqual({ candidates: 1, emitted: 1 });
      // Exactly one created event, and it is byte-for-byte the poller's.
      expect(bfCreated).toHaveLength(1);
      expect(bfCreated[0]).toEqual(pollCreated);
      // Backfill emits ONLY created — not the assigned/tagged the poller also fires.
      expect(bf.emitted).toHaveLength(1);
    });

    it("dry_run returns the candidate count and emits nothing", async () => {
      const { emitted, client, backfill } = setup();
      client.board = [wi(1), wi(2), wi(3)];

      const result = await backfill({ dryRun: true });

      expect(result).toEqual({ candidates: 3, emitted: 0 });
      expect(emitted).toHaveLength(0);
    });

    it("caps emission at limit, oldest-changed first", async () => {
      const { emitted, client, backfill } = setup();
      client.board = [
        wi(1, { changed: "2026-07-13T09:00:00Z" }),
        wi(2, { changed: "2026-07-13T08:00:00Z" }), // oldest
        wi(3, { changed: "2026-07-13T10:00:00Z" }),
      ];

      const result = await backfill({ limit: 2, dryRun: false });

      expect(result).toEqual({ candidates: 3, emitted: 2 });
      const created = ofType(emitted, ADO_EVENT_CREATED);
      expect(created.map((e) => e.subject_ref)).toEqual(["2", "1"]);
    });

    it("leaves the producer snapshot untouched: the next tick behaves as if it never ran", async () => {
      const { emitted, client, tick, backfill } = setup();
      client.board = [wi(1, { state: "New" })];
      await tick(); // seed at state New
      emitted.length = 0;

      // Backfill replays the item as a created event...
      const result = await backfill({ dryRun: false });
      expect(result).toEqual({ candidates: 1, emitted: 1 });
      expect(ofType(emitted, ADO_EVENT_CREATED)).toHaveLength(1);
      emitted.length = 0;

      // ...but the very next poll of the unchanged board emits nothing: proof the
      // snapshot was neither reset (else a reseed) nor advanced.
      await tick();
      expect(emitted).toHaveLength(0);

      // And a genuine change still diffs against the ORIGINAL pre-backfill
      // baseline (New), not against anything the backfill might have recorded.
      client.board = [wi(1, { state: "Active" })];
      await tick();
      const changed = ofType(emitted, ADO_EVENT_STATE_CHANGED);
      expect(changed).toHaveLength(1);
      expect(changed[0].payload).toMatchObject({ previous_state: "New" });
    });

    it("refuses when the module is disabled", async () => {
      const { backfill } = setup({ ...BASE_CONFIG, enabled: false });
      await expect(backfill({ dryRun: true })).rejects.toThrow(/enabled/);
    });

    it("refuses when org/project is unset", async () => {
      const { backfill } = setup({ ...BASE_CONFIG, org: undefined });
      await expect(backfill({ dryRun: true })).rejects.toThrow(/org and project/);
    });
  });

  describe("trigger derivation", () => {
    it("enabled + org + project → interval trigger", () => {
      const { scheduler } = setup();
      expect(scheduler.getProducerStatus(ADO_PRODUCER_ID)?.trigger).toEqual({
        kind: "interval",
        seconds: 30,
      });
    });

    it("defaults the interval when interval_seconds is absent", () => {
      const { scheduler } = setup({ ...BASE_CONFIG, interval_seconds: undefined });
      expect(scheduler.getProducerStatus(ADO_PRODUCER_ID)?.trigger).toEqual({
        kind: "interval",
        seconds: 60,
      });
    });

    it("disabled or under-configured → manual trigger, and tick is a no-op", async () => {
      const { emitted, client, mod, scheduler, tick } = setup({
        ...BASE_CONFIG,
        enabled: false,
      });
      expect(scheduler.getProducerStatus(ADO_PRODUCER_ID)?.trigger).toEqual({
        kind: "manual",
      });

      client.board = [wi(1)];
      await tick();
      expect(emitted).toHaveLength(0);
      expect(mod.getStatus().last_error).toBeNull();
    });
  });
});

describe("ado project scoping (poller + backfill, cross-project isolation)", () => {
  /** One board item plus the project it belongs to. */
  interface BoardEntry {
    project: string;
    item: ADOWorkItem;
  }

  /** A record of one WIQL call: which project's route ran it, and the query. */
  interface WiqlCall {
    project: string;
    query: string;
  }

  /**
   * A fake ADO client scoped to a single project — exactly like a real
   * project-scoped WIQL route. It models a whole org's board but returns only
   * the ids belonging to the project it was constructed for, so a query issued
   * against project A can NEVER surface project B's items.
   */
  class ProjectScopedFakeAdo {
    constructor(
      private readonly project: string,
      private readonly org: BoardEntry[],
      private readonly calls: WiqlCall[]
    ) {}

    async runWiql(query: string): Promise<number[]> {
      this.calls.push({ project: this.project, query });
      return this.org
        .filter((entry) => entry.project === this.project)
        .map((entry) => entry.item.id);
    }

    async getWorkItems(ids: number[]): Promise<ADOWorkItem[]> {
      const byId = new Map(this.org.map((entry) => [entry.item.id, entry.item]));
      return ids
        .map((id) => byId.get(id))
        .filter((item): item is ADOWorkItem => item !== undefined);
    }
  }

  const schedulers: TriggerScheduler[] = [];
  afterEach(() => {
    while (schedulers.length) schedulers.pop()!.stop();
  });

  /**
   * Wire a module configured for `projectA` against an org whose board also
   * holds a `projectB` item that would match the same watched filter. The
   * clientFactory honours `opts.project`, so tick and backfill each get a client
   * scoped to whatever project `resolveClient` asked for.
   */
  function wireTwoProjects() {
    const org: BoardEntry[] = [
      { project: "projectA", item: wi(1, { area: "projectA\\Area" }) },
      { project: "projectA", item: wi(2, { area: "projectA\\Area" }) },
      // Foreign project, same org, from a different number space — the item that
      // leaked before this fix.
      { project: "projectB", item: wi(99, { area: "projectB\\Root" }) },
    ];
    const calls: WiqlCall[] = [];
    const emitted: NewEvent[] = [];
    const scheduler = new TriggerScheduler({
      resolveTick: () => undefined,
      logger: createLogger({ sink: () => {} }),
    });
    schedulers.push(scheduler);

    const mod = createAdoModule({
      scheduler,
      resolveSecret: async () => "the-pat",
      emit: async (event) => {
        emitted.push(event);
      },
      clientFactory: (opts) =>
        new ProjectScopedFakeAdo(opts.project, org, calls),
      logger: createLogger({ sink: () => {} }),
    });
    mod.module.applyConfig!({
      ...BASE_CONFIG,
      org: "the-org",
      project: "projectA",
    });

    const producer = mod.module.producers![0];
    return { mod, producer, emitted, calls };
  }

  it("backfill candidates/emissions are limited to the configured project", async () => {
    const { producer, emitted } = wireTwoProjects();

    const result = await producer.backfill!({ dryRun: false });

    // Only projectA's two items — the foreign projectB item (99) never appears.
    expect(result).toEqual({ candidates: 2, emitted: 2 });
    const created = emitted.filter((e) => e.type === ADO_EVENT_CREATED);
    expect(created.map((e) => e.subject_ref).sort()).toEqual(["1", "2"]);
    expect(emitted.some((e) => e.subject_ref === "99")).toBe(false);
  });

  it("dry_run candidate count reflects the project-scoped query", async () => {
    const { producer, emitted } = wireTwoProjects();

    const result = await producer.backfill!({ dryRun: true });

    // 2, not 3 — the org-wide count would have included projectB's item.
    expect(result).toEqual({ candidates: 2, emitted: 0 });
    expect(emitted).toHaveLength(0);
  });

  it("the poll tick sees only the configured project (no foreign seed)", async () => {
    const { mod, producer, emitted } = wireTwoProjects();

    await producer.tick(); // silent seed

    expect(emitted).toHaveLength(0);
    // Seeded from projectA's two items only; projectB's 99 was never fetched.
    expect(mod.getStatus().seeded_count).toBe(2);
  });

  it("poller and backfill construct one identical project-scoped query/route", async () => {
    const { producer, calls } = wireTwoProjects();

    await producer.tick(); // one WIQL call via the poll path
    const tickCall = calls[calls.length - 1];
    await producer.backfill!({ dryRun: true }); // one WIQL call via the backfill path
    const backfillCall = calls[calls.length - 1];

    // Same query string AND same project route — the shared builder guarantees
    // the two paths cannot drift.
    expect(backfillCall.query).toBe(tickCall.query);
    expect(tickCall.project).toBe("projectA");
    expect(backfillCall.project).toBe("projectA");
    // And the query itself carries the belt-and-braces project clause.
    expect(backfillCall.query).toContain(
      "[System.TeamProject] = 'projectA'"
    );
  });
});

describe("ado poller dedupe-key folding (real db + emitEvent)", () => {
  let file: string;
  let db: Knex;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-adopoll-"));
    file = path.join(dir, "test.sqlite");
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("folds repeated same-key state changes within the cooldown window", async () => {
    const client = new FakeAdoClient();
    const scheduler = new TriggerScheduler({
      resolveTick: () => undefined,
      logger: createLogger({ sink: () => {} }),
    });
    const mod = createAdoModule({
      scheduler,
      resolveSecret: async () => "the-pat",
      emit: (event) => emitEvent(event, db),
      clientFactory: () => client,
      logger: createLogger({ sink: () => {} }),
    });
    mod.module.applyConfig!(BASE_CONFIG);
    const tick = () => mod.module.producers![0].tick();

    // Seed at state New (constant ChangedDate isolates the state facet).
    client.board = [wi(1, { state: "New", changed: "2026-07-13T10:00:00Z" })];
    await tick();

    // New → Active: emits & inserts state_changed:1:Active.
    client.board = [wi(1, { state: "Active", changed: "2026-07-13T10:00:00Z" })];
    await tick();
    // Active → New: a different key, inserts state_changed:1:New.
    client.board = [wi(1, { state: "New", changed: "2026-07-13T10:00:00Z" })];
    await tick();
    // New → Active again: SAME key as the first change; the cooldown folds it.
    client.board = [wi(1, { state: "Active", changed: "2026-07-13T10:00:00Z" })];
    await tick();

    const rows = await db("events")
      .where({ type: ADO_EVENT_STATE_CHANGED })
      .orderBy("id", "asc");
    // Three emits, one folded away by the dedupe cooldown → two persisted events.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `${ADO_EVENT_STATE_CHANGED}:1:Active`,
      `${ADO_EVENT_STATE_CHANGED}:1:New`,
    ]);

    scheduler.stop();
  });
});

describe("ado backfill through real intake (dedupe + caps)", () => {
  let file: string;
  let db: Knex;
  const schedulers: TriggerScheduler[] = [];

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-adobf-"));
    file = path.join(dir, "test.sqlite");
    db = createDb(file);
    await runMigrations(db);
  });

  afterEach(async () => {
    while (schedulers.length) schedulers.pop()!.stop();
    await db.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  /** Wire a module against the real event intake on this test's db. */
  function wire() {
    const client = new FakeAdoClient();
    const scheduler = new TriggerScheduler({
      resolveTick: () => undefined,
      logger: createLogger({ sink: () => {} }),
    });
    schedulers.push(scheduler);
    const mod = createAdoModule({
      scheduler,
      resolveSecret: async () => "the-pat",
      emit: (event) => emitEvent(event, db),
      clientFactory: () => client,
      logger: createLogger({ sink: () => {} }),
    });
    mod.module.applyConfig!(BASE_CONFIG);
    const backfill = (opts: { limit?: number; dryRun: boolean }) =>
      mod.module.producers![0].backfill!(opts);
    return { client, backfill };
  }

  it("dedupe suppresses an item whose created event already fired recently", async () => {
    const { client, backfill } = wire();
    client.board = [wi(1)];

    // First replay inserts created:1; the immediate second replay is folded away
    // by the dedupe cooldown — same normal intake as a poll tick, no bypass.
    await backfill({ dryRun: false });
    await backfill({ dryRun: false });

    const rows = await db("events").where({ type: ADO_EVENT_CREATED });
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`${ADO_EVENT_CREATED}:1`);
  });

  it("the per-hour intake cap drains a large backfill at the configured pace", async () => {
    await setSetting("dispatch_max_per_hour", "2", db);
    const pb = await createPlaybook(
      { name: "p", image: "img:latest", ttl_seconds: 60 },
      db
    );
    await createRule(
      { name: "r", match: {}, dispatch: [{ playbook_id: pb.id }] },
      db
    );

    const { client, backfill } = wire();
    client.board = [wi(1), wi(2), wi(3), wi(4), wi(5)];
    const result = await backfill({ dryRun: false });

    // Every candidate is emitted through intake...
    expect(result).toEqual({ candidates: 5, emitted: 5 });
    // ...but the per-hour cap gates dispatch creation to the configured 2.
    const dispatches = await db("dispatches");
    expect(dispatches).toHaveLength(2);
  });
});

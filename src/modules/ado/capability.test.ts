import type {
  ADOClientOptions,
  ADOComment,
  ADOWorkItem,
  ADOWorkItemRelation,
} from "./client";
import {
  ADO_GET_WORK_ITEM_CAPABILITY_ID,
  ADO_GET_WORK_ITEM_LINKS_CAPABILITY_ID,
  ADO_QUERY_MAX_TOP,
  ADO_QUERY_WORK_ITEMS_CAPABILITY_ID,
  ADO_SPRINT_ROLLUP_CAPABILITY_ID,
  createGetWorkItemCapability,
  createGetWorkItemLinksCapability,
  createQueryWorkItemsCapability,
  createSprintRollupCapability,
  stripHtml,
  type AdoBoardClientFactory,
  type AdoCapabilityClientFactory,
  type AdoLinksClientFactory,
} from "./capability";

/**
 * A fake ADO read client that returns queued work items and comments and records
 * every call, so tests can assert both the rendered output and the requests.
 */
class FakeClient {
  readonly getWorkItemsCalls: number[][] = [];
  readonly getCommentsCalls: number[] = [];

  constructor(
    private readonly items: ADOWorkItem[],
    private readonly comments: ADOComment[],
    private readonly opts: {
      throwOnItems?: Error;
      throwOnComments?: Error;
    } = {}
  ) {}

  async getWorkItems(ids: number[]): Promise<ADOWorkItem[]> {
    this.getWorkItemsCalls.push(ids);
    if (this.opts.throwOnItems) throw this.opts.throwOnItems;
    return this.items;
  }

  async getWorkItemComments(id: number): Promise<ADOComment[]> {
    this.getCommentsCalls.push(id);
    if (this.opts.throwOnComments) throw this.opts.throwOnComments;
    return this.comments;
  }
}

const BASE_CONFIG = {
  org: "contoso",
  project: "web",
  pat_secret_ref: "ado-pat",
};

function workItem(over: Partial<ADOWorkItem["fields"]> = {}, id = 42): ADOWorkItem {
  return {
    id,
    url: `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`,
    fields: {
      "System.Title": "Fix the thing",
      "System.WorkItemType": "Bug",
      "System.State": "Active",
      "System.AssignedTo": { displayName: "Ada Lovelace", uniqueName: "ada@x.com" },
      "System.AreaPath": "web\\ui",
      "System.Tags": "red; blue",
      "System.Description": "<p>Something is <b>broken</b>.</p>",
      ...over,
    },
  };
}

function comment(over: Partial<ADOComment> = {}): ADOComment {
  return {
    id: 1,
    text: "a comment",
    createdBy: { displayName: "Grace" },
    createdDate: "2026-07-10T00:00:00Z",
    ...over,
  };
}

/** Build a capability whose client factory returns `client` and records options. */
function capabilityFor(
  client: FakeClient,
  over: { resolveSecret?: (ref: string) => Promise<string | undefined> } = {}
) {
  const factoryCalls: ADOClientOptions[] = [];
  const clientFactory: AdoCapabilityClientFactory = (opts) => {
    factoryCalls.push(opts);
    return client;
  };
  const cap = createGetWorkItemCapability({
    resolveSecret: over.resolveSecret ?? (async () => "the-pat"),
    clientFactory,
  });
  return { cap, factoryCalls };
}

describe("stripHtml", () => {
  it("drops tags and decodes common entities", () => {
    expect(stripHtml("<p>Hello <b>world</b> &amp; &lt;you&gt;</p>")).toBe(
      "Hello world & <you>"
    );
  });

  it("turns <br> and block closers into newlines and <li> into bullets", () => {
    const html = "line one<br>line two<ul><li>a</li><li>b</li></ul>";
    expect(stripHtml(html)).toBe("line one\nline two\n- a\n- b");
  });

  it("collapses runs of blank lines and trims", () => {
    expect(stripHtml("<div>a</div><div></div><div></div><div>b</div>")).toBe("a\n\nb");
  });

  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});

describe("ado.get_work_item capability", () => {
  it("has the required stable id", () => {
    const { cap } = capabilityFor(new FakeClient([workItem()], []));
    expect(cap.id).toBe("ado.get_work_item");
    expect(ADO_GET_WORK_ITEM_CAPABILITY_ID).toBe("ado.get_work_item");
  });

  it("renders a clean plaintext block with fields, stripped description, labelled", async () => {
    const { cap, factoryCalls } = capabilityFor(new FakeClient([workItem()], []));

    const result = await cap.fetch(BASE_CONFIG, "42");

    expect(result.label).toBe("Work item 42");
    expect(result.content).toBe(
      [
        "Title: Fix the thing",
        "Type: Bug",
        "State: Active",
        "Assignee: Ada Lovelace",
        "Area: web\\ui",
        "Tags: red, blue",
        "",
        "Description:",
        "Something is broken.",
        "",
        "Comments (newest first):",
        "(none)",
      ].join("\n")
    );
    // The PAT was resolved and threaded into the client options.
    expect(factoryCalls[0]).toEqual({
      org: "contoso",
      project: "web",
      pat: "the-pat",
      baseUrl: undefined,
    });
  });

  it("orders comments newest-first and strips their HTML", async () => {
    const comments = [
      comment({
        id: 1,
        text: "<p>oldest</p>",
        createdBy: "grace@x.com",
        createdDate: "2026-07-01T00:00:00Z",
      }),
      comment({
        id: 2,
        text: "newest",
        createdBy: { displayName: "Ada" },
        createdDate: "2026-07-12T00:00:00Z",
      }),
      comment({
        id: 3,
        text: "middle",
        createdBy: { displayName: "Bob" },
        createdDate: "2026-07-05T00:00:00Z",
      }),
    ];
    const { cap } = capabilityFor(new FakeClient([workItem()], comments));

    const result = await cap.fetch(BASE_CONFIG, "42");

    const commentsBlock = result.content.split("Comments (newest first):\n")[1];
    expect(commentsBlock).toBe(
      [
        "[2026-07-12T00:00:00Z] Ada:",
        "newest",
        "",
        "[2026-07-05T00:00:00Z] Bob:",
        "middle",
        "",
        "[2026-07-01T00:00:00Z] grace@x.com:",
        "oldest",
      ].join("\n")
    );
  });

  it("caps the rendered comments at the 20 most recent", async () => {
    // 25 comments, dated so higher index == more recent.
    const comments = Array.from({ length: 25 }, (_, i) =>
      comment({
        id: i,
        text: `c${i}`,
        createdBy: { displayName: `U${i}` },
        createdDate: `2026-07-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
      })
    );
    const { cap } = capabilityFor(new FakeClient([workItem()], comments));

    const result = await cap.fetch(BASE_CONFIG, "42");

    const bodies = result.content.match(/\bc\d+\b/g) ?? [];
    expect(bodies).toHaveLength(20);
  });

  it("shows placeholders for an unassigned item with no tags or description", async () => {
    const item = workItem({
      "System.AssignedTo": undefined,
      "System.Tags": undefined,
      "System.Description": undefined,
    });
    const { cap } = capabilityFor(new FakeClient([item], []));

    const result = await cap.fetch(BASE_CONFIG, "42");

    expect(result.content).toContain("Assignee: (unassigned)");
    expect(result.content).toContain("Tags: (none)");
    expect(result.content).toContain("Description:\n(none)");
  });

  it("degrades (never throws) when the work item is not found", async () => {
    const { cap } = capabilityFor(new FakeClient([], []));

    const result = await cap.fetch(BASE_CONFIG, "42");

    expect(result.label).toBe("Work item 42");
    expect(result.content).toBe(
      "(capability ado.get_work_item failed: work item 42 not found)"
    );
  });

  it("degrades when fetching the work item throws", async () => {
    const client = new FakeClient([], [], {
      throwOnItems: new Error("boom from ADO"),
    });
    const { cap } = capabilityFor(client);

    const result = await cap.fetch(BASE_CONFIG, "42");

    expect(result.content).toBe(
      "(capability ado.get_work_item failed: boom from ADO)"
    );
  });

  it("degrades when fetching comments throws", async () => {
    const client = new FakeClient([workItem()], [], {
      throwOnComments: new Error("comments unavailable"),
    });
    const { cap } = capabilityFor(client);

    const result = await cap.fetch(BASE_CONFIG, "42");

    expect(result.content).toBe(
      "(capability ado.get_work_item failed: comments unavailable)"
    );
  });

  it("degrades on an invalid subject ref without calling the client", async () => {
    const client = new FakeClient([workItem()], []);
    const { cap } = capabilityFor(client);

    const result = await cap.fetch(BASE_CONFIG, "not-a-number");

    expect(result.label).toBe("Work item not-a-number");
    expect(result.content).toBe(
      '(capability ado.get_work_item failed: invalid work-item ref "not-a-number")'
    );
    expect(client.getWorkItemsCalls).toHaveLength(0);
  });

  it("degrades when org/project config is missing", async () => {
    const { cap } = capabilityFor(new FakeClient([workItem()], []));

    const result = await cap.fetch({ pat_secret_ref: "ado-pat" }, "42");

    expect(result.content).toBe(
      "(capability ado.get_work_item failed: ADO module is not configured (org/project missing))"
    );
  });

  it("degrades when the PAT secret cannot be resolved", async () => {
    const { cap } = capabilityFor(new FakeClient([workItem()], []), {
      resolveSecret: async () => undefined,
    });

    const result = await cap.fetch(BASE_CONFIG, "42");

    expect(result.content).toBe(
      '(capability ado.get_work_item failed: ADO PAT secret unavailable for ref "ado-pat")'
    );
  });
});

/**
 * A fake board client (runWiql + getWorkItems). It records the query it was
 * asked to run and the ids it was asked to fetch, so tests can assert the
 * read-only surface and the WIQL shape, and can optionally throw to exercise the
 * degrade path.
 */
class FakeBoardClient {
  runWiqlCalls: string[] = [];
  getWorkItemsCalls: number[][] = [];

  constructor(
    private readonly ids: number[],
    private readonly items: ADOWorkItem[],
    private readonly opts: { throwOnWiql?: Error; throwOnItems?: Error } = {}
  ) {}

  async runWiql(query: string): Promise<number[]> {
    this.runWiqlCalls.push(query);
    if (this.opts.throwOnWiql) throw this.opts.throwOnWiql;
    return this.ids;
  }

  async getWorkItems(ids: number[]): Promise<ADOWorkItem[]> {
    this.getWorkItemsCalls.push(ids);
    if (this.opts.throwOnItems) throw this.opts.throwOnItems;
    // Return only the items whose ids were asked for, preserving request order.
    return ids
      .map((id) => this.items.find((it) => it.id === id))
      .filter((it): it is ADOWorkItem => it !== undefined);
  }
}

/** Build a board work item with sensible defaults, overridable per-field. */
function boardItem(
  id: number,
  over: Partial<ADOWorkItem["fields"]> = {}
): ADOWorkItem {
  return {
    id,
    url: `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`,
    fields: {
      "System.Title": `Item ${id}`,
      "System.WorkItemType": "Bug",
      "System.State": "Active",
      "System.AssignedTo": { displayName: `User ${id}` },
      "System.AreaPath": "web\\ui",
      "System.ChangedDate": "2026-07-13T00:00:00Z",
      ...over,
    },
  };
}

/** Wire a board client factory that returns `client` and records its options. */
function boardFactoryFor(client: FakeBoardClient) {
  const factoryCalls: ADOClientOptions[] = [];
  const clientFactory: AdoBoardClientFactory = (opts) => {
    factoryCalls.push(opts);
    return client;
  };
  return { clientFactory, factoryCalls };
}

describe("ado.query_work_items capability", () => {
  it("has the required stable id", () => {
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
    });
    expect(cap.id).toBe("ado.query_work_items");
    expect(ADO_QUERY_WORK_ITEMS_CAPABILITY_ID).toBe("ado.query_work_items");
  });

  it("renders a bounded, labelled table and threads connection options through", async () => {
    const client = new FakeBoardClient(
      [1, 2],
      [
        boardItem(1, { "System.Title": "First", "System.State": "New" }),
        boardItem(2, {
          "System.Title": "Second",
          "System.WorkItemType": "Task",
          "System.AssignedTo": undefined,
        }),
      ]
    );
    const { clientFactory, factoryCalls } = boardFactoryFor(client);
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
    });

    const result = await cap.fetch(
      { ...BASE_CONFIG, work_item_types: ["Bug", "Task"] },
      ""
    );

    expect(result.label).toBe("Work items (2)");
    expect(result.content).toBe(
      [
        "id | type | title | state | assignee | area | changed",
        "1 | Bug | First | New | User 1 | web\\ui | 2026-07-13T00:00:00Z",
        "2 | Task | Second | Active | (unassigned) | web\\ui | 2026-07-13T00:00:00Z",
      ].join("\n")
    );
    expect(factoryCalls[0]).toEqual({
      org: "contoso",
      project: "web",
      pat: "the-pat",
      baseUrl: undefined,
    });
    // The filter reached the WIQL builder.
    expect(client.runWiqlCalls[0]).toContain("[System.WorkItemType] = 'Bug'");
  });

  it("caps results at the hard max (500) even when more ids match", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => i + 1);
    const items = ids.map((id) => boardItem(id));
    const client = new FakeBoardClient(ids, items);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
    });

    // top well above the hard max is clamped to ADO_QUERY_MAX_TOP.
    const result = await cap.fetch({ ...BASE_CONFIG, top: 9000 }, "");

    expect(client.getWorkItemsCalls[0]).toHaveLength(ADO_QUERY_MAX_TOP);
    expect(result.label).toBe(`Work items (${ADO_QUERY_MAX_TOP})`);
  });

  it("honours an explicit top below the default", async () => {
    const ids = [1, 2, 3, 4, 5];
    const client = new FakeBoardClient(ids, ids.map((id) => boardItem(id)));
    const { clientFactory } = boardFactoryFor(client);
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
    });

    const result = await cap.fetch({ ...BASE_CONFIG, top: 2 }, "");

    expect(client.getWorkItemsCalls[0]).toEqual([1, 2]);
    expect(result.label).toBe("Work items (2)");
  });

  it("shows a placeholder when nothing matches, without fetching items", async () => {
    const client = new FakeBoardClient([], []);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
    });

    const result = await cap.fetch(BASE_CONFIG, "");

    expect(result.label).toBe("Work items (0)");
    expect(result.content).toBe("(no matching work items)");
    expect(client.getWorkItemsCalls).toHaveLength(0);
  });

  it("degrades (never throws) when the WIQL run fails", async () => {
    const client = new FakeBoardClient([], [], {
      throwOnWiql: new Error("boom from ADO"),
    });
    const { clientFactory } = boardFactoryFor(client);
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
    });

    const result = await cap.fetch(BASE_CONFIG, "");

    expect(result.label).toBe("Work items");
    expect(result.content).toBe(
      "(capability ado.query_work_items failed: boom from ADO)"
    );
  });

  it("degrades when org/project config is missing", async () => {
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
    });

    const result = await cap.fetch({ pat_secret_ref: "ado-pat" }, "");

    expect(result.content).toBe(
      "(capability ado.query_work_items failed: ADO module is not configured (org/project missing))"
    );
  });

  it("degrades when the PAT secret cannot be resolved", async () => {
    const client = new FakeBoardClient([1], [boardItem(1)]);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => undefined,
      clientFactory,
    });

    const result = await cap.fetch(BASE_CONFIG, "");

    expect(result.content).toBe(
      '(capability ado.query_work_items failed: ADO PAT secret unavailable for ref "ado-pat")'
    );
  });

  it("issues only reads — a WIQL run then a batch fetch, no writer surface", async () => {
    const client = new FakeBoardClient([1], [boardItem(1)]);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createQueryWorkItemsCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
    });

    await cap.fetch(BASE_CONFIG, "");

    // The AdoBoardReadClient surface offers only runWiql + getWorkItems; both were
    // used and nothing else could have mutated the external system.
    expect(client.runWiqlCalls).toHaveLength(1);
    expect(client.getWorkItemsCalls).toEqual([[1]]);
  });
});

describe("ado.sprint_rollup capability", () => {
  const SPRINT_CONFIG = {
    ...BASE_CONFIG,
    area_path: "web\\ui",
    current_for_team: "web\\Team A",
  };
  // A fixed "now" so staleness is deterministic: 2026-07-14T00:00:00Z.
  const NOW = Date.parse("2026-07-14T00:00:00Z");

  it("has the required stable id", () => {
    const cap = createSprintRollupCapability({
      resolveSecret: async () => "the-pat",
    });
    expect(cap.id).toBe("ado.sprint_rollup");
    expect(ADO_SPRINT_ROLLUP_CAPABILITY_ID).toBe("ado.sprint_rollup");
  });

  it("queries the team's current-sprint open items (team iteration + NOT-IN terminal states)", async () => {
    const client = new FakeBoardClient([1], [boardItem(1)]);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createSprintRollupCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
      now: () => NOW,
    });

    await cap.fetch(SPRINT_CONFIG, "");

    const query = client.runWiqlCalls[0];
    expect(query).toContain(
      "@CurrentIteration('[web]\\Team A')"
    );
    expect(query).toContain("[System.State] NOT IN (");
    expect(query).toContain("[System.AreaPath] UNDER 'web\\ui'");
    // The rollup caps at the hard max, not the default 100.
    expect(query).toContain("'Closed'");
  });

  it("renders counts by state/type and at-risk, unassigned, in-review lists", async () => {
    const items = [
      // Fresh, assigned, active.
      boardItem(1, {
        "System.State": "Active",
        "System.ChangedDate": "2026-07-13T00:00:00Z",
      }),
      // Stale (changed 10 days ago), assigned → at-risk.
      boardItem(2, {
        "System.State": "Active",
        "System.ChangedDate": "2026-07-04T00:00:00Z",
      }),
      // In review, unassigned, and stale → at-risk + unassigned + in-review.
      boardItem(3, {
        "System.WorkItemType": "Task",
        "System.State": "In Review",
        "System.AssignedTo": undefined,
        "System.ChangedDate": "2026-07-01T00:00:00Z",
      }),
    ];
    const client = new FakeBoardClient([1, 2, 3], items);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createSprintRollupCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
      now: () => NOW,
    });

    const result = await cap.fetch(SPRINT_CONFIG, "");

    expect(result.label).toBe("Sprint rollup");
    const c = result.content;
    expect(c).toContain("Open items: 3");
    // Counts by state.
    expect(c).toContain("- Active: 2");
    expect(c).toContain("- In Review: 1");
    // Counts by type.
    expect(c).toContain("- Bug: 2");
    expect(c).toContain("- Task: 1");
    // At-risk = items 2 and 3 (both stale, non-terminal); item 1 is fresh.
    expect(c).toContain("At-risk (no change in 5+ days) (2):");
    expect(c).toContain("- #2 Item 2 (Active");
    expect(c).toContain("- #3 Item 3 (In Review");
    expect(c).not.toContain("- #1 Item 1 (Active");
    // Unassigned = item 3 only.
    expect(c).toContain("Unassigned (1):");
    // In review = item 3 only.
    expect(c).toContain("In review (1):");
  });

  it("shows a placeholder when the sprint has no open items", async () => {
    const client = new FakeBoardClient([], []);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createSprintRollupCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
      now: () => NOW,
    });

    const result = await cap.fetch(SPRINT_CONFIG, "");

    expect(result.content).toBe("(no open items in the current sprint)");
  });

  it("respects a configured stale_days threshold", async () => {
    const items = [
      // Changed 3 days ago: at-risk only when stale_days <= 3.
      boardItem(1, { "System.ChangedDate": "2026-07-11T00:00:00Z" }),
    ];
    const client = new FakeBoardClient([1], items);
    const { clientFactory } = boardFactoryFor(client);
    const cap = createSprintRollupCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
      now: () => NOW,
    });

    const result = await cap.fetch({ ...SPRINT_CONFIG, stale_days: 2 }, "");

    expect(result.content).toContain("At-risk (no change in 2+ days) (1):");
  });

  it("degrades (never throws) on an ADO error", async () => {
    const client = new FakeBoardClient([], [], {
      throwOnWiql: new Error("sprint boom"),
    });
    const { clientFactory } = boardFactoryFor(client);
    const cap = createSprintRollupCapability({
      resolveSecret: async () => "the-pat",
      clientFactory,
      now: () => NOW,
    });

    const result = await cap.fetch(SPRINT_CONFIG, "");

    expect(result.label).toBe("Sprint rollup");
    expect(result.content).toBe(
      "(capability ado.sprint_rollup failed: sprint boom)"
    );
  });
});

/* -------------------------------------------------------------------------- *
 * ado.get_work_item_links capability
 * -------------------------------------------------------------------------- */

const ORG = "contoso";
const PROJECT = "web";

/** A relation url for a linked work item under the configured org/project. */
function itemUrl(id: number): string {
  return `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/workItems/${id}`;
}

function parentRel(id: number): ADOWorkItemRelation {
  return {
    rel: "System.LinkTypes.Hierarchy-Reverse",
    url: itemUrl(id),
    attributes: { name: "Parent" },
  };
}
function childRel(id: number): ADOWorkItemRelation {
  return {
    rel: "System.LinkTypes.Hierarchy-Forward",
    url: itemUrl(id),
    attributes: { name: "Child" },
  };
}
function relatedRel(id: number): ADOWorkItemRelation {
  return {
    rel: "System.LinkTypes.Related",
    url: itemUrl(id),
    attributes: { name: "Related" },
  };
}
function attachmentRel(
  name: string,
  size: number,
  guid: string
): ADOWorkItemRelation {
  return {
    rel: "AttachedFile",
    url: `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit/attachments/${guid}`,
    attributes: { name, resourceSize: size },
  };
}

/** Build a linked work item with the given fields and relations. */
function linkItem(
  id: number,
  fields: Partial<ADOWorkItem["fields"]> = {},
  relations: ADOWorkItemRelation[] = []
): ADOWorkItem {
  return {
    id,
    url: itemUrl(id),
    fields: {
      "System.Title": `Item ${id}`,
      "System.WorkItemType": "Task",
      "System.State": "Active",
      "System.AssignedTo": { displayName: "Ada" },
      "System.ChangedDate": "2026-07-10T00:00:00Z",
      ...fields,
    },
    relations,
  };
}

/**
 * A fake links read client backed by a map of items by id. Records every
 * `getWorkItems` call so tests can assert batching.
 */
class FakeLinksClient {
  readonly calls: number[][] = [];
  constructor(private readonly byId: Map<number, ADOWorkItem>) {}
  async getWorkItems(ids: number[]): Promise<ADOWorkItem[]> {
    this.calls.push([...ids]);
    return ids
      .map((id) => this.byId.get(id))
      .filter((i): i is ADOWorkItem => i !== undefined);
  }
}

/** Build the links capability over a fixed set of items; exposes the client. */
function linksCapabilityFor(
  items: ADOWorkItem[],
  over: { resolveSecret?: (ref: string) => Promise<string | undefined> } = {}
) {
  const byId = new Map(items.map((i) => [i.id, i]));
  let client: FakeLinksClient | undefined;
  const clientFactory: AdoLinksClientFactory = () => {
    client = new FakeLinksClient(byId);
    return client;
  };
  const cap = createGetWorkItemLinksCapability({
    resolveSecret: over.resolveSecret ?? (async () => "the-pat"),
    clientFactory,
  });
  return { cap, getClient: () => client };
}

const LINKS_CONFIG = { org: ORG, project: PROJECT, pat_secret_ref: "ado-pat" };

describe("ado.get_work_item_links capability", () => {
  it("has the required stable id", () => {
    const { cap } = linksCapabilityFor([linkItem(42)]);
    expect(cap.id).toBe("ado.get_work_item_links");
    expect(ADO_GET_WORK_ITEM_LINKS_CAPABILITY_ID).toBe(
      "ado.get_work_item_links"
    );
  });

  it("renders the ancestor chain to the root with flattened descriptions", async () => {
    // 42 -> parent 40 -> parent 30 (root). Each ancestor has an HTML description.
    const items = [
      linkItem(42, {}, [parentRel(40)]),
      linkItem(
        40,
        {
          "System.Title": "The Epic",
          "System.WorkItemType": "Epic",
          "System.Description": "<p>Epic <b>context</b>.</p>",
        },
        [parentRel(30)]
      ),
      linkItem(
        30,
        {
          "System.Title": "The Initiative",
          "System.WorkItemType": "Initiative",
          "System.Description": "<p>Top-level goal.</p>",
        },
        []
      ),
    ];
    const { cap } = linksCapabilityFor(items);

    const result = await cap.fetch(LINKS_CONFIG, "42", { envNames: [] });

    expect(result.label).toBe("Work item 42 links");
    // Root first: Initiative (#30) precedes Epic (#40).
    const idx30 = result.content.indexOf("#30");
    const idx40 = result.content.indexOf("#40");
    expect(idx30).toBeGreaterThanOrEqual(0);
    expect(idx40).toBeGreaterThan(idx30);
    // Descriptions are rendered, flattened from HTML (no tags).
    expect(result.content).toContain("Epic context.");
    expect(result.content).toContain("Top-level goal.");
    expect(result.content).not.toContain("<b>");
  });

  it("caps ancestor depth and notes truncation", async () => {
    // A long chain 42 -> 41 -> 40 -> 39 -> 38; cap depth at 2.
    const items = [
      linkItem(42, {}, [parentRel(41)]),
      linkItem(41, {}, [parentRel(40)]),
      linkItem(40, {}, [parentRel(39)]),
      linkItem(39, {}, [parentRel(38)]),
      linkItem(38, {}, []),
    ];
    const { cap } = linksCapabilityFor(items);

    const result = await cap.fetch(
      { ...LINKS_CONFIG, max_ancestor_depth: 2 },
      "42",
      { envNames: [] }
    );

    // Only two ancestors walked (41 and 40); 39/38 never reached.
    expect(result.content).toContain("#41");
    expect(result.content).toContain("#40");
    expect(result.content).not.toContain("#39");
    expect(result.content).toContain("ancestor chain truncated at depth 2");
  });

  it("renders children and related as capped compact rows with a +N line", async () => {
    const childIds = Array.from({ length: 30 }, (_, i) => 1000 + i);
    const relatedIds = [2001, 2002];
    const subject = linkItem(42, {}, [
      ...childIds.map(childRel),
      ...relatedIds.map(relatedRel),
    ]);
    const children = childIds.map((id) =>
      linkItem(id, {
        "System.WorkItemType": "Task",
        "System.State": "Active",
      })
    );
    const related = relatedIds.map((id) =>
      linkItem(id, { "System.WorkItemType": "Bug" })
    );
    const { cap } = linksCapabilityFor([subject, ...children, ...related]);

    const result = await cap.fetch(LINKS_CONFIG, "42", { envNames: [] });

    expect(result.content).toContain("Children (30):");
    // Exactly 25 rows shown, then a +5 more line.
    expect(result.content).toContain("+5 more not shown");
    expect(result.content).toContain("#1000 | Task | Active");
    expect(result.content).not.toContain("#1025 |"); // beyond the 25-row cap
    expect(result.content).toContain("Related (2):");
    expect(result.content).toContain("#2001 | Bug");
    // No descriptions for compact rows.
    expect(result.content).not.toContain("(no description)");
  });

  it("orders children most-recently-changed first", async () => {
    const subject = linkItem(42, {}, [childRel(1001), childRel(1002)]);
    const older = linkItem(1001, {
      "System.ChangedDate": "2026-07-01T00:00:00Z",
    });
    const newer = linkItem(1002, {
      "System.ChangedDate": "2026-07-14T00:00:00Z",
    });
    const { cap } = linksCapabilityFor([subject, older, newer]);

    const result = await cap.fetch(LINKS_CONFIG, "42", { envNames: [] });

    expect(result.content.indexOf("#1002")).toBeLessThan(
      result.content.indexOf("#1001")
    );
  });

  it("batch-fetches children + related in a single call", async () => {
    const subject = linkItem(42, {}, [
      childRel(1001),
      childRel(1002),
      relatedRel(2001),
    ]);
    const items = [
      subject,
      linkItem(1001),
      linkItem(1002),
      linkItem(2001),
    ];
    const { cap, getClient } = linksCapabilityFor(items);

    await cap.fetch(LINKS_CONFIG, "42", { envNames: [] });

    const calls = getClient()!.calls;
    // First the subject, then ONE batched call for all linked ids (no N+1).
    expect(calls[0]).toEqual([42]);
    expect(calls).toHaveLength(2);
    expect(calls[1].sort((a, b) => a - b)).toEqual([1001, 1002, 2001]);
  });

  it("lists attachments as pointers and gates the fetch hint on ADO_PAT", async () => {
    const subject = linkItem(42, {}, [
      attachmentRel("design.png", 12345, "guid-1"),
      attachmentRel("spec.pdf", 2_000_000, "guid-2"),
    ]);
    const { cap } = linksCapabilityFor([subject]);

    // With ADO_PAT in env: the authenticated fetch hint is rendered.
    const withPat = await cap.fetch(LINKS_CONFIG, "42", {
      envNames: ["ADO_PAT"],
    });
    expect(withPat.content).toContain("Attachments (2):");
    expect(withPat.content).toContain("design.png (12.1 KB)");
    expect(withPat.content).toContain("spec.pdf (1.9 MB)");
    expect(withPat.content).toContain("attachments/guid-1");
    expect(withPat.content).toContain(
      "curl -u :$ADO_PAT -o ./work/attachments/<name> <url>"
    );

    // Without ADO_PAT in env: pointers still listed, but no fetch hint.
    const noPat = await cap.fetch(LINKS_CONFIG, "42", { envNames: [] });
    expect(noPat.content).toContain("Attachments (2):");
    expect(noPat.content).toContain("design.png");
    expect(noPat.content).not.toContain("curl -u");
  });

  it("honours a custom pat_env_var for the fetch hint", async () => {
    const subject = linkItem(42, {}, [attachmentRel("a.bin", 10, "g")]);
    const { cap } = linksCapabilityFor([subject]);

    const result = await cap.fetch(
      { ...LINKS_CONFIG, pat_env_var: "MY_PAT" },
      "42",
      { envNames: ["MY_PAT"] }
    );
    expect(result.content).toContain("curl -u :$MY_PAT");
  });

  it("renders clean empty sections when the item has no links or attachments", async () => {
    const { cap } = linksCapabilityFor([linkItem(42, {}, [])]);

    const result = await cap.fetch(LINKS_CONFIG, "42", { envNames: [] });

    expect(result.content).toContain("Ancestors (root first):\n(none)");
    expect(result.content).toContain("Children (0):\n(none)");
    expect(result.content).toContain("Related (0):\n(none)");
    expect(result.content).toContain("Attachments (0):\n(none)");
  });

  it("keeps the block under the size ceiling, shedding children/related first", async () => {
    // A short ancestor + a small attachment + many bulky children.
    const childIds = Array.from({ length: 40 }, (_, i) => 3000 + i);
    const subject = linkItem(42, {}, [
      parentRel(40),
      ...childIds.map(childRel),
      attachmentRel("keep-me.pdf", 500, "att-guid"),
    ]);
    const ancestor = linkItem(40, {
      "System.Title": "Parent Epic",
      "System.Description": "<p>short</p>",
    });
    const children = childIds.map((id) =>
      linkItem(id, {
        "System.Title": `A moderately long child title number ${id}`,
      })
    );
    const { cap } = linksCapabilityFor([subject, ancestor, ...children]);

    const MAX = 1200;
    const result = await cap.fetch(
      { ...LINKS_CONFIG, max_chars: MAX },
      "42",
      { envNames: ["ADO_PAT"] }
    );

    // Never exceeds the ceiling.
    expect(result.content.length).toBeLessThanOrEqual(MAX);
    // Ancestor context is preserved (most valuable, shed last).
    expect(result.content).toContain("#40");
    expect(result.content).toContain("Parent Epic");
    // The attachment list survives while children are shed first.
    expect(result.content).toContain("keep-me.pdf");
    // Children were truncated — not all 40 rows are present.
    expect(result.content).toContain("more not shown");
  });

  it("truncates hard when even the leanest block overflows, never exceeding the cap", async () => {
    // A deep chain whose compact ancestor rows alone (long titles, no
    // descriptions) dwarf the smallest configurable ceiling (500 chars).
    const ancestorIds = Array.from({ length: 10 }, (_, i) => 100 + i);
    const subject = linkItem(42, {}, [parentRel(ancestorIds[0])]);
    const ancestors = ancestorIds.map((id, i) =>
      linkItem(
        id,
        { "System.Title": `A very long ancestor title ${"y".repeat(200)}` },
        i + 1 < ancestorIds.length ? [parentRel(ancestorIds[i + 1])] : []
      )
    );
    const { cap } = linksCapabilityFor([subject, ...ancestors]);

    const MAX = 500;
    const result = await cap.fetch(
      { ...LINKS_CONFIG, max_chars: MAX },
      "42",
      { envNames: [] }
    );

    expect(result.content.length).toBeLessThanOrEqual(MAX);
    expect(result.content).toContain("truncated");
  });

  it("degrades (never throws) on an invalid subject ref", async () => {
    const { cap } = linksCapabilityFor([linkItem(42)]);
    const result = await cap.fetch(LINKS_CONFIG, "not-a-number", {
      envNames: [],
    });
    expect(result.label).toBe("Work item not-a-number links");
    expect(result.content).toContain(
      "capability ado.get_work_item_links failed"
    );
  });

  it("degrades when the module is not configured", async () => {
    const { cap } = linksCapabilityFor([linkItem(42)]);
    const result = await cap.fetch({}, "42", { envNames: [] });
    expect(result.content).toContain("org/project missing");
  });

  it("degrades when the PAT is unavailable", async () => {
    const { cap } = linksCapabilityFor([linkItem(42)], {
      resolveSecret: async () => undefined,
    });
    const result = await cap.fetch(LINKS_CONFIG, "42", { envNames: [] });
    expect(result.content).toContain("PAT secret unavailable");
  });
});

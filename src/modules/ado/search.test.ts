import { ADOApiError, type ADOWorkItem } from "./client";
import {
  ADO_WORKITEM_SEARCH_LIMIT,
  buildTitleSearchWiql,
  searchWorkItems,
  type AdoSearchClient,
} from "./search";

/** Build a raw work item carrying the fields the row mapper reads. */
function workItem(
  id: number,
  fields: Record<string, unknown> = {},
  url = `https://dev.azure.com/o/p/_apis/wit/workItems/${id}`
): ADOWorkItem {
  return {
    id,
    url,
    relations: [],
    fields: {
      "System.Title": `item ${id}`,
      "System.State": "New",
      "System.WorkItemType": "Task",
      "System.AreaPath": "Proj\\Area",
      "System.IterationPath": "Proj\\Sprint 1",
      ...fields,
    },
  };
}

/**
 * A mutable fake search client backed by an in-memory board. `runWiql` returns
 * `wiqlIds` and records the query; `getWorkItems` returns matching board items
 * and 404s (like ADO's batch endpoint) when a requested id is absent.
 */
class FakeSearchClient implements AdoSearchClient {
  board = new Map<number, ADOWorkItem>();
  wiqlIds: number[] = [];
  wiqlQueries: string[] = [];
  getWorkItemsCalls: number[][] = [];

  async runWiql(query: string): Promise<number[]> {
    this.wiqlQueries.push(query);
    return this.wiqlIds;
  }

  async getWorkItems(ids: number[]): Promise<ADOWorkItem[]> {
    this.getWorkItemsCalls.push(ids);
    const out: ADOWorkItem[] = [];
    for (const id of ids) {
      const item = this.board.get(id);
      if (!item) {
        throw new ADOApiError({
          httpStatus: 404,
          message: "does not exist",
          typeKey: "WorkItemDoesNotExistException",
        });
      }
      out.push(item);
    }
    return out;
  }
}

describe("ado work-item search", () => {
  describe("buildTitleSearchWiql", () => {
    it("scopes to the project and searches the title, ordered by recency", () => {
      const wiql = buildTitleSearchWiql("Alpha", "login");
      expect(wiql).toContain("[System.TeamProject] = 'Alpha'");
      expect(wiql).toContain("[System.Title] CONTAINS WORDS 'login'");
      expect(wiql).toContain("ORDER BY [System.ChangedDate] DESC");
    });

    it("escapes embedded single quotes in the query and project", () => {
      const wiql = buildTitleSearchWiql("O'Brien", "can't");
      expect(wiql).toContain("[System.TeamProject] = 'O''Brien'");
      expect(wiql).toContain("[System.Title] CONTAINS WORDS 'can''t'");
    });
  });

  it("maps title matches to poller-shaped rows with the web url", async () => {
    const client = new FakeSearchClient();
    client.wiqlIds = [1, 2];
    client.board.set(
      1,
      workItem(1, {
        "System.Title": "Login broken",
        "System.State": "Active",
        "System.WorkItemType": "Bug",
        "System.AreaPath": "Alpha\\Web",
        "System.IterationPath": "Alpha\\Sprint 1",
        "System.AssignedTo": { uniqueName: "ada@contoso.com" },
      })
    );
    client.board.set(2, workItem(2, { "System.Title": "Login retries" }));

    const rows = await searchWorkItems(client, "Alpha", "login");
    expect(rows).toEqual([
      {
        id: 1,
        title: "Login broken",
        work_item_type: "Bug",
        state: "Active",
        area_path: "Alpha\\Web",
        iteration_path: "Alpha\\Sprint 1",
        assignee: "ada@contoso.com",
        url: "https://dev.azure.com/o/p/_workitems/edit/1",
      },
      {
        id: 2,
        title: "Login retries",
        work_item_type: "Task",
        state: "New",
        area_path: "Proj\\Area",
        iteration_path: "Proj\\Sprint 1",
        assignee: "",
        url: "https://dev.azure.com/o/p/_workitems/edit/2",
      },
    ]);
    // A row exposes exactly the eight picker fields — no tags/api_url leakage.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "area_path",
      "assignee",
      "id",
      "iteration_path",
      "state",
      "title",
      "url",
      "work_item_type",
    ]);
  });

  it("also fetches the exact id when q is a positive integer, listed first", async () => {
    const client = new FakeSearchClient();
    client.wiqlIds = [8];
    client.board.set(42, workItem(42, { "System.Title": "Exact" }));
    client.board.set(8, workItem(8, { "System.Title": "Title match" }));

    const rows = await searchWorkItems(client, "Alpha", "42");
    expect(rows.map((r) => r.id)).toEqual([42, 8]);
    // The exact id was fetched directly, ahead of the title-match batch.
    expect(client.getWorkItemsCalls[0]).toEqual([42]);
    expect(client.getWorkItemsCalls[1]).toEqual([8]);
  });

  it("de-duplicates when the exact id is also a title match", async () => {
    const client = new FakeSearchClient();
    client.wiqlIds = [42];
    client.board.set(42, workItem(42, { "System.Title": "42 is the answer" }));

    const rows = await searchWorkItems(client, "Alpha", "42");
    expect(rows.map((r) => r.id)).toEqual([42]);
  });

  it("ignores a typed id that does not exist and returns title matches", async () => {
    const client = new FakeSearchClient();
    client.wiqlIds = [3];
    client.board.set(3, workItem(3, { "System.Title": "mentions 999" }));

    const rows = await searchWorkItems(client, "Alpha", "999");
    expect(rows.map((r) => r.id)).toEqual([3]);
  });

  it("caps the result at the search limit", async () => {
    const client = new FakeSearchClient();
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    client.wiqlIds = ids;
    for (const id of ids) client.board.set(id, workItem(id));

    const rows = await searchWorkItems(client, "Alpha", "item");
    expect(rows).toHaveLength(ADO_WORKITEM_SEARCH_LIMIT);
  });

  it("propagates a non-404 ADO error from the exact-id lookup", async () => {
    const client = new FakeSearchClient();
    client.getWorkItems = async () => {
      throw new ADOApiError({
        httpStatus: 500,
        message: "boom",
        typeKey: "InternalServerException",
      });
    };
    await expect(searchWorkItems(client, "Alpha", "42")).rejects.toBeInstanceOf(
      ADOApiError
    );
  });
});

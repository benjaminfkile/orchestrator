import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAdoAreaPaths,
  getAdoIdentities,
  getAdoIterations,
  getAdoOrgs,
  getAdoProjects,
  getAdoStates,
  getAdoWorkItemTypes,
  getCapabilityOptions,
  getWisperHostOptions,
  materializeWorkItem,
  searchWorkItems,
} from "./discovery";
import { API_BASE } from "./api";

function mockFetch(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** The path the last fetch was issued against, with the `/api` prefix stripped. */
function lastPath(): string {
  const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls[0][0] as string;
  return url.replace(API_BASE, "");
}

describe("ADO discovery helpers", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("maps orgs to account names", async () => {
    mockFetch([{ accountName: "contoso" }, { accountName: "" }, {}]);
    expect(await getAdoOrgs()).toEqual(["contoso"]);
    expect(lastPath()).toBe("/modules/ado/discovery/orgs");
  });

  it("rethrows the restricted-header reason on a degraded 200", async () => {
    // A PAT-scope failure comes back as a clean 200 with an empty body and the
    // reason in a header; the helper surfaces it as a rejection so the picker
    // shows it and stays freeform (no red 5xx in the network log).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Ado-Restricted": "Your PAT is likely restricted - type it in manually.",
          },
        }),
      ),
    );
    await expect(getAdoOrgs()).rejects.toThrow(/restricted/i);
  });

  it("maps projects and encodes the org", async () => {
    mockFetch([{ name: "Platform" }, { name: "Other" }]);
    expect(await getAdoProjects("my org")).toEqual(["Platform", "Other"]);
    expect(lastPath()).toBe("/modules/ado/discovery/projects?org=my%20org");
  });

  it("maps work-item types", async () => {
    mockFetch([{ name: "Bug" }, { name: "Task" }]);
    expect(await getAdoWorkItemTypes("contoso", "Platform")).toEqual([
      "Bug",
      "Task",
    ]);
    expect(lastPath()).toBe(
      "/modules/ado/discovery/work-item-types?org=contoso&project=Platform",
    );
  });

  it("maps states and passes the type", async () => {
    mockFetch([{ name: "Active" }, { name: "New" }]);
    expect(await getAdoStates("contoso", "Platform", "Bug")).toEqual([
      "Active",
      "New",
    ]);
    expect(lastPath()).toBe(
      "/modules/ado/discovery/states?org=contoso&project=Platform&type=Bug",
    );
  });

  it("returns area paths verbatim", async () => {
    mockFetch(["Platform", "Platform\\Backend"]);
    expect(await getAdoAreaPaths("contoso", "Platform")).toEqual([
      "Platform",
      "Platform\\Backend",
    ]);
    expect(lastPath()).toBe(
      "/modules/ado/discovery/area-paths?org=contoso&project=Platform",
    );
  });

  it("returns iterations verbatim", async () => {
    mockFetch(["Platform\\Sprint 1"]);
    expect(await getAdoIterations("contoso", "Platform")).toEqual([
      "Platform\\Sprint 1",
    ]);
    expect(lastPath()).toBe(
      "/modules/ado/discovery/iterations?org=contoso&project=Platform",
    );
  });

  it("maps identities to value/label options and drops the empty query", async () => {
    mockFetch([
      { displayName: "Alice", uniqueName: "alice@contoso.com" },
      { displayName: "Bob", uniqueName: "" },
      {},
    ]);
    expect(await getAdoIdentities("contoso", "Platform")).toEqual([
      { value: "alice@contoso.com", label: "Alice" },
      { value: "Bob", label: "Bob" },
    ]);
    expect(lastPath()).toBe(
      "/modules/ado/discovery/identities?org=contoso&project=Platform",
    );
  });

  it("includes a non-empty identity query", async () => {
    mockFetch([]);
    await getAdoIdentities("contoso", "Platform", "ali");
    expect(lastPath()).toBe(
      "/modules/ado/discovery/identities?org=contoso&project=Platform&q=ali",
    );
  });
});

describe("work-item search + materialize", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const ROW = {
    id: 42,
    title: "Login broken",
    work_item_type: "Bug",
    state: "Active",
    area_path: "Alpha\\Web",
    iteration_path: "Alpha\\Sprint 1",
    assignee: "ada@contoso.com",
    url: "https://dev.azure.com/contoso/Alpha/_workitems/edit/42",
  };

  it("searches work items by query and returns the rows verbatim", async () => {
    mockFetch([ROW]);
    expect(await searchWorkItems("login")).toEqual([ROW]);
    expect(lastPath()).toBe("/modules/ado/discovery/workitems?q=login");
  });

  it("encodes the search query", async () => {
    mockFetch([]);
    await searchWorkItems("login page");
    expect(lastPath()).toBe(
      "/modules/ado/discovery/workitems?q=login%20page",
    );
  });

  it("rethrows the restricted-header reason on a degraded 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Ado-Restricted": "Your PAT is likely restricted.",
          },
        }),
      ),
    );
    await expect(searchWorkItems("login")).rejects.toThrow(/restricted/i);
  });

  it("materializes a work item with a POST and returns the event", async () => {
    const event = { id: 7, source: "ado", type: "ado.workitem.manual" };
    mockFetch(event);
    expect(await materializeWorkItem(42)).toEqual(event);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(String(url)).toBe(
      `${API_BASE}/modules/ado/workitems/42/materialize`,
    );
    expect(init.method).toBe("POST");
  });
});

describe("getCapabilityOptions", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("maps capabilities to value/label options with the owning module", async () => {
    mockFetch([
      { id: "ado.get_work_item", module_id: "ado" },
      { id: "ado.query_work_items", module_id: "ado" },
      { id: "loose" },
      { id: "", module_id: "ado" },
      {},
    ]);
    expect(await getCapabilityOptions()).toEqual([
      { value: "ado.get_work_item", label: "ado.get_work_item (ado)" },
      { value: "ado.query_work_items", label: "ado.query_work_items (ado)" },
      { value: "loose", label: "loose" },
    ]);
    expect(lastPath()).toBe("/capabilities");
  });
});

describe("getWisperHostOptions", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("maps hosts to value/label options with the os in the label", async () => {
    mockFetch({
      hosts: [
        { id: "h-linux", name: "Linux box", os: "linux", online: true },
        { id: "h-win", name: "Windows box", os: "windows", online: false },
        // No os: label falls back to the name; no name: falls back to the id.
        { id: "h-bare", online: true },
        // Skipped: an entry with no id can't be committed.
        { name: "nameless" },
      ],
    });
    expect(await getWisperHostOptions()).toEqual([
      { value: "h-linux", label: "Linux box — linux" },
      // Offline hosts stay selectable but are marked in the label.
      { value: "h-win", label: "Windows box — windows (offline)" },
      { value: "h-bare", label: "h-bare" },
    ]);
    expect(lastPath()).toBe("/wisper/hosts");
  });

  it("degrades to an empty list when the endpoint returns no hosts", async () => {
    mockFetch({ hosts: [], warning: "wisper catalog request failed." });
    expect(await getWisperHostOptions()).toEqual([]);
  });
});

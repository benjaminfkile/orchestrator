import fs from "fs";
import os from "os";
import path from "path";

import type { Knex } from "knex";
import request from "supertest";

import app from "../app";
import { createDb, setDb } from "../db/db";
import { listDispatches } from "../db/dispatches";
import { listEvents } from "../db/events";
import { runMigrations } from "../db/migrate";
import { setModuleConfig } from "../db/moduleConfig";
import { createPlaybook } from "../db/playbooks";
import { createRule } from "../db/rules";
import {
  ADOApiError,
  type ADOPullRequest,
  type ADORepositoryRef,
  type ADOWorkItem,
} from "../modules/ado/client";
import {
  ADO_EVENT_MANUAL,
  ADO_PR_EVENT_MANUAL,
} from "../modules/ado/materialize";
import {
  ADO_EVENT_SOURCE,
  ADO_MODULE_ID,
  ADO_SUBJECT_KIND,
} from "../modules/ado/poller";
import { ADO_PR_SUBJECT_KIND } from "../modules/ado/pr";
import { resetRuntime, setRuntime } from "../runtime";
import { SecretStore, setSecretStore, type Keychain } from "../secrets";

import type { AdoDiscoveryLike, AdoMeClientLike } from "./adoDiscoveryRouter";

/** An in-memory keychain so the store never touches the real OS keychain. */
function fakeKeychain(): Keychain {
  let stored: string | null = null;
  return {
    get: () => stored,
    set: (password) => {
      stored = password;
    },
  };
}

function tempDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ado-router-"));
  return path.join(dir, "test.sqlite");
}

/**
 * A mocked discovery client recording the args it was called with. Every method
 * returns a canned list; a method may be swapped out per-test to simulate an
 * upstream error.
 */
function fakeDiscovery(): AdoDiscoveryLike & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => {
    calls[name] = args;
  };
  return {
    calls,
    async listOrganizations(pat) {
      record("listOrganizations", [pat]);
      return [{ accountName: "contoso" }, { accountName: "fabrikam" }];
    },
    async listProjects(org, pat) {
      record("listProjects", [org, pat]);
      return [{ name: "Alpha" }, { name: "Beta" }];
    },
    async listWorkItemTypes(org, project, pat) {
      record("listWorkItemTypes", [org, project, pat]);
      return [{ name: "Bug" }, { name: "Task" }];
    },
    async listStates(org, project, type, pat) {
      record("listStates", [org, project, type, pat]);
      return [{ name: "New" }, { name: "Active" }];
    },
    async listAreaPaths(org, project, pat) {
      record("listAreaPaths", [org, project, pat]);
      return ["Alpha", "Alpha\\Team"];
    },
    async listIterations(org, project, pat) {
      record("listIterations", [org, project, pat]);
      return ["Alpha", "Alpha\\Sprint 1"];
    },
    async listIdentities(org, project, pat, query) {
      record("listIdentities", [org, project, pat, query]);
      return [{ displayName: "Ada Lovelace", uniqueName: "ada@contoso.com" }];
    },
  };
}

/** Build a normalized PR shape (as the client returns) for the fake PR store. */
function pullRequest(
  id: number,
  over: Partial<ADOPullRequest> = {}
): ADOPullRequest {
  return {
    pullRequestId: id,
    title: `PR ${id}`,
    status: "active",
    isDraft: false,
    sourceRefName: "refs/heads/feature/x",
    targetRefName: "refs/heads/main",
    sourceCommit: "abc",
    createdBy: { uniqueName: "ada@contoso.com", displayName: "Ada Lovelace" },
    repository: {
      id: "repo-guid",
      name: "web",
      remoteUrl: "https://dev.azure.com/contoso/Alpha/_git/web",
    },
    reviewers: [],
    url: `https://dev.azure.com/contoso/_apis/git/pullRequests/${id}`,
    ...over,
  };
}

/** Build a raw work item with the fields the payload builder reads. */
function workItem(
  id: number,
  fields: Record<string, unknown>,
  url = `https://dev.azure.com/contoso/Alpha/_apis/wit/workItems/${id}`
): ADOWorkItem {
  return { id, fields, url, relations: [] };
}

/**
 * A mocked per-connection client recording its calls. `runWiql` returns
 * `wiqlIds`; `getWorkItems` returns the matching entries from `store`. Pull
 * requests come from `prStore` (an id-keyed map). A test may reassign a method
 * to simulate an upstream error.
 */
type FakeWorkItemClient = AdoMeClientLike & {
  calls: Record<string, unknown[]>;
  wiqlIds: number[];
  store: Map<number, ADOWorkItem>;
  prStore: Map<number, ADOPullRequest>;
  repoStore: Map<string, ADORepositoryRef>;
};

function fakeWorkItemClient(): FakeWorkItemClient {
  const calls: Record<string, unknown[]> = {};
  const store = new Map<number, ADOWorkItem>();
  const prStore = new Map<number, ADOPullRequest>();
  const repoStore = new Map<string, ADORepositoryRef>();
  const client: FakeWorkItemClient = {
    calls,
    wiqlIds: [],
    store,
    prStore,
    repoStore,
    async resolveMeIdentity() {
      calls.resolveMeIdentity = [];
      return { uniqueName: "me@contoso.com", displayName: "Me Myself" };
    },
    async runWiql(query) {
      calls.runWiql = [query];
      return client.wiqlIds;
    },
    async getWorkItems(ids) {
      calls.getWorkItems = [ids];
      // Mirror ADO's batch endpoint: a requested id absent from the store 404s
      // the whole batch.
      const out: ADOWorkItem[] = [];
      for (const id of ids) {
        const item = store.get(id);
        if (!item) {
          throw new ADOApiError({
            httpStatus: 404,
            message: "TF401232: work item does not exist",
            typeKey: "WorkItemDoesNotExistException",
          });
        }
        out.push(item);
      }
      return out;
    },
    async listPullRequests() {
      calls.listPullRequests = [];
      return [...prStore.values()];
    },
    async getPullRequestById(id) {
      calls.getPullRequestById = [id];
      const pr = prStore.get(id);
      if (!pr) {
        throw new ADOApiError({
          httpStatus: 404,
          message: "TF401180: pull request not found",
          typeKey: "PullRequestNotFoundException",
        });
      }
      return pr;
    },
    async getRepository(repositoryId) {
      calls.getRepository = [repositoryId];
      const repo = repoStore.get(repositoryId);
      if (!repo) {
        throw new ADOApiError({
          httpStatus: 404,
          message: "TF401019: repository not found",
          typeKey: "GitRepositoryNotFoundException",
        });
      }
      return repo;
    },
  };
  return client;
}

describe("ADO discovery router", () => {
  let file: string;
  let db: Knex;
  let discovery: ReturnType<typeof fakeDiscovery>;
  let meClient: FakeWorkItemClient;

  beforeEach(async () => {
    file = tempDbFile();
    db = createDb(file);
    await runMigrations(db);
    setDb(db);

    // A fresh in-memory secret store per test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ado-secrets-"));
    setSecretStore(new SecretStore({ dir, keychain: fakeKeychain() }));

    discovery = fakeDiscovery();
    meClient = fakeWorkItemClient();
    setRuntime({ ado: { discovery, makeClient: () => meClient } });
  });

  afterEach(async () => {
    await db.destroy();
    resetRuntime();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  /** Store a valid ADO config (pat ref + org/project) and seed the PAT secret. */
  async function configureAdo(): Promise<void> {
    await setModuleConfig(ADO_MODULE_ID, {
      org: "contoso",
      project: "Alpha",
      pat_secret_ref: "ADO_PAT",
    });
    await request(app).put("/api/secrets").send({ key: "ADO_PAT", value: "the-pat" });
  }

  describe("happy path", () => {
    beforeEach(configureAdo);

    it("lists orgs, resolving the PAT server-side", async () => {
      const res = await request(app).get("/api/modules/ado/discovery/orgs");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { accountName: "contoso" },
        { accountName: "fabrikam" },
      ]);
      // The PAT was resolved from the store and passed to the client, never
      // taken from the request or echoed to the client.
      expect(discovery.calls.listOrganizations).toEqual(["the-pat"]);
      expect(JSON.stringify(res.body)).not.toContain("the-pat");
    });

    it("lists projects for an org", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/projects?org=contoso"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ name: "Alpha" }, { name: "Beta" }]);
      expect(discovery.calls.listProjects).toEqual(["contoso", "the-pat"]);
    });

    it("lists work-item types", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/work-item-types?org=contoso&project=Alpha"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ name: "Bug" }, { name: "Task" }]);
      expect(discovery.calls.listWorkItemTypes).toEqual([
        "contoso",
        "Alpha",
        "the-pat",
      ]);
    });

    it("lists states for a type", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/states?org=contoso&project=Alpha&type=Bug"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ name: "New" }, { name: "Active" }]);
      expect(discovery.calls.listStates).toEqual([
        "contoso",
        "Alpha",
        "Bug",
        "the-pat",
      ]);
    });

    it("lists area paths", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/area-paths?org=contoso&project=Alpha"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual(["Alpha", "Alpha\\Team"]);
    });

    it("lists iterations", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/iterations?org=contoso&project=Alpha"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual(["Alpha", "Alpha\\Sprint 1"]);
    });

    it("lists identities, passing the q filter through", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/identities?org=contoso&project=Alpha&q=ada"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { displayName: "Ada Lovelace", uniqueName: "ada@contoso.com" },
      ]);
      expect(discovery.calls.listIdentities).toEqual([
        "contoso",
        "Alpha",
        "the-pat",
        "ada",
      ]);
    });

    it("defaults the identities q filter to empty when absent", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/identities?org=contoso&project=Alpha"
      );
      expect(res.status).toBe(200);
      expect(discovery.calls.listIdentities).toEqual([
        "contoso",
        "Alpha",
        "the-pat",
        "",
      ]);
    });

    it("resolves the authenticated identity for identity/me", async () => {
      const res = await request(app).get("/api/modules/ado/identity/me");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        uniqueName: "me@contoso.com",
        displayName: "Me Myself",
      });
    });

    it("400s when a required query param is missing", async () => {
      const res = await request(app).get("/api/modules/ado/discovery/projects");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/org/);
    });

    it("degrades a 401 to a 200 empty list with a 'PAT restricted' header", async () => {
      discovery.listOrganizations = async () => {
        throw new ADOApiError({
          httpStatus: 401,
          message: "TF400813: not authorized",
          typeKey: "UnauthorizedRequestException",
        });
      };
      const res = await request(app).get("/api/modules/ado/discovery/orgs");
      // A permission failure is NOT a gateway error — it stays a clean 200 so
      // the browser network log doesn't redden; the reason rides a header.
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      const restricted = res.headers["x-ado-restricted"];
      expect(restricted).toMatch(/restricted/i);
      expect(restricted).toMatch(/manually/i);
      // The raw ADO message is not surfaced to the user for a permission error.
      expect(restricted).not.toMatch(/TF400813/);
    });

    it("passes a non-permission ADO error through as 502 verbatim", async () => {
      discovery.listOrganizations = async () => {
        throw new ADOApiError({
          httpStatus: 500,
          message: "TF400898: internal error",
          typeKey: "InternalServerException",
        });
      };
      const res = await request(app).get("/api/modules/ado/discovery/orgs");
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("TF400898: internal error");
    });
  });

  describe("missing secret", () => {
    it("400s when the module has no pat_secret_ref", async () => {
      await setModuleConfig(ADO_MODULE_ID, { org: "contoso", project: "Alpha" });
      const res = await request(app).get("/api/modules/ado/discovery/orgs");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pat_secret_ref/);
    });

    it("400s when there is no ADO config at all", async () => {
      const res = await request(app).get("/api/modules/ado/discovery/orgs");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pat_secret_ref/);
    });

    it("400s when the referenced secret is unset", async () => {
      await setModuleConfig(ADO_MODULE_ID, {
        org: "contoso",
        project: "Alpha",
        pat_secret_ref: "ADO_PAT",
      });
      // No secret stored under ADO_PAT.
      const res = await request(app).get("/api/modules/ado/discovery/orgs");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ADO_PAT/);
      expect(res.body.error).toMatch(/missing or unset/);
    });

    it("400s identity/me when org is not configured", async () => {
      await setModuleConfig(ADO_MODULE_ID, { pat_secret_ref: "ADO_PAT" });
      await request(app)
        .put("/api/secrets")
        .send({ key: "ADO_PAT", value: "the-pat" });
      const res = await request(app).get("/api/modules/ado/identity/me");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/org/);
    });
  });

  /** Store an ENABLED ADO config (pat ref + org/project) and seed the PAT. */
  async function configureAdoEnabled(): Promise<void> {
    await setModuleConfig(ADO_MODULE_ID, {
      enabled: true,
      org: "contoso",
      project: "Alpha",
      pat_secret_ref: "ADO_PAT",
    });
    await request(app)
      .put("/api/secrets")
      .send({ key: "ADO_PAT", value: "the-pat" });
  }

  describe("work-item search", () => {
    beforeEach(configureAdoEnabled);

    it("runs a project-scoped title search and maps poller-shaped rows", async () => {
      meClient.wiqlIds = [11, 12];
      meClient.store.set(
        11,
        workItem(11, {
          "System.Title": "Login page broken",
          "System.State": "Active",
          "System.WorkItemType": "Bug",
          "System.AreaPath": "Alpha\\Web",
          "System.IterationPath": "Alpha\\Sprint 1",
          "System.AssignedTo": { uniqueName: "ada@contoso.com" },
        })
      );
      meClient.store.set(
        12,
        workItem(12, {
          "System.Title": "Login retries",
          "System.State": "New",
          "System.WorkItemType": "Task",
        })
      );

      const res = await request(app).get(
        "/api/modules/ado/discovery/workitems?q=login"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          id: 11,
          title: "Login page broken",
          work_item_type: "Bug",
          state: "Active",
          area_path: "Alpha\\Web",
          iteration_path: "Alpha\\Sprint 1",
          assignee: "ada@contoso.com",
          // The REST api url is rewritten to the human web-UI url.
          url: "https://dev.azure.com/contoso/Alpha/_workitems/edit/11",
        },
        {
          id: 12,
          title: "Login retries",
          work_item_type: "Task",
          state: "New",
          area_path: "",
          iteration_path: "",
          assignee: "",
          url: "https://dev.azure.com/contoso/Alpha/_workitems/edit/12",
        },
      ]);
      // The query is scoped to the configured project and searches the title.
      const query = String(meClient.calls.runWiql?.[0] ?? "");
      expect(query).toContain("[System.TeamProject] = 'Alpha'");
      expect(query).toContain("[System.Title] CONTAINS WORDS 'login'");
      expect(query).toContain("ORDER BY [System.ChangedDate] DESC");
    });

    it("also looks up the exact id when q is a positive integer", async () => {
      // Title search finds nothing; the exact-id lookup supplies the row.
      meClient.wiqlIds = [];
      meClient.store.set(
        42,
        workItem(42, {
          "System.Title": "Exact match",
          "System.State": "Active",
          "System.WorkItemType": "Bug",
        })
      );

      const res = await request(app).get(
        "/api/modules/ado/discovery/workitems?q=42"
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: 42, title: "Exact match" });
      // The exact id was fetched directly.
      expect(meClient.calls.getWorkItems).toEqual([[42]]);
    });

    it("ignores a typed id that does not exist and returns title matches", async () => {
      // 999 is not in the store (its exact lookup 404s), but a title match is.
      meClient.wiqlIds = [7];
      meClient.store.set(
        7,
        workItem(7, {
          "System.Title": "999 occurrences",
          "System.State": "New",
          "System.WorkItemType": "Task",
        })
      );

      const res = await request(app).get(
        "/api/modules/ado/discovery/workitems?q=999"
      );
      // The 404 on the exact-id fetch is swallowed; the request still succeeds.
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({ id: 7, title: "999 occurrences" }),
      ]);
    });

    it("caps the result at 25 rows", async () => {
      const ids = Array.from({ length: 40 }, (_, i) => i + 1);
      meClient.wiqlIds = ids;
      for (const id of ids) {
        meClient.store.set(
          id,
          workItem(id, { "System.Title": `item ${id}` })
        );
      }
      const res = await request(app).get(
        "/api/modules/ado/discovery/workitems?q=item"
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(25);
    });

    it("400s when q is missing", async () => {
      const res = await request(app).get(
        "/api/modules/ado/discovery/workitems"
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/q/);
    });

    it("degrades a 401 to a 200 empty list with the restricted header", async () => {
      meClient.runWiql = async () => {
        throw new ADOApiError({
          httpStatus: 403,
          message: "TF400813: not authorized",
          typeKey: "UnauthorizedRequestException",
        });
      };
      const res = await request(app).get(
        "/api/modules/ado/discovery/workitems?q=login"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(res.headers["x-ado-restricted"]).toMatch(/restricted/i);
    });

    it("400s when the module is configured but not enabled", async () => {
      await setModuleConfig(ADO_MODULE_ID, {
        org: "contoso",
        project: "Alpha",
        pat_secret_ref: "ADO_PAT",
      });
      const res = await request(app).get(
        "/api/modules/ado/discovery/workitems?q=login"
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled/);
    });
  });

  describe("work-item materialize", () => {
    beforeEach(configureAdoEnabled);

    it("materializes one manual event with a poller-identical payload", async () => {
      meClient.store.set(
        77,
        workItem(77, {
          "System.Title": "Ship it",
          "System.State": "Active",
          "System.WorkItemType": "Bug",
          "System.AreaPath": "Alpha\\Web",
          "System.IterationPath": "Alpha\\Sprint 2",
          "System.AssignedTo": { uniqueName: "ada@contoso.com" },
          "System.Tags": "urgent; regression",
        })
      );

      const res = await request(app).post(
        "/api/modules/ado/workitems/77/materialize"
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        source: ADO_EVENT_SOURCE,
        type: ADO_EVENT_MANUAL,
        subject_kind: ADO_SUBJECT_KIND,
        subject_ref: "77",
        dedupe_key: null,
        // Rule matching was skipped, so no dispatch was stamped.
        last_dispatched_at: null,
      });
      // The payload is exactly the poller's shape (web url + api_url preserved).
      expect(res.body.payload).toEqual({
        id: 77,
        title: "Ship it",
        state: "Active",
        work_item_type: "Bug",
        assignee: "ada@contoso.com",
        area_path: "Alpha\\Web",
        iteration_path: "Alpha\\Sprint 2",
        tags: ["urgent", "regression"],
        url: "https://dev.azure.com/contoso/Alpha/_workitems/edit/77",
        api_url: "https://dev.azure.com/contoso/Alpha/_apis/wit/workItems/77",
        changed_by: { uniqueName: "", displayName: "" },
        comment_count: 0,
      });

      // Exactly one event recorded, and no dispatch created.
      const events = await listEvents({}, db);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(ADO_EVENT_MANUAL);
      expect(await listDispatches(undefined, db)).toHaveLength(0);
    });

    it("does NOT run rules even when a rule would match", async () => {
      const pb = await createPlaybook(
        { name: "p", image: "img:latest", ttl_seconds: 60 },
        db
      );
      // A wildcard rule that matches every event.
      await createRule(
        { name: "catch-all", match: {}, dispatch: [{ playbook_id: pb.id }] },
        db
      );
      meClient.store.set(
        5,
        workItem(5, { "System.Title": "No dispatch please" })
      );

      const res = await request(app).post(
        "/api/modules/ado/workitems/5/materialize"
      );
      expect(res.status).toBe(201);
      // The catch-all rule did not fire: rule matching is skipped for materialize.
      expect(await listDispatches(undefined, db)).toHaveLength(0);
      expect(res.body.last_dispatched_at).toBeNull();
    });

    it("always inserts (no dedupe_key) so repeated calls create new events", async () => {
      meClient.store.set(9, workItem(9, { "System.Title": "Again" }));
      const first = await request(app).post(
        "/api/modules/ado/workitems/9/materialize"
      );
      const second = await request(app).post(
        "/api/modules/ado/workitems/9/materialize"
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.id).not.toBe(second.body.id);
      expect(await listEvents({}, db)).toHaveLength(2);
    });

    it("404s when the work item does not exist in ADO", async () => {
      const res = await request(app).post(
        "/api/modules/ado/workitems/1234/materialize"
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
      // Nothing was recorded.
      expect(await listEvents({}, db)).toHaveLength(0);
    });

    it("400s when the id is not a positive integer", async () => {
      const res = await request(app).post(
        "/api/modules/ado/workitems/abc/materialize"
      );
      expect(res.status).toBe(400);
    });

    it("400s when the module is configured but not enabled", async () => {
      await setModuleConfig(ADO_MODULE_ID, {
        org: "contoso",
        project: "Alpha",
        pat_secret_ref: "ADO_PAT",
      });
      const res = await request(app).post(
        "/api/modules/ado/workitems/77/materialize"
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled/);
    });
  });

  describe("pull-request discovery", () => {
    beforeEach(configureAdoEnabled);

    it("lists ACTIVE PRs with a compact per-row shape for the dialog", async () => {
      meClient.prStore.set(
        11,
        pullRequest(11, {
          title: "Add widget",
          sourceRefName: "refs/heads/feature/widget",
          targetRefName: "refs/heads/main",
          isDraft: false,
          repository: {
            id: "repo-guid",
            name: "web",
            remoteUrl: "https://dev.azure.com/contoso/Alpha/_git/web",
          },
        })
      );
      meClient.prStore.set(
        12,
        pullRequest(12, {
          title: "Draft change",
          sourceRefName: "refs/heads/wip",
          targetRefName: "refs/heads/main",
          isDraft: true,
          repository: {
            id: "repo-guid",
            name: "web",
          },
        })
      );

      const res = await request(app).get(
        "/api/modules/ado/discovery/pullrequests"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          id: 11,
          title: "Add widget",
          repository: "web",
          source_branch: "feature/widget",
          target_branch: "main",
          is_draft: false,
        },
        {
          id: 12,
          title: "Draft change",
          repository: "web",
          source_branch: "wip",
          target_branch: "main",
          is_draft: true,
        },
      ]);
    });

    it("400s when the module is configured but not enabled", async () => {
      await setModuleConfig(ADO_MODULE_ID, {
        org: "contoso",
        project: "Alpha",
        pat_secret_ref: "ADO_PAT",
      });
      const res = await request(app).get(
        "/api/modules/ado/discovery/pullrequests"
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled/);
    });

    it("degrades a 401 to a 200 empty list with the restricted header", async () => {
      meClient.listPullRequests = async () => {
        throw new ADOApiError({
          httpStatus: 403,
          message: "TF400813: not authorized",
          typeKey: "UnauthorizedRequestException",
        });
      };
      const res = await request(app).get(
        "/api/modules/ado/discovery/pullrequests"
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(res.headers["x-ado-restricted"]).toMatch(/restricted/i);
    });
  });

  describe("pull-request materialize", () => {
    beforeEach(configureAdoEnabled);

    it("materializes one manual event with a poller-identical PR payload", async () => {
      meClient.prStore.set(
        101,
        pullRequest(101, {
          title: "Fix login",
          isDraft: true,
          sourceRefName: "refs/heads/feature/login",
          targetRefName: "refs/heads/main",
          status: "active",
          repository: {
            id: "repo-guid",
            name: "web",
            remoteUrl: "https://dev.azure.com/contoso/Alpha/_git/web",
          },
        })
      );

      const res = await request(app).post(
        "/api/modules/ado/pullrequests/101/materialize"
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        source: ADO_EVENT_SOURCE,
        type: ADO_PR_EVENT_MANUAL,
        subject_kind: ADO_PR_SUBJECT_KIND,
        subject_ref: "101",
        dedupe_key: null,
        // Rule matching was skipped, so no dispatch was stamped.
        last_dispatched_at: null,
      });
      // The payload is exactly the poller's base shape for a PR event.
      expect(res.body.payload).toEqual({
        id: 101,
        title: "Fix login",
        repository: "web",
        repo_remote_url: "https://dev.azure.com/contoso/Alpha/_git/web",
        repo_remote_url_hostpath: "dev.azure.com/contoso/Alpha/_git/web",
        source_branch: "feature/login",
        target_branch: "main",
        created_by: {
          uniqueName: "ada@contoso.com",
          displayName: "Ada Lovelace",
        },
        status: "active",
        is_draft: true,
        url: "https://dev.azure.com/contoso/_apis/git/pullRequests/101",
      });
      // Exactly one event recorded, and no dispatch created.
      const events = await listEvents({}, db);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(ADO_PR_EVENT_MANUAL);
      expect(await listDispatches(undefined, db)).toHaveLength(0);
    });

    it("resolves the clone URL via getRepository when the PR omits remoteUrl", async () => {
      meClient.prStore.set(
        202,
        pullRequest(202, {
          repository: { id: "repo-guid", name: "web" },
        })
      );
      meClient.repoStore.set("repo-guid", {
        id: "repo-guid",
        name: "web",
        remoteUrl: "https://dev.azure.com/contoso/Alpha/_git/web",
      });

      const res = await request(app).post(
        "/api/modules/ado/pullrequests/202/materialize"
      );
      expect(res.status).toBe(201);
      expect(res.body.payload.repo_remote_url).toBe(
        "https://dev.azure.com/contoso/Alpha/_git/web"
      );
      expect(meClient.calls.getRepository).toEqual(["repo-guid"]);
    });

    it("does NOT run rules even when a rule would match", async () => {
      const pb = await createPlaybook(
        { name: "p", image: "img:latest", ttl_seconds: 60 },
        db
      );
      await createRule(
        { name: "catch-all", match: {}, dispatch: [{ playbook_id: pb.id }] },
        db
      );
      meClient.prStore.set(303, pullRequest(303));

      const res = await request(app).post(
        "/api/modules/ado/pullrequests/303/materialize"
      );
      expect(res.status).toBe(201);
      expect(await listDispatches(undefined, db)).toHaveLength(0);
      expect(res.body.last_dispatched_at).toBeNull();
    });

    it("always inserts (no dedupe_key) so repeated calls create new events", async () => {
      meClient.prStore.set(404, pullRequest(404));
      const first = await request(app).post(
        "/api/modules/ado/pullrequests/404/materialize"
      );
      const second = await request(app).post(
        "/api/modules/ado/pullrequests/404/materialize"
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.id).not.toBe(second.body.id);
      expect(await listEvents({}, db)).toHaveLength(2);
    });

    it("passes the ADO 'not found' through as a 404", async () => {
      const res = await request(app).post(
        "/api/modules/ado/pullrequests/9999/materialize"
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
      expect(await listEvents({}, db)).toHaveLength(0);
    });

    it("400s when the id is not a positive integer", async () => {
      const res = await request(app).post(
        "/api/modules/ado/pullrequests/abc/materialize"
      );
      expect(res.status).toBe(400);
    });

    it("400s when the module is configured but not enabled", async () => {
      await setModuleConfig(ADO_MODULE_ID, {
        org: "contoso",
        project: "Alpha",
        pat_secret_ref: "ADO_PAT",
      });
      const res = await request(app).post(
        "/api/modules/ado/pullrequests/101/materialize"
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled/);
    });

    it("passes a non-404 ADO error through as 502", async () => {
      meClient.getPullRequestById = async () => {
        throw new ADOApiError({
          httpStatus: 500,
          message: "TF400898: internal error",
          typeKey: "InternalServerException",
        });
      };
      const res = await request(app).post(
        "/api/modules/ado/pullrequests/101/materialize"
      );
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("TF400898: internal error");
    });
  });
});

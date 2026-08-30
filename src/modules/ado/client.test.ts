import http from "http";
import type { AddressInfo } from "net";

import {
  ADOApiError,
  ADOClient,
  ADO_API_VERSION,
  ADO_COMMENTS_API_VERSION,
  ADO_DEFAULT_BASE_URL,
  ADO_WORKITEM_BATCH_SIZE,
} from "./client";

/** A single request the mock server observed, with headers and parsed URL. */
interface CapturedRequest {
  method?: string;
  /** Path + query string, exactly as received. */
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** How the mock server should answer the next request. */
interface MockResponse {
  status: number;
  /** JSON body; a string is sent verbatim, an object is stringified. */
  body?: unknown;
}

/**
 * A tiny in-process http server used as the Azure DevOps stand-in. Each test
 * queues one response per expected request and inspects what was received —
 * method, path, query, auth header, and body.
 */
class MockServer {
  readonly requests: CapturedRequest[] = [];
  private responses: MockResponse[] = [];
  private server!: http.Server;
  baseUrl = "";

  respondWith(res: MockResponse): void {
    this.responses.push(res);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const next = this.responses.shift() ?? { status: 500 };
        const payload =
          next.body === undefined
            ? ""
            : typeof next.body === "string"
            ? next.body
            : JSON.stringify(next.body);
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

function clientFor(server: MockServer, over: Partial<{ org: string; project: string; pat: string }> = {}) {
  return new ADOClient({
    org: over.org ?? "my org",
    project: over.project ?? "my project",
    pat: over.pat ?? "s3cr3t-pat",
    baseUrl: server.baseUrl,
  });
}

describe("ADOClient", () => {
  let server: MockServer;

  beforeEach(async () => {
    server = new MockServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe("auth header", () => {
    it("sends PAT as Basic auth: base64 of ':' + pat", async () => {
      server.respondWith({ status: 200, body: { workItems: [] } });
      const client = clientFor(server, { pat: "hunter2" });

      await client.runWiql("SELECT [System.Id] FROM WorkItems");

      const auth = server.requests[0].headers.authorization;
      expect(auth).toBe(`Basic ${Buffer.from(":hunter2").toString("base64")}`);
      // Sanity: decoding drops back to an empty username + the raw PAT.
      const decoded = Buffer.from(auth!.slice("Basic ".length), "base64").toString("utf8");
      expect(decoded).toBe(":hunter2");
    });

    it("never puts the PAT in the request body or url", async () => {
      server.respondWith({ status: 200, body: { workItems: [] } });
      const client = clientFor(server, { pat: "topsecret" });

      await client.runWiql("SELECT [System.Id] FROM WorkItems");

      expect(server.requests[0].url).not.toContain("topsecret");
      expect(server.requests[0].body).not.toContain("topsecret");
    });
  });

  describe("runWiql", () => {
    it("POSTs the query to the project-scoped wiql endpoint and returns ids", async () => {
      server.respondWith({
        status: 200,
        body: { workItems: [{ id: 5 }, { id: 9 }, { id: 12 }] },
      });
      const client = clientFor(server, { org: "contoso", project: "web" });

      const ids = await client.runWiql("SELECT [System.Id] FROM WorkItems WHERE ...");

      const req = server.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe(`/contoso/web/_apis/wit/wiql?api-version=${ADO_API_VERSION}`);
      expect(req.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(req.body)).toEqual({
        query: "SELECT [System.Id] FROM WorkItems WHERE ...",
      });
      expect(ids).toEqual([5, 9, 12]);
    });

    it("percent-encodes org and project path segments", async () => {
      server.respondWith({ status: 200, body: { workItems: [] } });
      const client = clientFor(server, { org: "my org", project: "a/b" });

      await client.runWiql("q");

      expect(server.requests[0].url).toBe(
        `/my%20org/a%2Fb/_apis/wit/wiql?api-version=${ADO_API_VERSION}`
      );
    });

    it("returns [] when the response has no workItems", async () => {
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      expect(await client.runWiql("q")).toEqual([]);
    });
  });

  describe("getWorkItems", () => {
    it("GETs the batch endpoint with ids, $expand=all, and returns typed rows", async () => {
      server.respondWith({
        status: 200,
        body: {
          value: [
            {
              id: 42,
              url: "https://dev.azure.com/contoso/_apis/wit/workItems/42",
              fields: {
                "System.Title": "A title",
                "System.State": "Active",
                "System.WorkItemType": "Task",
                "System.AssignedTo": { displayName: "Ada", uniqueName: "ada@x.com" },
                "System.AreaPath": "web\\ui",
                "System.Tags": "red; blue",
                "System.ChangedDate": "2026-07-13T00:00:00Z",
              },
            },
          ],
        },
      });
      const client = clientFor(server, { org: "contoso", project: "web" });

      const rows = await client.getWorkItems([42]);

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/web/_apis/wit/workitems?ids=42&$expand=all&api-version=${ADO_API_VERSION}`
      );
      expect(req.body).toBe("");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(42);
      expect(rows[0].url).toBe("https://dev.azure.com/contoso/_apis/wit/workItems/42");
      expect(rows[0].fields["System.Title"]).toBe("A title");
      expect(rows[0].fields["System.State"]).toBe("Active");
      expect(rows[0].fields["System.WorkItemType"]).toBe("Task");
      expect(rows[0].fields["System.AssignedTo"]).toEqual({
        displayName: "Ada",
        uniqueName: "ada@x.com",
      });
      expect(rows[0].fields["System.AreaPath"]).toBe("web\\ui");
      expect(rows[0].fields["System.Tags"]).toBe("red; blue");
      expect(rows[0].fields["System.ChangedDate"]).toBe("2026-07-13T00:00:00Z");
    });

    it("comma-joins multiple ids in a single batch", async () => {
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server, { org: "o", project: "p" });

      await client.getWorkItems([1, 2, 3]);

      expect(server.requests[0].url).toBe(
        `/o/p/_apis/wit/workitems?ids=1,2,3&$expand=all&api-version=${ADO_API_VERSION}`
      );
    });

    it("splits into batches of at most 200 and concatenates results in order", async () => {
      const total = ADO_WORKITEM_BATCH_SIZE + 50; // 250 → two batches
      const ids = Array.from({ length: total }, (_, i) => i + 1);
      // Each batch echoes back one row carrying the count of requested ids so we
      // can assert both batching and result concatenation order.
      server.respondWith({ status: 200, body: { value: [{ id: 1000 }] } });
      server.respondWith({ status: 200, body: { value: [{ id: 2000 }] } });
      const client = clientFor(server, { org: "o", project: "p" });

      const rows = await client.getWorkItems(ids);

      expect(server.requests).toHaveLength(2);
      const firstIds = new URL("http://x" + server.requests[0].url!).searchParams.get("ids")!;
      const secondIds = new URL("http://x" + server.requests[1].url!).searchParams.get("ids")!;
      expect(firstIds.split(",")).toHaveLength(ADO_WORKITEM_BATCH_SIZE);
      expect(secondIds.split(",")).toHaveLength(50);
      expect(firstIds.split(",")[0]).toBe("1");
      expect(secondIds.split(",")[0]).toBe(String(ADO_WORKITEM_BATCH_SIZE + 1));
      expect(rows.map((r) => r.id)).toEqual([1000, 2000]);
    });

    it("issues no request and returns [] for an empty id list", async () => {
      const client = clientFor(server);
      expect(await client.getWorkItems([])).toEqual([]);
      expect(server.requests).toHaveLength(0);
    });
  });

  describe("getWorkItemComments", () => {
    it("GETs the preview comments endpoint and returns normalized rows", async () => {
      server.respondWith({
        status: 200,
        body: {
          comments: [
            {
              id: 1,
              text: "<p>first</p>",
              createdBy: { displayName: "Ada", uniqueName: "ada@x.com" },
              createdDate: "2026-07-10T00:00:00Z",
            },
            {
              id: 2,
              text: "second",
              createdBy: "grace@x.com",
              createdDate: "2026-07-11T00:00:00Z",
            },
          ],
        },
      });
      const client = clientFor(server, { org: "contoso", project: "web" });

      const comments = await client.getWorkItemComments(42);

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/web/_apis/wit/workItems/42/comments?api-version=${ADO_COMMENTS_API_VERSION}`
      );
      expect(req.body).toBe("");
      expect(comments).toEqual([
        {
          id: 1,
          text: "<p>first</p>",
          createdBy: { displayName: "Ada", uniqueName: "ada@x.com" },
          createdDate: "2026-07-10T00:00:00Z",
        },
        {
          id: 2,
          text: "second",
          createdBy: "grace@x.com",
          createdDate: "2026-07-11T00:00:00Z",
        },
      ]);
    });

    it("percent-encodes org and project but keeps the numeric id in the path", async () => {
      server.respondWith({ status: 200, body: { comments: [] } });
      const client = clientFor(server, { org: "my org", project: "a/b" });

      await client.getWorkItemComments(7);

      expect(server.requests[0].url).toBe(
        `/my%20org/a%2Fb/_apis/wit/workItems/7/comments?api-version=${ADO_COMMENTS_API_VERSION}`
      );
    });

    it("returns [] and tolerates missing fields when there are no comments", async () => {
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      expect(await client.getWorkItemComments(1)).toEqual([]);
    });

    it("normalizes absent id/text/createdBy/createdDate to defaults", async () => {
      server.respondWith({ status: 200, body: { comments: [{}] } });
      const client = clientFor(server);
      expect(await client.getWorkItemComments(1)).toEqual([
        { id: 0, text: "", createdBy: "", createdDate: "" },
      ]);
    });
  });

  describe("resolveMeIdentity", () => {
    it("GETs the org-scoped connectionData endpoint and returns the user", async () => {
      server.respondWith({
        status: 200,
        body: {
          authenticatedUser: { uniqueName: "me@x.com", displayName: "Me Myself" },
        },
      });
      const client = clientFor(server, { org: "contoso", project: "web" });

      const id = await client.resolveMeIdentity();

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      // Org-scoped, NOT project-scoped.
      expect(req.url).toBe("/contoso/_apis/connectionData");
      expect(id).toEqual({ uniqueName: "me@x.com", displayName: "Me Myself" });
    });

    it("tolerates a missing authenticatedUser", async () => {
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      expect(await client.resolveMeIdentity()).toEqual({
        uniqueName: undefined,
        displayName: undefined,
      });
    });
  });

  describe("listPullRequests", () => {
    it("GETs the project-scoped active-PR endpoint and returns normalized rows", async () => {
      server.respondWith({
        status: 200,
        body: {
          value: [
            {
              pullRequestId: 11,
              title: "Add widget",
              status: "active",
              sourceRefName: "refs/heads/feature/widget",
              targetRefName: "refs/heads/main",
              createdBy: { displayName: "Ada", uniqueName: "ada@x.com" },
              repository: {
                id: "repo-guid",
                name: "web",
                remoteUrl: "https://dev.azure.com/contoso/web/_git/web",
                webUrl: "https://dev.azure.com/contoso/web/_git/web",
              },
              url: "https://dev.azure.com/contoso/_apis/git/pullRequests/11",
            },
          ],
        },
      });
      const client = clientFor(server, { org: "contoso", project: "web" });

      const prs = await client.listPullRequests();

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/web/_apis/git/pullrequests?searchCriteria.status=active&api-version=${ADO_API_VERSION}`
      );
      expect(req.body).toBe("");
      expect(prs).toEqual([
        {
          pullRequestId: 11,
          title: "Add widget",
          status: "active",
          isDraft: false,
          sourceRefName: "refs/heads/feature/widget",
          targetRefName: "refs/heads/main",
          createdBy: { displayName: "Ada", uniqueName: "ada@x.com" },
          repository: {
            id: "repo-guid",
            name: "web",
            remoteUrl: "https://dev.azure.com/contoso/web/_git/web",
            webUrl: "https://dev.azure.com/contoso/web/_git/web",
            url: undefined,
          },
          url: "https://dev.azure.com/contoso/_apis/git/pullRequests/11",
        },
      ]);
    });

    it("percent-encodes org and project path segments", async () => {
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server, { org: "my org", project: "a/b" });

      await client.listPullRequests();

      expect(server.requests[0].url).toBe(
        `/my%20org/a%2Fb/_apis/git/pullrequests?searchCriteria.status=active&api-version=${ADO_API_VERSION}`
      );
    });

    it("returns [] and normalizes absent fields when there are no PRs", async () => {
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      expect(await client.listPullRequests()).toEqual([]);
    });

    it("normalizes a PR with missing fields to safe defaults", async () => {
      server.respondWith({ status: 200, body: { value: [{}] } });
      const client = clientFor(server);
      expect(await client.listPullRequests()).toEqual([
        {
          pullRequestId: 0,
          title: "",
          status: "",
          isDraft: false,
          sourceRefName: "",
          targetRefName: "",
          createdBy: "",
          repository: {
            id: undefined,
            name: undefined,
            remoteUrl: undefined,
            webUrl: undefined,
            url: undefined,
          },
          url: "",
        },
      ]);
    });
  });

  describe("getRepository", () => {
    it("GETs the project-scoped repository endpoint and returns the clone URL", async () => {
      server.respondWith({
        status: 200,
        body: {
          id: "repo-guid",
          name: "web",
          remoteUrl: "https://dev.azure.com/contoso/web/_git/web",
          webUrl: "https://dev.azure.com/contoso/web/_git/web",
        },
      });
      const client = clientFor(server, { org: "contoso", project: "web" });

      const repo = await client.getRepository("repo-guid");

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/web/_apis/git/repositories/repo-guid?api-version=${ADO_API_VERSION}`
      );
      expect(req.body).toBe("");
      expect(repo.remoteUrl).toBe("https://dev.azure.com/contoso/web/_git/web");
      expect(repo.name).toBe("web");
    });

    it("percent-encodes the repository id", async () => {
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server, { org: "o", project: "p" });

      await client.getRepository("a/b");

      expect(server.requests[0].url).toBe(
        `/o/p/_apis/git/repositories/a%2Fb?api-version=${ADO_API_VERSION}`
      );
    });
  });

  describe("error handling", () => {
    it("throws a typed ADOApiError carrying the envelope message on non-2xx", async () => {
      server.respondWith({
        status: 401,
        body: { message: "TF400813: unauthorized", typeKey: "UnauthorizedRequestException" },
      });
      const client = clientFor(server);

      await expect(client.runWiql("q")).rejects.toMatchObject({
        name: "ADOApiError",
        httpStatus: 401,
        message: "TF400813: unauthorized",
        typeKey: "UnauthorizedRequestException",
      });
      await expect(client.runWiql("q").catch((e) => e)).resolves.toBeInstanceOf(ADOApiError);
    });

    it("falls back to a status-derived message for a non-JSON error body", async () => {
      server.respondWith({ status: 503, body: "<html>down</html>" });
      const client = clientFor(server);
      await expect(client.getWorkItems([1])).rejects.toMatchObject({
        httpStatus: 503,
        message: "Azure DevOps request failed with HTTP 503",
      });
    });
  });

  describe("read-only surface", () => {
    it("exposes only the read operations and no write method", () => {
      const methods = Object.getOwnPropertyNames(ADOClient.prototype).filter(
        (n) => n !== "constructor"
      );
      const publicMethods = methods.filter((n) => !n.startsWith("_"));
      // Exactly the read operations — nothing that mutates external state.
      expect(new Set(publicMethods)).toEqual(
        new Set([
          "authHeader",
          "requestJson",
          "runWiql",
          "getWorkItems",
          "getWorkItemComments",
          "resolveMeIdentity",
          "listPullRequests",
          "getRepository",
        ])
      );
    });

    it("declares no method whose name implies a write operation", () => {
      const forbidden = /(create|update|patch|delete|post|put|write|mutat|set|add|remove|assign|transition|comment|save|edit)/i;
      // The vetted read operations are exempt: `getWorkItemComments` READS the
      // comment thread — the write-guard below still catches any other method
      // whose name (via its verb) implies a mutation.
      const readOps = new Set([
        "constructor",
        "authHeader",
        "requestJson",
        "runWiql",
        "getWorkItems",
        "getWorkItemComments",
        "resolveMeIdentity",
        "listPullRequests",
        "getRepository",
      ]);
      const names = Object.getOwnPropertyNames(ADOClient.prototype).filter(
        (n) => !readOps.has(n)
      );
      for (const name of names) {
        expect(name).not.toMatch(forbidden);
      }
    });

    it("never issues a PATCH or PUT request across any operation", async () => {
      server.respondWith({ status: 200, body: { workItems: [{ id: 1 }] } });
      server.respondWith({ status: 200, body: { value: [{ id: 1 }] } });
      server.respondWith({ status: 200, body: { comments: [] } });
      server.respondWith({ status: 200, body: { authenticatedUser: {} } });
      server.respondWith({ status: 200, body: { value: [] } });
      server.respondWith({ status: 200, body: { remoteUrl: "https://x" } });
      const client = clientFor(server);

      await client.runWiql("q");
      await client.getWorkItems([1]);
      await client.getWorkItemComments(1);
      await client.resolveMeIdentity();
      await client.listPullRequests();
      await client.getRepository("repo-1");

      const verbs = server.requests.map((r) => r.method);
      expect(verbs).not.toContain("PATCH");
      expect(verbs).not.toContain("PUT");
      expect(verbs).not.toContain("DELETE");
      // The only POST is the read-only WIQL query.
      expect(verbs.filter((v) => v === "POST")).toEqual(["POST"]);
    });
  });

  describe("defaults", () => {
    it("defaults the base URL to dev.azure.com", () => {
      expect(ADO_DEFAULT_BASE_URL).toBe("https://dev.azure.com");
    });
  });
});

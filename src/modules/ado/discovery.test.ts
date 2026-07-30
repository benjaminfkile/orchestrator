import http from "http";
import type { AddressInfo } from "net";

import { ADOApiError, ADO_API_VERSION } from "./client";
import {
  ADODiscoveryClient,
  ADO_VSSPS_BASE_URL,
  type ADOAccount,
  type ADOProject,
  type ADOWorkItemType,
  type ADOWorkItemState,
  type ADOIdentity,
} from "./discovery";
import * as discoveryModule from "./discovery";

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
 * A tiny in-process http server used as the Azure DevOps stand-in. Both the
 * vssps host and the dev.azure.com host point at this one server in tests; each
 * test queues one response per expected request and inspects what was received.
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
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

function clientFor(server: MockServer): ADODiscoveryClient {
  // Both hosts resolve to the single mock server.
  return new ADODiscoveryClient({
    baseUrl: server.baseUrl,
    vsspsBaseUrl: server.baseUrl,
  });
}

describe("ADODiscoveryClient", () => {
  let server: MockServer;

  beforeEach(async () => {
    server = new MockServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe("auth header", () => {
    it("sends the PAT as Basic auth (base64 of ':' + pat) on every request", async () => {
      // connectionData (member id) then accounts.
      server.respondWith({ status: 200, body: { authenticatedUser: { id: "abc" } } });
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      await client.listOrganizations("hunter2");

      const expected = `Basic ${Buffer.from(":hunter2").toString("base64")}`;
      expect(server.requests).toHaveLength(2);
      for (const req of server.requests) {
        expect(req.headers.authorization).toBe(expected);
        const decoded = Buffer.from(
          req.headers.authorization!.slice("Basic ".length),
          "base64"
        ).toString("utf8");
        expect(decoded).toBe(":hunter2");
      }
    });

    it("never puts the PAT in the request url or body", async () => {
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      await client.listProjects("contoso", "topsecret");

      expect(server.requests[0].url).not.toContain("topsecret");
      expect(server.requests[0].body).not.toContain("topsecret");
    });
  });

  describe("listOrganizations", () => {
    it("resolves the member id via connectionData, then GETs accounts by memberId", async () => {
      server.respondWith({
        status: 200,
        body: { authenticatedUser: { id: "member-123" } },
      });
      server.respondWith({
        status: 200,
        body: {
          value: [
            { accountName: "contoso", accountId: "x" },
            { accountName: "fabrikam" },
          ],
        },
      });
      const client = clientFor(server);

      const orgs = await client.listOrganizations("s3cr3t");

      const connReq = server.requests[0];
      expect(connReq.method).toBe("GET");
      expect(connReq.url).toBe("/_apis/connectionData");
      expect(connReq.body).toBe("");

      const acctReq = server.requests[1];
      expect(acctReq.method).toBe("GET");
      expect(acctReq.url).toBe(
        `/_apis/accounts?memberId=member-123&api-version=${ADO_API_VERSION}`
      );
      expect(acctReq.body).toBe("");

      // Only the accountName is projected out.
      const expected: ADOAccount[] = [
        { accountName: "contoso" },
        { accountName: "fabrikam" },
      ];
      expect(orgs).toEqual(expected);
    });

    it("url-encodes a member id that needs escaping", async () => {
      server.respondWith({
        status: 200,
        body: { authenticatedUser: { id: "a b/c" } },
      });
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      await client.listOrganizations("pat");

      expect(server.requests[1].url).toBe(
        `/_apis/accounts?memberId=a%20b%2Fc&api-version=${ADO_API_VERSION}`
      );
    });

    it("passes an empty memberId when connectionData omits the identity id", async () => {
      server.respondWith({ status: 200, body: {} });
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      const orgs = await client.listOrganizations("pat");

      expect(server.requests[1].url).toBe(
        `/_apis/accounts?memberId=&api-version=${ADO_API_VERSION}`
      );
      expect(orgs).toEqual([]);
    });

    it("normalizes rows missing accountName to an empty string", async () => {
      server.respondWith({ status: 200, body: { authenticatedUser: { id: "m" } } });
      server.respondWith({ status: 200, body: { value: [{}, { accountName: 7 }] } });
      const client = clientFor(server);

      expect(await client.listOrganizations("pat")).toEqual([
        { accountName: "" },
        { accountName: "" },
      ]);
    });

    it("returns [] when the accounts response has no value array", async () => {
      server.respondWith({ status: 200, body: { authenticatedUser: { id: "m" } } });
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      expect(await client.listOrganizations("pat")).toEqual([]);
    });
  });

  describe("listProjects", () => {
    it("GETs the org-scoped projects endpoint and returns names", async () => {
      server.respondWith({
        status: 200,
        body: {
          value: [
            { id: "1", name: "web" },
            { id: "2", name: "mobile" },
          ],
        },
      });
      const client = clientFor(server);

      const projects = await client.listProjects("contoso", "pat");

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/_apis/projects?api-version=${ADO_API_VERSION}`
      );
      expect(req.body).toBe("");

      const expected: ADOProject[] = [{ name: "web" }, { name: "mobile" }];
      expect(projects).toEqual(expected);
    });

    it("percent-encodes an org name with a space", async () => {
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      await client.listProjects("my org", "pat");

      expect(server.requests[0].url).toBe(
        `/my%20org/_apis/projects?api-version=${ADO_API_VERSION}`
      );
    });

    it("normalizes rows missing name and returns [] with no value array", async () => {
      server.respondWith({ status: 200, body: { value: [{}, { name: 5 }] } });
      const client = clientFor(server);
      expect(await client.listProjects("o", "pat")).toEqual([
        { name: "" },
        { name: "" },
      ]);

      server.respondWith({ status: 200, body: {} });
      expect(await client.listProjects("o", "pat")).toEqual([]);
    });
  });

  describe("listWorkItemTypes", () => {
    it("GETs the project-scoped workitemtypes endpoint and returns names", async () => {
      server.respondWith({
        status: 200,
        body: {
          value: [
            { name: "Bug", referenceName: "Microsoft.VSTS.WorkItemTypes.Bug" },
            { name: "Task" },
          ],
        },
      });
      const client = clientFor(server);

      const types = await client.listWorkItemTypes("contoso", "web", "pat");

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/web/_apis/wit/workitemtypes?api-version=${ADO_API_VERSION}`
      );
      expect(req.body).toBe("");

      const expected: ADOWorkItemType[] = [{ name: "Bug" }, { name: "Task" }];
      expect(types).toEqual(expected);
    });

    it("percent-encodes org and project segments", async () => {
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      await client.listWorkItemTypes("my org", "my proj", "pat");

      expect(server.requests[0].url).toBe(
        `/my%20org/my%20proj/_apis/wit/workitemtypes?api-version=${ADO_API_VERSION}`
      );
    });

    it("normalizes rows missing name and returns [] with no value array", async () => {
      server.respondWith({ status: 200, body: { value: [{}, { name: 9 }] } });
      const client = clientFor(server);
      expect(await client.listWorkItemTypes("o", "p", "pat")).toEqual([
        { name: "" },
        { name: "" },
      ]);

      server.respondWith({ status: 200, body: {} });
      expect(await client.listWorkItemTypes("o", "p", "pat")).toEqual([]);
    });
  });

  describe("listStates", () => {
    it("GETs the type's states sub-resource and returns names", async () => {
      server.respondWith({
        status: 200,
        body: {
          value: [
            { name: "New", color: "b2b2b2" },
            { name: "Active" },
            { name: "Closed" },
          ],
        },
      });
      const client = clientFor(server);

      const states = await client.listStates("contoso", "web", "Bug", "pat");

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/web/_apis/wit/workitemtypes/Bug/states?api-version=${ADO_API_VERSION}`
      );

      const expected: ADOWorkItemState[] = [
        { name: "New" },
        { name: "Active" },
        { name: "Closed" },
      ];
      expect(states).toEqual(expected);
    });

    it("percent-encodes a type name with a space", async () => {
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      await client.listStates("o", "p", "User Story", "pat");

      expect(server.requests[0].url).toBe(
        `/o/p/_apis/wit/workitemtypes/User%20Story/states?api-version=${ADO_API_VERSION}`
      );
    });

    it("falls back to deriving states from the type list on a 404", async () => {
      // states sub-resource unavailable...
      server.respondWith({ status: 404, body: { message: "not found" } });
      // ...so the full type list is read and the matching type projected.
      server.respondWith({
        status: 200,
        body: {
          value: [
            { name: "Task", states: [{ name: "To Do" }] },
            {
              name: "Bug",
              states: [{ name: "New" }, { name: "Done" }],
            },
          ],
        },
      });
      const client = clientFor(server);

      const states = await client.listStates("o", "p", "Bug", "pat");

      expect(server.requests[0].url).toBe(
        `/o/p/_apis/wit/workitemtypes/Bug/states?api-version=${ADO_API_VERSION}`
      );
      expect(server.requests[1].method).toBe("GET");
      expect(server.requests[1].url).toBe(
        `/o/p/_apis/wit/workitemtypes?api-version=${ADO_API_VERSION}`
      );
      expect(states).toEqual([{ name: "New" }, { name: "Done" }]);
    });

    it("returns [] from the fallback when no type name matches", async () => {
      server.respondWith({ status: 404, body: {} });
      server.respondWith({
        status: 200,
        body: { value: [{ name: "Task", states: [{ name: "To Do" }] }] },
      });
      const client = clientFor(server);

      expect(await client.listStates("o", "p", "Bug", "pat")).toEqual([]);
    });

    it("propagates non-404 errors without falling back", async () => {
      server.respondWith({
        status: 401,
        body: { message: "denied", typeKey: "UnauthorizedRequestException" },
      });
      const client = clientFor(server);

      await expect(
        client.listStates("o", "p", "Bug", "pat")
      ).rejects.toMatchObject({ name: "ADOApiError", httpStatus: 401 });
      // No second (fallback) request was issued.
      expect(server.requests).toHaveLength(1);
    });
  });

  describe("listAreaPaths / listIterations", () => {
    it("flattens the area tree into backslash-joined paths, root first", async () => {
      server.respondWith({
        status: 200,
        body: {
          name: "Contoso",
          children: [
            {
              name: "Web",
              children: [{ name: "Api" }, { name: "Ui" }],
            },
            { name: "Mobile" },
          ],
        },
      });
      const client = clientFor(server);

      const paths = await client.listAreaPaths("contoso", "web", "pat");

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/contoso/web/_apis/wit/classificationnodes/areas?$depth=10&api-version=${ADO_API_VERSION}`
      );
      expect(paths).toEqual([
        "Contoso",
        "Contoso\\Web",
        "Contoso\\Web\\Api",
        "Contoso\\Web\\Ui",
        "Contoso\\Mobile",
      ]);
    });

    it("hits the iterations node group for listIterations", async () => {
      server.respondWith({
        status: 200,
        body: {
          name: "Contoso",
          children: [{ name: "Sprint 1" }, { name: "Sprint 2" }],
        },
      });
      const client = clientFor(server);

      const paths = await client.listIterations("contoso", "web", "pat");

      expect(server.requests[0].url).toBe(
        `/contoso/web/_apis/wit/classificationnodes/iterations?$depth=10&api-version=${ADO_API_VERSION}`
      );
      expect(paths).toEqual([
        "Contoso",
        "Contoso\\Sprint 1",
        "Contoso\\Sprint 2",
      ]);
    });

    it("returns [] for an empty/name-less root node", async () => {
      // A name-less root contributes no path and does not extend the prefix, so
      // an empty `{}` tree flattens to nothing.
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      expect(await client.listAreaPaths("o", "p", "pat")).toEqual([]);
    });
  });

  describe("listIdentities", () => {
    it("reads teams then members, de-dupes, and filters by query", async () => {
      // teams
      server.respondWith({
        status: 200,
        body: { value: [{ id: "team-a" }, { id: "team-b" }] },
      });
      // team-a members
      server.respondWith({
        status: 200,
        body: {
          value: [
            { identity: { displayName: "Ada Lovelace", uniqueName: "ada@x.io" } },
            { identity: { displayName: "Bob Stone", uniqueName: "bob@x.io" } },
          ],
        },
      });
      // team-b members (Ada repeats; Cara is new)
      server.respondWith({
        status: 200,
        body: {
          value: [
            { identity: { displayName: "Ada Lovelace", uniqueName: "ada@x.io" } },
            { identity: { displayName: "Cara Vale", uniqueName: "cara@x.io" } },
          ],
        },
      });
      const client = clientFor(server);

      const matches = await client.listIdentities("contoso", "web", "pat", "a");

      expect(server.requests[0].url).toBe(
        `/contoso/_apis/projects/web/teams?api-version=${ADO_API_VERSION}`
      );
      expect(server.requests[1].url).toBe(
        `/contoso/_apis/projects/web/teams/team-a/members?api-version=${ADO_API_VERSION}`
      );
      expect(server.requests[2].url).toBe(
        `/contoso/_apis/projects/web/teams/team-b/members?api-version=${ADO_API_VERSION}`
      );

      // "a" (case-insensitive) matches Ada and Cara; Bob is excluded; Ada dedupes.
      const expected: ADOIdentity[] = [
        { displayName: "Ada Lovelace", uniqueName: "ada@x.io" },
        { displayName: "Cara Vale", uniqueName: "cara@x.io" },
      ];
      expect(matches).toEqual(expected);
    });

    it("returns every member (deduped) when the query is empty", async () => {
      server.respondWith({ status: 200, body: { value: [{ id: "t" }] } });
      server.respondWith({
        status: 200,
        body: {
          value: [
            { identity: { displayName: "Ada", uniqueName: "ada@x.io" } },
            { identity: { displayName: "Bob", uniqueName: "bob@x.io" } },
          ],
        },
      });
      const client = clientFor(server);

      expect(await client.listIdentities("o", "web", "pat", "  ")).toEqual([
        { displayName: "Ada", uniqueName: "ada@x.io" },
        { displayName: "Bob", uniqueName: "bob@x.io" },
      ]);
    });

    it("matches on displayName as well as uniqueName", async () => {
      server.respondWith({ status: 200, body: { value: [{ id: "t" }] } });
      server.respondWith({
        status: 200,
        body: {
          value: [
            { identity: { displayName: "Grace Hopper", uniqueName: "gh@x.io" } },
            { identity: { displayName: "Ada", uniqueName: "ada@x.io" } },
          ],
        },
      });
      const client = clientFor(server);

      expect(
        await client.listIdentities("o", "web", "pat", "hopper")
      ).toEqual([{ displayName: "Grace Hopper", uniqueName: "gh@x.io" }]);
    });

    it("normalizes members missing an identity and issues no member request for no teams", async () => {
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);
      expect(await client.listIdentities("o", "web", "pat", "x")).toEqual([]);
      expect(server.requests).toHaveLength(1);

      server.respondWith({ status: 200, body: { value: [{ id: "t" }] } });
      server.respondWith({
        status: 200,
        body: { value: [{}, { identity: { displayName: "N" } }] },
      });
      // A member with neither name is dropped (blank key); the display-only one stays.
      expect(await client.listIdentities("o", "web", "pat", "")).toEqual([
        { displayName: "N", uniqueName: "" },
      ]);
    });
  });

  describe("error handling", () => {
    it("throws a typed ADOApiError carrying the envelope message on non-2xx", async () => {
      server.respondWith({
        status: 401,
        body: { message: "TF400813: unauthorized", typeKey: "UnauthorizedRequestException" },
      });
      const client = clientFor(server);

      await expect(client.listProjects("o", "pat")).rejects.toMatchObject({
        name: "ADOApiError",
        httpStatus: 401,
        message: "TF400813: unauthorized",
        typeKey: "UnauthorizedRequestException",
      });
      await expect(
        client.listProjects("o", "pat").catch((e) => e)
      ).resolves.toBeInstanceOf(ADOApiError);
    });
  });

  describe("read-only surface", () => {
    it("issues only GET requests across every discovery read", async () => {
      // listOrganizations: connectionData + accounts.
      server.respondWith({ status: 200, body: { authenticatedUser: { id: "m" } } });
      server.respondWith({ status: 200, body: { value: [] } });
      // listProjects.
      server.respondWith({ status: 200, body: { value: [] } });
      // listWorkItemTypes.
      server.respondWith({ status: 200, body: { value: [] } });
      // listStates.
      server.respondWith({ status: 200, body: { value: [] } });
      // listAreaPaths + listIterations (root node each).
      server.respondWith({ status: 200, body: { name: "P" } });
      server.respondWith({ status: 200, body: { name: "P" } });
      // listIdentities: teams (empty → no member requests).
      server.respondWith({ status: 200, body: { value: [] } });
      const client = clientFor(server);

      await client.listOrganizations("pat");
      await client.listProjects("o", "pat");
      await client.listWorkItemTypes("o", "p", "pat");
      await client.listStates("o", "p", "Bug", "pat");
      await client.listAreaPaths("o", "p", "pat");
      await client.listIterations("o", "p", "pat");
      await client.listIdentities("o", "p", "pat", "");

      const verbs = server.requests.map((r) => r.method);
      expect(new Set(verbs)).toEqual(new Set(["GET"]));
      expect(verbs).not.toContain("POST");
      expect(verbs).not.toContain("PATCH");
      expect(verbs).not.toContain("PUT");
      expect(verbs).not.toContain("DELETE");
    });

    it("exports no method or symbol whose name implies a write operation", () => {
      const forbidden =
        /(create|update|patch|delete|post|put|write|mutat|^set|add|remove|assign|transition|comment|save|edit)/i;

      const methods = Object.getOwnPropertyNames(
        ADODiscoveryClient.prototype
      ).filter((n) => n !== "constructor");
      for (const name of methods) {
        expect(name).not.toMatch(forbidden);
      }

      // No write-implying named export on the discovery module either.
      for (const name of Object.keys(discoveryModule)) {
        expect(name).not.toMatch(forbidden);
      }
    });

    it("only reads: the list* methods are the whole public surface", () => {
      const publicMethods = Object.getOwnPropertyNames(
        ADODiscoveryClient.prototype
      ).filter((n) => n !== "constructor" && !n.startsWith("resolve"));
      expect(new Set(publicMethods)).toEqual(
        new Set([
          "listOrganizations",
          "listProjects",
          "listWorkItemTypes",
          "listStates",
          "listAreaPaths",
          "listIterations",
          "listIdentities",
        ])
      );
    });
  });

  describe("defaults", () => {
    it("defaults the vssps base URL to app.vssps.visualstudio.com", () => {
      expect(ADO_VSSPS_BASE_URL).toBe("https://app.vssps.visualstudio.com");
    });
  });
});

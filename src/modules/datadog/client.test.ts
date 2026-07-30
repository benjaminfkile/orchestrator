import http from "http";
import type { AddressInfo } from "net";

import {
  DatadogApiError,
  DatadogClient,
  DATADOG_MAX_LOG_QUERY_LIMIT,
  DATADOG_MAX_SAMPLE_LIMIT,
  DATADOG_MESSAGE_MAX_LENGTH,
  resolveDatadogApiBaseUrl,
  resolveDatadogAppBaseUrl,
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
 * A tiny in-process http server used as the Datadog stand-in. Each test queues
 * one response per expected request and inspects what was received — method,
 * path, query, auth headers, and body. No test ever calls Datadog.
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

function clientFor(
  server: MockServer,
  over: Partial<{ apiKey: string; appKey: string }> = {}
) {
  return new DatadogClient({
    apiKey: over.apiKey ?? "dd-api-key",
    appKey: over.appKey ?? "dd-app-key",
    baseUrl: server.baseUrl,
  });
}

describe("site resolution", () => {
  it("derives the API base from a bare site domain", () => {
    expect(resolveDatadogApiBaseUrl()).toBe("https://api.datadoghq.com");
    expect(resolveDatadogApiBaseUrl("datadoghq.com")).toBe(
      "https://api.datadoghq.com"
    );
    expect(resolveDatadogApiBaseUrl("datadoghq.eu")).toBe(
      "https://api.datadoghq.eu"
    );
    expect(resolveDatadogApiBaseUrl("us5.datadoghq.com")).toBe(
      "https://api.us5.datadoghq.com"
    );
  });

  it("tolerates an accidental scheme or trailing slash on the site", () => {
    expect(resolveDatadogApiBaseUrl("https://us3.datadoghq.com/")).toBe(
      "https://api.us3.datadoghq.com"
    );
  });

  it("derives the web-app base for monitor URLs per site family", () => {
    // Primary sites carry no region subdomain → app.<site>.
    expect(resolveDatadogAppBaseUrl("datadoghq.com")).toBe(
      "https://app.datadoghq.com"
    );
    expect(resolveDatadogAppBaseUrl("datadoghq.eu")).toBe(
      "https://app.datadoghq.eu"
    );
    // Regionalized sites serve the app from the site host itself.
    expect(resolveDatadogAppBaseUrl("us5.datadoghq.com")).toBe(
      "https://us5.datadoghq.com"
    );
  });
});

describe("DatadogClient", () => {
  let server: MockServer;

  beforeEach(async () => {
    server = new MockServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe("auth headers", () => {
    it("sends both keys as DD-API-KEY / DD-APPLICATION-KEY headers", async () => {
      server.respondWith({ status: 200, body: { data: { buckets: [] } } });
      const client = clientFor(server, { apiKey: "api-123", appKey: "app-456" });

      await client.aggregateLogs({
        query: "service:web",
        from: "now-15m",
        to: "now",
        groupBy: "service",
      });

      const headers = server.requests[0].headers;
      expect(headers["dd-api-key"]).toBe("api-123");
      expect(headers["dd-application-key"]).toBe("app-456");
    });

    it("never puts either key in the request url or body", async () => {
      server.respondWith({ status: 200, body: { data: [] } });
      const client = clientFor(server, {
        apiKey: "secret-api",
        appKey: "secret-app",
      });

      await client.searchLogs({ query: "*", from: "now-1m", to: "now" });

      expect(server.requests[0].url).not.toContain("secret-api");
      expect(server.requests[0].url).not.toContain("secret-app");
      expect(server.requests[0].body).not.toContain("secret-api");
      expect(server.requests[0].body).not.toContain("secret-app");
    });
  });

  describe("aggregateLogs", () => {
    it("POSTs a single count compute grouped by one facet and maps buckets", async () => {
      server.respondWith({
        status: 200,
        body: {
          data: {
            buckets: [
              { by: { service: "web" }, computes: { c0: 42 } },
              { by: { service: "api" }, computes: { c0: 7 } },
            ],
          },
        },
      });
      const client = clientFor(server);

      const result = await client.aggregateLogs({
        query: "status:error",
        from: "now-15m",
        to: "now",
        groupBy: "service",
        limit: 25,
      });

      const req = server.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v2/logs/analytics/aggregate");
      const sent = JSON.parse(req.body);
      expect(sent.data.attributes.compute).toEqual([
        { aggregation: "count", type: "total" },
      ]);
      expect(sent.data.attributes.filter).toEqual({
        query: "status:error",
        from: "now-15m",
        to: "now",
      });
      expect(sent.data.attributes.group_by).toEqual([
        { facet: "service", limit: 25 },
      ]);

      expect(result).toEqual([
        { group: "web", count: 42 },
        { group: "api", count: 7 },
      ]);
    });

    it("coerces from/to numbers to strings and defaults the group limit", async () => {
      server.respondWith({ status: 200, body: { data: { buckets: [] } } });
      const client = clientFor(server);

      await client.aggregateLogs({
        query: "*",
        from: 1000,
        to: 2000,
        groupBy: "host",
      });

      const sent = JSON.parse(server.requests[0].body);
      expect(sent.data.attributes.filter.from).toBe("1000");
      expect(sent.data.attributes.filter.to).toBe("2000");
      expect(sent.data.attributes.group_by[0].limit).toBe(100);
    });

    it("reads the count from any compute alias and tolerates a missing facet", async () => {
      server.respondWith({
        status: 200,
        body: {
          data: {
            buckets: [
              { by: {}, computes: { c3: 5 } },
              { computes: {} },
            ],
          },
        },
      });
      const client = clientFor(server);

      const result = await client.aggregateLogs({
        query: "*",
        from: "now-5m",
        to: "now",
        groupBy: "service",
      });

      expect(result).toEqual([
        { group: "", count: 5 },
        { group: "", count: 0 },
      ]);
    });

    it("yields [] when the response has no buckets", async () => {
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      const result = await client.aggregateLogs({
        query: "*",
        from: "now-5m",
        to: "now",
        groupBy: "service",
      });
      expect(result).toEqual([]);
    });
  });

  describe("searchLogs", () => {
    it("POSTs newest-first with a bounded page limit and maps events", async () => {
      server.respondWith({
        status: 200,
        body: {
          data: [
            {
              attributes: {
                timestamp: "2026-07-19T00:00:00Z",
                status: "error",
                service: "web",
                message: "boom",
              },
            },
          ],
        },
      });
      const client = clientFor(server);

      const result = await client.searchLogs({
        query: "status:error",
        from: "now-15m",
        to: "now",
        limit: 5,
      });

      const req = server.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v2/logs/events/search");
      const sent = JSON.parse(req.body);
      expect(sent.sort).toBe("-timestamp");
      expect(sent.page).toEqual({ limit: 5 });
      expect(sent.filter).toEqual({
        query: "status:error",
        from: "now-15m",
        to: "now",
      });

      expect(result).toEqual([
        {
          timestamp: "2026-07-19T00:00:00Z",
          status: "error",
          service: "web",
          message: "boom",
        },
      ]);
    });

    it("clamps a too-large limit down to the hard cap", async () => {
      server.respondWith({ status: 200, body: { data: [] } });
      const client = clientFor(server);

      await client.searchLogs({
        query: "*",
        from: "now-1m",
        to: "now",
        limit: 1000,
      });

      const sent = JSON.parse(server.requests[0].body);
      expect(sent.page.limit).toBe(DATADOG_MAX_SAMPLE_LIMIT);
    });

    it("clamps a zero/negative limit up to 1 and defaults when unset", async () => {
      server.respondWith({ status: 200, body: { data: [] } });
      server.respondWith({ status: 200, body: { data: [] } });
      const client = clientFor(server);

      await client.searchLogs({ query: "*", from: "a", to: "b", limit: 0 });
      expect(JSON.parse(server.requests[0].body).page.limit).toBe(1);

      await client.searchLogs({ query: "*", from: "a", to: "b" });
      expect(JSON.parse(server.requests[1].body).page.limit).toBe(
        DATADOG_MAX_SAMPLE_LIMIT
      );
    });

    it("truncates a long message to the max length plus an ellipsis", async () => {
      const long = "x".repeat(DATADOG_MESSAGE_MAX_LENGTH + 200);
      server.respondWith({
        status: 200,
        body: { data: [{ attributes: { message: long } }] },
      });
      const client = clientFor(server);

      const [sample] = await client.searchLogs({
        query: "*",
        from: "a",
        to: "b",
      });

      expect(sample.message.length).toBe(DATADOG_MESSAGE_MAX_LENGTH + 1);
      expect(sample.message.endsWith("…")).toBe(true);
      expect(sample.message.slice(0, DATADOG_MESSAGE_MAX_LENGTH)).toBe(
        "x".repeat(DATADOG_MESSAGE_MAX_LENGTH)
      );
    });

    it("normalizes missing attributes to empty strings", async () => {
      server.respondWith({ status: 200, body: { data: [{}] } });
      const client = clientFor(server);

      const [sample] = await client.searchLogs({
        query: "*",
        from: "a",
        to: "b",
      });

      expect(sample).toEqual({
        timestamp: "",
        status: "",
        service: "",
        message: "",
      });
    });
  });

  describe("queryLogs", () => {
    it("hits the same search endpoint and maps events", async () => {
      server.respondWith({
        status: 200,
        body: {
          data: [
            {
              attributes: {
                timestamp: "2026-07-19T00:00:00Z",
                status: "error",
                service: "api",
                message: "boom",
              },
            },
          ],
        },
      });
      const client = clientFor(server);

      const logs = await client.queryLogs({ query: "status:error", from: 1, to: 2 });

      expect(server.requests[0].method).toBe("POST");
      expect(server.requests[0].url).toContain("/api/v2/logs/events/search");
      expect(logs).toEqual([
        {
          timestamp: "2026-07-19T00:00:00Z",
          status: "error",
          service: "api",
          message: "boom",
        },
      ]);
    });

    it("clamps to the higher query cap (50), not the sample cap (25)", async () => {
      server.respondWith({ status: 200, body: { data: [] } });
      const client = clientFor(server);

      await client.queryLogs({ query: "*", from: "a", to: "b", limit: 1000 });

      const sent = JSON.parse(server.requests[0].body);
      expect(sent.page.limit).toBe(DATADOG_MAX_LOG_QUERY_LIMIT);
      expect(DATADOG_MAX_LOG_QUERY_LIMIT).toBe(50);
    });
  });

  describe("listMonitorStates", () => {
    it("GETs with group_states=all and no tag filter by default", async () => {
      server.respondWith({ status: 200, body: [] });
      const client = clientFor(server);

      await client.listMonitorStates();

      const req = server.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toContain("/api/v1/monitor?");
      expect(req.url).toContain("group_states=all");
      expect(req.url).not.toContain("monitor_tags");
    });

    it("passes a comma-joined monitor_tags filter", async () => {
      server.respondWith({ status: 200, body: [] });
      const client = clientFor(server);

      await client.listMonitorStates({ monitorTags: ["team:core", "env:prod"] });

      const url = server.requests[0].url ?? "";
      const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      expect(query.get("monitor_tags")).toBe("team:core,env:prod");
    });

    it("maps monitors, flattens group states, and synthesizes a URL", async () => {
      // A regionalized site serves the app from the site host itself.
      const client = new DatadogClient({
        apiKey: "k",
        appKey: "k",
        site: "us5.datadoghq.com",
        baseUrl: server.baseUrl,
      });
      server.respondWith({
        status: 200,
        body: [
          {
            id: 12345,
            name: "High error rate",
            query: "avg(last_5m):sum:errors{*} > 100",
            overall_state: "Alert",
            state: {
              groups: {
                "host:web-01": { name: "host:web-01", status: "Alert" },
                "host:web-02": { status: "OK" },
              },
            },
          },
        ],
      });

      const [monitor] = await client.listMonitorStates();

      expect(monitor.id).toBe(12345);
      expect(monitor.name).toBe("High error rate");
      expect(monitor.query).toBe("avg(last_5m):sum:errors{*} > 100");
      expect(monitor.overall_state).toBe("Alert");
      expect(monitor.groups).toEqual([
        { group: "host:web-01", state: "Alert" },
        // Falls back to the map key when the group object omits `name`.
        { group: "host:web-02", state: "OK" },
      ]);
      expect(monitor.url).toBe("https://us5.datadoghq.com/monitors/12345");
    });

    it("yields [] when the response is not an array", async () => {
      server.respondWith({ status: 200, body: {} });
      const client = clientFor(server);
      expect(await client.listMonitorStates()).toEqual([]);
    });
  });

  describe("getMonitor", () => {
    it("GETs one monitor by id and maps definition + thresholds + options + states", async () => {
      const client = new DatadogClient({
        apiKey: "k",
        appKey: "k",
        site: "datadoghq.com",
        baseUrl: server.baseUrl,
      });
      server.respondWith({
        status: 200,
        body: {
          id: 999,
          name: "High error rate",
          type: "metric alert",
          query: "avg(last_5m):sum:errors{*} > 100",
          tags: ["team:core", "env:prod"],
          overall_state: "Alert",
          options: {
            thresholds: { critical: 100, warning: 50 },
            notify_no_data: true,
            no_data_timeframe: 20,
            // A non-whitelisted option is dropped.
            silenced: {},
          },
          state: {
            groups: {
              "host:web-01": { name: "host:web-01", status: "Alert" },
            },
          },
        },
      });

      const monitor = await client.getMonitor(999);

      expect(server.requests[0].method).toBe("GET");
      expect(server.requests[0].url).toBe("/api/v1/monitor/999?group_states=all");
      expect(monitor).toEqual({
        id: 999,
        name: "High error rate",
        type: "metric alert",
        query: "avg(last_5m):sum:errors{*} > 100",
        tags: ["team:core", "env:prod"],
        overall_state: "Alert",
        thresholds: { critical: 100, warning: 50 },
        options: { notify_no_data: true, no_data_timeframe: 20 },
        groups: [{ group: "host:web-01", state: "Alert" }],
        url: "https://app.datadoghq.com/monitors/999",
      });
    });

    it("tolerates a monitor with no options/tags/groups", async () => {
      const client = clientFor(server);
      server.respondWith({
        status: 200,
        body: { id: 1, name: "n", query: "q", overall_state: "OK" },
      });

      const monitor = await client.getMonitor(1);

      expect(monitor.type).toBe("");
      expect(monitor.tags).toEqual([]);
      expect(monitor.thresholds).toEqual({});
      expect(monitor.options).toEqual({});
      expect(monitor.groups).toEqual([]);
    });

    it("throws a typed error for an unknown monitor id (404)", async () => {
      server.respondWith({ status: 404, body: { errors: ["Monitor not found"] } });
      const client = clientFor(server);
      await expect(client.getMonitor(42)).rejects.toMatchObject({
        httpStatus: 404,
        message: "Monitor not found",
      });
    });
  });

  describe("errors", () => {
    it("throws a typed DatadogApiError with the envelope message on non-2xx", async () => {
      server.respondWith({
        status: 403,
        body: { errors: ["Forbidden", "bad key"] },
      });
      const client = clientFor(server);

      await expect(
        client.searchLogs({ query: "*", from: "a", to: "b" })
      ).rejects.toMatchObject({
        name: "DatadogApiError",
        httpStatus: 403,
        message: "Forbidden; bad key",
      });
    });

    it("flags a 429 as rateLimited rather than crashing hard", async () => {
      server.respondWith({ status: 429, body: { errors: ["rate limited"] } });
      const client = clientFor(server);

      let caught: unknown;
      try {
        await client.aggregateLogs({
          query: "*",
          from: "a",
          to: "b",
          groupBy: "service",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DatadogApiError);
      expect((caught as DatadogApiError).rateLimited).toBe(true);
      expect((caught as DatadogApiError).httpStatus).toBe(429);
    });

    it("falls back to a status-derived message on a non-JSON error body", async () => {
      server.respondWith({ status: 502, body: "<html>bad gateway</html>" });
      const client = clientFor(server);

      await expect(
        client.listMonitorStates()
      ).rejects.toMatchObject({
        httpStatus: 502,
        message: "Datadog request failed with HTTP 502",
      });
    });

    it("aborts to a typed timeout error when the request is too slow", async () => {
      // A server that never answers; a short client timeout must abort it.
      const slow = http.createServer(() => {
        /* intentionally never responds */
      });
      await new Promise<void>((resolve) =>
        slow.listen(0, "127.0.0.1", resolve)
      );
      const { port } = slow.address() as AddressInfo;
      const client = new DatadogClient({
        apiKey: "k",
        appKey: "k",
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 50,
      });

      await expect(
        client.searchLogs({ query: "*", from: "a", to: "b" })
      ).rejects.toMatchObject({ name: "DatadogApiError", httpStatus: 0 });

      await new Promise<void>((resolve, reject) =>
        slow.close((err) => (err ? reject(err) : resolve()))
      );
    });
  });
});

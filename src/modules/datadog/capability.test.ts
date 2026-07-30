import type { CapabilityEvent } from "../registry";

import type {
  DatadogClientOptions,
  DatadogLogSample,
  DatadogMonitorDefinition,
} from "./client";
import {
  createGetMonitorCapability,
  createQueryLogsCapability,
  DATADOG_GET_MONITOR_CAPABILITY_ID,
  DATADOG_QUERY_LOGS_CAPABILITY_ID,
  DATADOG_QUERY_LOGS_MAX_LIMIT,
  DATADOG_QUERY_LOGS_MAX_WINDOW_SECONDS,
  DATADOG_QUERY_LOGS_MESSAGE_MAX,
  type DatadogGetMonitorClientFactory,
  type DatadogQueryLogsClientFactory,
} from "./capability";

/* -------------------------------------------------------------------------- *
 * Shared fixtures
 * -------------------------------------------------------------------------- */

const BASE_CONN = {
  site: "datadoghq.com",
  api_key_secret_ref: "DD_API_KEY",
  app_key_secret_ref: "DD_APP_KEY",
};

/** A log-alert event whose payload seeds the query_logs defaults. */
function logEvent(over: Record<string, unknown> = {}): CapabilityEvent {
  return {
    source: "datadog",
    type: "datadog.logs.alert",
    subject_ref: "errors-by-service/api",
    payload: {
      watch: "errors-by-service",
      query: "status:error",
      group_by: "service",
      group: "api",
      window_start: 1_000_000,
      window_end: 1_900_000,
      ...over,
    },
  };
}

/** A monitor-transition event whose subject_ref is the monitor id. */
function monitorEvent(over: Record<string, unknown> = {}): CapabilityEvent {
  return {
    source: "datadog",
    type: "datadog.monitor.transition",
    subject_ref: "999",
    payload: { monitor_id: 999, from_state: "OK", to_state: "Alert", ...over },
  };
}

/** A fake queryLogs client that records every call and returns queued logs. */
class FakeQueryClient {
  readonly calls: Array<{
    query: string;
    from: number | string;
    to: number | string;
    limit?: number;
  }> = [];

  constructor(
    private readonly logs: DatadogLogSample[] = [],
    private readonly err?: Error
  ) {}

  async queryLogs(params: {
    query: string;
    from: number | string;
    to: number | string;
    limit?: number;
  }): Promise<DatadogLogSample[]> {
    this.calls.push(params);
    if (this.err) throw this.err;
    return this.logs;
  }
}

/** A fake getMonitor client that records the ids it was asked for. */
class FakeMonitorClient {
  readonly calls: number[] = [];

  constructor(
    private readonly monitor?: DatadogMonitorDefinition,
    private readonly err?: Error
  ) {}

  async getMonitor(id: number): Promise<DatadogMonitorDefinition> {
    this.calls.push(id);
    if (this.err) throw this.err;
    return this.monitor as DatadogMonitorDefinition;
  }
}

function sample(over: Partial<DatadogLogSample> = {}): DatadogLogSample {
  return {
    timestamp: "2026-07-19T00:00:00Z",
    status: "error",
    service: "api",
    message: "boom",
    ...over,
  };
}

function monitor(
  over: Partial<DatadogMonitorDefinition> = {}
): DatadogMonitorDefinition {
  return {
    id: 999,
    name: "High error rate",
    type: "metric alert",
    query: "avg(last_5m):sum:errors{*} > 100",
    overall_state: "Alert",
    tags: ["team:core"],
    thresholds: { critical: 100, warning: 50 },
    options: { notify_no_data: true },
    groups: [
      { group: "host:web-01", state: "Alert" },
      { group: "host:web-02", state: "OK" },
    ],
    url: "https://app.datadoghq.com/monitors/999",
    ...over,
  };
}

/* -------------------------------------------------------------------------- *
 * datadog.query_logs
 * -------------------------------------------------------------------------- */

describe("createQueryLogsCapability", () => {
  function build(
    client: FakeQueryClient,
    over: {
      resolveSecret?: (ref: string) => Promise<string | undefined>;
      now?: () => number;
    } = {}
  ) {
    const seenOptions: DatadogClientOptions[] = [];
    const clientFactory: DatadogQueryLogsClientFactory = (opts) => {
      seenOptions.push(opts);
      return client;
    };
    const cap = createQueryLogsCapability({
      resolveSecret: over.resolveSecret ?? (async (ref) => `${ref}-v`),
      clientFactory,
      now: over.now ?? (() => 5_000_000),
    });
    return { cap, seenOptions };
  }

  it("has the stable capability id", () => {
    const { cap } = build(new FakeQueryClient());
    expect(cap.id).toBe(DATADOG_QUERY_LOGS_CAPABILITY_ID);
    expect(DATADOG_QUERY_LOGS_CAPABILITY_ID).toBe("datadog.query_logs");
  });

  it("defaults query (scoped to the group) and window from the event payload", async () => {
    const client = new FakeQueryClient([sample()]);
    const { cap, seenOptions } = build(client);

    const result = await cap.fetch(BASE_CONN, "errors-by-service/api", {
      event: logEvent(),
    });

    // Query is the event query scoped to the tripped group; the window is the
    // event's own window, verbatim; the default limit is 20.
    expect(client.calls).toEqual([
      {
        query: "status:error service:api",
        from: 1_000_000,
        to: 1_900_000,
        limit: 20,
      },
    ]);
    // The client is built from the (module) connection config.
    expect(seenOptions[0]).toEqual({
      apiKey: "DD_API_KEY-v",
      appKey: "DD_APP_KEY-v",
      site: "datadoghq.com",
    });
    expect(result.label).toBe("Datadog logs");
    expect(result.content).toContain("Query: status:error service:api");
    expect(result.content).toContain("Fetched: 1 log line(s)");
    expect(result.content).toContain("[2026-07-19T00:00:00Z] error api: boom");
  });

  it("renders a configured query template against the event", async () => {
    const client = new FakeQueryClient([]);
    const { cap } = build(client);

    await cap.fetch(
      { ...BASE_CONN, query: "service:{{payload.group}} status:error" },
      "errors-by-service/api",
      { event: logEvent() }
    );

    expect(client.calls[0].query).toBe("service:api status:error");
  });

  it("enforces the hard limit cap regardless of config", async () => {
    const client = new FakeQueryClient([]);
    const { cap } = build(client);

    await cap.fetch({ ...BASE_CONN, limit: 999 }, "s", { event: logEvent() });

    expect(client.calls[0].limit).toBe(DATADOG_QUERY_LOGS_MAX_LIMIT);
    expect(DATADOG_QUERY_LOGS_MAX_LIMIT).toBe(50);
  });

  it("caps a configured window and computes it as a lookback from now", async () => {
    const client = new FakeQueryClient([]);
    const { cap } = build(client, { now: () => 5_000_000 });

    await cap.fetch(
      { ...BASE_CONN, window_seconds: 999_999 },
      "s",
      { event: logEvent() }
    );

    const call = client.calls[0];
    expect(call.to).toBe(5_000_000);
    expect(call.from).toBe(
      5_000_000 - DATADOG_QUERY_LOGS_MAX_WINDOW_SECONDS * 1000
    );
  });

  it("falls back to a 15m lookback when neither config nor event has a window", async () => {
    const client = new FakeQueryClient([]);
    const { cap } = build(client, { now: () => 5_000_000 });

    await cap.fetch(
      { ...BASE_CONN, query: "status:error" },
      "s",
      // No event → no payload window.
      {}
    );

    const call = client.calls[0];
    expect(call.to).toBe(5_000_000);
    expect(call.from).toBe(5_000_000 - 900 * 1000);
  });

  it("truncates a long log message in the rendered block", async () => {
    const long = "x".repeat(DATADOG_QUERY_LOGS_MESSAGE_MAX + 50);
    const client = new FakeQueryClient([sample({ message: long })]);
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "s", { event: logEvent() });

    expect(result.content).toContain(
      `${"x".repeat(DATADOG_QUERY_LOGS_MESSAGE_MAX)}…`
    );
    expect(result.content).not.toContain("x".repeat(DATADOG_QUERY_LOGS_MESSAGE_MAX + 1));
  });

  it("renders an unavailable note (not a throw) when a key secret is missing", async () => {
    const client = new FakeQueryClient([]);
    const { cap } = build(client, { resolveSecret: async () => undefined });

    const result = await cap.fetch(BASE_CONN, "s", { event: logEvent() });

    expect(client.calls).toEqual([]);
    expect(result.content).toContain(
      `capability ${DATADOG_QUERY_LOGS_CAPABILITY_ID} unavailable`
    );
    expect(result.content).toContain("Datadog API key secret unavailable");
  });

  it("renders an unavailable note when no query is configured and the event has none", async () => {
    const client = new FakeQueryClient([]);
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "s", {});

    expect(client.calls).toEqual([]);
    expect(result.content).toContain("no query configured");
  });

  it("renders an unavailable note when the fetch throws", async () => {
    const client = new FakeQueryClient([], new Error("429 rate limited"));
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "s", { event: logEvent() });

    expect(result.content).toContain(
      `capability ${DATADOG_QUERY_LOGS_CAPABILITY_ID} unavailable: 429 rate limited`
    );
  });
});

/* -------------------------------------------------------------------------- *
 * datadog.get_monitor
 * -------------------------------------------------------------------------- */

describe("createGetMonitorCapability", () => {
  function build(
    client: FakeMonitorClient,
    over: { resolveSecret?: (ref: string) => Promise<string | undefined> } = {}
  ) {
    const seenOptions: DatadogClientOptions[] = [];
    const clientFactory: DatadogGetMonitorClientFactory = (opts) => {
      seenOptions.push(opts);
      return client;
    };
    const cap = createGetMonitorCapability({
      resolveSecret: over.resolveSecret ?? (async (ref) => `${ref}-v`),
      clientFactory,
    });
    return { cap, seenOptions };
  }

  it("has the stable capability id", () => {
    const { cap } = build(new FakeMonitorClient(monitor()));
    expect(cap.id).toBe(DATADOG_GET_MONITOR_CAPABILITY_ID);
    expect(DATADOG_GET_MONITOR_CAPABILITY_ID).toBe("datadog.get_monitor");
  });

  it("fetches the monitor from the event subject and renders its definition + states", async () => {
    const client = new FakeMonitorClient(monitor());
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "999", { event: monitorEvent() });

    expect(client.calls).toEqual([999]);
    expect(result.label).toBe("Datadog monitor 999");
    expect(result.content).toContain("Name: High error rate");
    expect(result.content).toContain("Type: metric alert");
    expect(result.content).toContain("Query: avg(last_5m):sum:errors{*} > 100");
    expect(result.content).toContain("Overall state: Alert");
    expect(result.content).toContain("- critical: 100");
    expect(result.content).toContain("- warning: 50");
    expect(result.content).toContain("- notify_no_data: true");
    expect(result.content).toContain("Group states (2):");
    expect(result.content).toContain("- host:web-01: Alert");
    expect(result.content).toContain("- host:web-02: OK");
    expect(result.content).toContain("URL: https://app.datadoghq.com/monitors/999");
  });

  it("prefers an explicitly configured monitor_id over the event subject", async () => {
    const client = new FakeMonitorClient(monitor({ id: 5 }));
    const { cap } = build(client);

    await cap.fetch({ ...BASE_CONN, monitor_id: 5 }, "999", {
      event: monitorEvent(),
    });

    expect(client.calls).toEqual([5]);
  });

  it("falls back to payload.monitor_id when the subject is not a numeric id", async () => {
    const client = new FakeMonitorClient(monitor({ id: 7 }));
    const { cap } = build(client);

    await cap.fetch(BASE_CONN, "not-an-id", {
      event: monitorEvent({ monitor_id: 7 }),
    });

    expect(client.calls).toEqual([7]);
  });

  it("renders an ungrouped monitor's overall state", async () => {
    const client = new FakeMonitorClient(
      monitor({ groups: [], overall_state: "OK" })
    );
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "999", { event: monitorEvent() });

    expect(result.content).toContain("Group states: (ungrouped; overall OK)");
  });

  it("renders (none) for empty thresholds and options", async () => {
    const client = new FakeMonitorClient(
      monitor({ thresholds: {}, options: {} })
    );
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "999", { event: monitorEvent() });

    expect(result.content).toContain("Thresholds:\n(none)");
    expect(result.content).toContain("Options:\n(none)");
  });

  it("renders an unavailable note when no monitor id can be resolved", async () => {
    const client = new FakeMonitorClient(monitor());
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "not-an-id", {});

    expect(client.calls).toEqual([]);
    expect(result.label).toBe("Datadog monitor");
    expect(result.content).toContain(
      `capability ${DATADOG_GET_MONITOR_CAPABILITY_ID} unavailable`
    );
    expect(result.content).toContain("no monitor id");
  });

  it("renders an unavailable note when the fetch throws (e.g. a 404)", async () => {
    const client = new FakeMonitorClient(undefined, new Error("Monitor not found"));
    const { cap } = build(client);

    const result = await cap.fetch(BASE_CONN, "999", { event: monitorEvent() });

    expect(result.content).toContain(
      `capability ${DATADOG_GET_MONITOR_CAPABILITY_ID} unavailable: Monitor not found`
    );
  });

  it("renders an unavailable note when a key secret is missing", async () => {
    const client = new FakeMonitorClient(monitor());
    const { cap } = build(client, { resolveSecret: async () => undefined });

    const result = await cap.fetch(BASE_CONN, "999", { event: monitorEvent() });

    expect(client.calls).toEqual([]);
    expect(result.content).toContain("Datadog API key secret unavailable");
  });
});

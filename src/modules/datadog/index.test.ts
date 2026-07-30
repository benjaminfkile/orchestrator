import type { TriggerScheduler } from "../../services/triggerScheduler";

import type { DatadogClient, DatadogClientOptions } from "./client";
import {
  DATADOG_MODULE_ID,
  createDatadogModule,
  validateDatadogConfig,
} from "./index";

/** A no-op scheduler: producers only ever call `applyTrigger` on it. */
function fakeScheduler(): TriggerScheduler {
  return { applyTrigger: jest.fn() } as unknown as TriggerScheduler;
}

describe("validateDatadogConfig", () => {
  it("accepts an empty config", () => {
    expect(() => validateDatadogConfig({})).not.toThrow();
  });

  it("accepts a fully-specified config", () => {
    expect(() =>
      validateDatadogConfig({
        enabled: true,
        site: "us5.datadoghq.com",
        api_key_secret_ref: "DD_API_KEY",
        app_key_secret_ref: "DD_APP_KEY",
        interval_seconds: 120,
        monitors: { enabled: true, monitor_tags: ["team:core"] },
        watches: [
          {
            name: "errors-by-service",
            query: "status:error",
            group_by: "service",
            window_seconds: 300,
            detect: {
              min_count: 10,
              spike_multiplier: 3,
              baseline_windows: 12,
              novel_groups: true,
            },
            sample_limit: 5,
          },
        ],
      })
    ).not.toThrow();
  });

  it("rejects a non-object config", () => {
    expect(() => validateDatadogConfig(null)).toThrow(/JSON object/);
    expect(() => validateDatadogConfig([])).toThrow(/JSON object/);
    expect(() => validateDatadogConfig("nope")).toThrow(/JSON object/);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => validateDatadogConfig({ nope: 1 })).toThrow(
      /unknown datadog field: nope/
    );
  });

  it("rejects wrong-typed top-level fields", () => {
    expect(() => validateDatadogConfig({ enabled: "yes" })).toThrow(
      /enabled must be a boolean/
    );
    expect(() => validateDatadogConfig({ site: 5 })).toThrow(
      /site must be a string/
    );
    expect(() => validateDatadogConfig({ interval_seconds: 0 })).toThrow(
      /interval_seconds must be between/
    );
    expect(() =>
      validateDatadogConfig({ interval_seconds: 1.5 })
    ).toThrow(/interval_seconds must be an integer/);
  });

  it("validates the monitors block and rejects unknown keys", () => {
    expect(() =>
      validateDatadogConfig({ monitors: { enabled: true } })
    ).not.toThrow();
    expect(() =>
      validateDatadogConfig({ monitors: { monitor_tags: [1] } })
    ).toThrow(/monitors.monitor_tags must be an array of strings/);
    expect(() =>
      validateDatadogConfig({ monitors: { extra: 1 } })
    ).toThrow(/unknown monitors field: extra/);
    expect(() => validateDatadogConfig({ monitors: [] })).toThrow(
      /monitors must be an object/
    );
  });

  it("rejects a non-array watches", () => {
    expect(() => validateDatadogConfig({ watches: {} })).toThrow(
      /watches must be an array/
    );
  });

  it("requires name, query, and group_by on each watch", () => {
    expect(() =>
      validateDatadogConfig({ watches: [{ query: "q", group_by: "g" }] })
    ).toThrow(/watches\[0\].name must be a non-empty string/);
    expect(() =>
      validateDatadogConfig({ watches: [{ name: "n", group_by: "g" }] })
    ).toThrow(/watches\[0\].query must be a non-empty string/);
    expect(() =>
      validateDatadogConfig({ watches: [{ name: "n", query: "q" }] })
    ).toThrow(/watches\[0\].group_by must be a non-empty string/);
  });

  it("rejects an unknown key on a watch", () => {
    expect(() =>
      validateDatadogConfig({
        watches: [{ name: "n", query: "q", group_by: "g", nope: 1 }],
      })
    ).toThrow(/unknown watches\[0\] field: nope/);
  });

  it("bounds a watch sample_limit to the sample cap", () => {
    expect(() =>
      validateDatadogConfig({
        watches: [{ name: "n", query: "q", group_by: "g", sample_limit: 26 }],
      })
    ).toThrow(/watches\[0\].sample_limit must be between 1 and 25/);
  });

  it("validates the detect block", () => {
    expect(() =>
      validateDatadogConfig({
        watches: [
          {
            name: "n",
            query: "q",
            group_by: "g",
            detect: { min_count: -1 },
          },
        ],
      })
    ).toThrow(/watches\[0\].detect.min_count must be at least 0/);
    expect(() =>
      validateDatadogConfig({
        watches: [
          {
            name: "n",
            query: "q",
            group_by: "g",
            detect: { baseline_windows: 0 },
          },
        ],
      })
    ).toThrow(/watches\[0\].detect.baseline_windows must be between 1 and 1000/);
    expect(() =>
      validateDatadogConfig({
        watches: [
          {
            name: "n",
            query: "q",
            group_by: "g",
            detect: { bogus: 1 },
          },
        ],
      })
    ).toThrow(/unknown watches\[0\].detect field: bogus/);
  });
});

describe("createDatadogModule", () => {
  it("registers under the datadog id with a validate hook and both producers", () => {
    const { module, logWatchProducerId, monitorProducerId } =
      createDatadogModule({
        scheduler: fakeScheduler(),
        resolveSecret: async () => undefined,
      });
    expect(module.id).toBe(DATADOG_MODULE_ID);
    expect(module.validateConfig).toBe(validateDatadogConfig);
    expect((module.producers ?? []).map((p) => p.id)).toEqual([
      logWatchProducerId,
      monitorProducerId,
    ]);
    expect(module.eventTypes).toEqual([
      "datadog.logs.alert",
      "datadog.monitor.transition",
    ]);
    // Both READ-ONLY investigation capabilities are registered under the module.
    expect((module.capabilities ?? []).map((c) => c.id)).toEqual([
      "datadog.query_logs",
      "datadog.get_monitor",
    ]);
  });

  it("ping resolves both secret refs and issues a bounded search", async () => {
    const searchLogs = jest.fn(async () => []);
    const resolved: string[] = [];
    let seenOptions: DatadogClientOptions | undefined;
    const { module, ping } = createDatadogModule({
      scheduler: fakeScheduler(),
      resolveSecret: async (ref) => {
        resolved.push(ref);
        return `${ref}-value`;
      },
      clientFactory: (opts) => {
        seenOptions = opts;
        return { searchLogs } as unknown as DatadogClient;
      },
    });
    module.applyConfig?.({
      site: "datadoghq.eu",
      api_key_secret_ref: "DD_API_KEY",
      app_key_secret_ref: "DD_APP_KEY",
    });

    await ping();

    expect(resolved).toEqual(["DD_API_KEY", "DD_APP_KEY"]);
    expect(seenOptions).toEqual({
      apiKey: "DD_API_KEY-value",
      appKey: "DD_APP_KEY-value",
      site: "datadoghq.eu",
    });
    expect(searchLogs).toHaveBeenCalledTimes(1);
    const [params] = searchLogs.mock.calls[0] as unknown as [{ limit: number }];
    expect(params.limit).toBe(1);
  });

  it("ping throws a clear error when a secret ref is unresolved", async () => {
    const { ping } = createDatadogModule({
      scheduler: fakeScheduler(),
      resolveSecret: async () => undefined,
    });
    await expect(
      ping({ api_key_secret_ref: "MISSING", app_key_secret_ref: "ALSO" })
    ).rejects.toThrow(/Datadog API key secret unavailable for ref "MISSING"/);
  });

  it("ping surfaces a missing app key when only the api key resolves", async () => {
    const { ping } = createDatadogModule({
      scheduler: fakeScheduler(),
      resolveSecret: async (ref) => (ref === "API" ? "v" : undefined),
    });
    await expect(
      ping({ api_key_secret_ref: "API", app_key_secret_ref: "APP" })
    ).rejects.toThrow(/Datadog Application key secret unavailable for ref "APP"/);
  });
});

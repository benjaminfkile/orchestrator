import type { NewEvent } from "../../interfaces";
import type { Logger } from "../../log";
import type { Trigger, TriggerScheduler } from "../../services/triggerScheduler";

import type { DatadogClientOptions } from "./client";
import type { DatadogModuleConfig } from "./index";
import {
  createLogWatchProducer,
  DATADOG_LOGWATCH_PRODUCER_ID,
  DATADOG_MAX_GROUPS_PER_TICK,
  type DatadogLogWatchReadClient,
} from "./logWatch";

/** A count bucket the fake aggregate returns. */
interface Bucket {
  group: string;
  count: number;
}

/**
 * A scripted fake Datadog client. `aggregateQueue` yields one bucket list per
 * tick; `searchResult` is returned for every post-trip sample.
 */
function fakeClient(script: {
  aggregateQueue: Bucket[][];
  searchResult?: { timestamp: string; status: string; service: string; message: string }[];
  onAggregate?: (params: { query: string; from: number; to: number; groupBy: string; limit?: number }) => void;
  onSearch?: (params: { query: string; from: number; to: number; limit?: number }) => void;
  aggregateThrows?: unknown;
}): DatadogLogWatchReadClient {
  let tick = 0;
  return {
    async aggregateLogs(params) {
      script.onAggregate?.(params);
      if (script.aggregateThrows !== undefined) throw script.aggregateThrows;
      const buckets = script.aggregateQueue[tick] ?? [];
      tick += 1;
      return buckets;
    },
    async searchLogs(params) {
      script.onSearch?.(params);
      return script.searchResult ?? [];
    },
  };
}

/** Capture every trigger a producer applies to a fake scheduler. */
function schedulerSpy(): {
  scheduler: TriggerScheduler;
  triggers: { id: string; trigger: Trigger }[];
} {
  const triggers: { id: string; trigger: Trigger }[] = [];
  const scheduler = {
    applyTrigger: (id: string, trigger: Trigger) => triggers.push({ id, trigger }),
  } as unknown as TriggerScheduler;
  return { scheduler, triggers };
}

/** A logger that records warn/info calls for assertions. */
function recordingLogger(): { logger: Logger; warns: { msg: string; extra?: unknown }[] } {
  const warns: { msg: string; extra?: unknown }[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, extra) => warns.push({ msg, extra }),
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

/**
 * Build a producer wired to a fake client + captured emits. The clock advances a
 * fixed step each call so window bounds are deterministic.
 */
function build(
  client: DatadogLogWatchReadClient,
  overrides: { logger?: Logger } = {}
) {
  const emitted: NewEvent[] = [];
  const { scheduler, triggers } = schedulerSpy();
  let now = 1_000_000;
  const producer = createLogWatchProducer({
    scheduler,
    resolveSecret: async (ref) => `${ref}-value`,
    emit: async (event) => {
      emitted.push(event);
      return undefined;
    },
    clientFactory: () => client,
    logger: overrides.logger,
    clock: () => now,
  });
  return {
    ...producer,
    emitted,
    triggers,
    setNow: (t: number) => {
      now = t;
    },
  };
}

const BASE_WATCH = {
  name: "errors",
  query: "status:error",
  group_by: "service",
};

function cfg(watch: Partial<typeof BASE_WATCH> & { detect?: unknown; window_seconds?: number; sample_limit?: number }): DatadogModuleConfig {
  return {
    enabled: true,
    api_key_secret_ref: "API",
    app_key_secret_ref: "APP",
    watches: [{ ...BASE_WATCH, ...watch } as never],
  };
}

describe("createLogWatchProducer trigger", () => {
  it("arms an interval only when enabled with a detector-armed watch", () => {
    const p = build(fakeClient({ aggregateQueue: [] }));
    p.applyConfig(cfg({ detect: { min_count: 1 } }));
    expect(p.triggers.at(-1)).toEqual({
      id: DATADOG_LOGWATCH_PRODUCER_ID,
      trigger: { kind: "interval", seconds: 60 },
    });
  });

  it("stays manual when disabled or when no watch arms a detector", () => {
    const p = build(fakeClient({ aggregateQueue: [] }));
    p.applyConfig(cfg({ detect: {} }));
    expect(p.triggers.at(-1)?.trigger).toEqual({ kind: "manual" });
    p.applyConfig({ ...cfg({ detect: { min_count: 1 } }), enabled: false });
    expect(p.triggers.at(-1)?.trigger).toEqual({ kind: "manual" });
  });

  it("honours a custom interval_seconds", () => {
    const p = build(fakeClient({ aggregateQueue: [] }));
    p.applyConfig({ ...cfg({ detect: { min_count: 1 } }), interval_seconds: 300 });
    expect(p.triggers.at(-1)?.trigger).toEqual({ kind: "interval", seconds: 300 });
  });
});

describe("createLogWatchProducer seeding", () => {
  it("emits nothing on the first tick and records the baseline count", async () => {
    const client = fakeClient({
      aggregateQueue: [[{ group: "web", count: 5 }, { group: "api", count: 3 }]],
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { min_count: 1 } }));
    await p.producer.tick();
    expect(p.emitted).toEqual([]);
    expect(p.getStatus().seeded_count).toBe(2);
  });
});

describe("createLogWatchProducer threshold detector", () => {
  it("fires min_count only for groups at or above the threshold", async () => {
    const client = fakeClient({
      aggregateQueue: [
        [{ group: "web", count: 0 }],
        [{ group: "web", count: 10 }, { group: "api", count: 2 }],
      ],
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { min_count: 5 } }));
    await p.producer.tick(); // seed
    await p.producer.tick(); // detect
    expect(p.emitted).toHaveLength(1);
    const e = p.emitted[0];
    expect(e.type).toBe("datadog.logs.alert");
    expect(e.subject_kind).toBe("log_group");
    expect(e.subject_ref).toBe("errors/web");
    expect(e.dedupe_key).toBe("datadog:errors:web");
    const payload = e.payload as { detectors: string[]; count: number };
    expect(payload.detectors).toEqual(["threshold"]);
    expect(payload.count).toBe(10);
  });
});

describe("createLogWatchProducer spike detector", () => {
  it("fires against the trailing baseline mean and never on a zero baseline", async () => {
    // Seed then two steady windows build a baseline of mean(10,10)=10; the third
    // window's 40 is >= 3 * 10, so it spikes.
    const client = fakeClient({
      aggregateQueue: [
        [{ group: "web", count: 10 }],
        [{ group: "web", count: 10 }],
        [{ group: "web", count: 10 }],
        [{ group: "web", count: 40 }],
      ],
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { spike_multiplier: 3 } }));
    await p.producer.tick(); // seed (buffer [10])
    await p.producer.tick(); // baseline 10, count 10 -> no spike (buffer [10,10])
    await p.producer.tick(); // baseline 10, count 10 -> no spike
    expect(p.emitted).toEqual([]);
    await p.producer.tick(); // baseline 10, count 40 -> spike
    expect(p.emitted).toHaveLength(1);
    const payload = p.emitted[0].payload as { detectors: string[]; baseline: number; count: number };
    expect(payload.detectors).toEqual(["spike"]);
    expect(payload.baseline).toBe(10);
    expect(payload.count).toBe(40);
  });

  it("does not spike a novel group whose baseline is still zero", async () => {
    const client = fakeClient({
      aggregateQueue: [
        [{ group: "web", count: 1 }],
        [{ group: "api", count: 100 }],
      ],
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { spike_multiplier: 2 } }));
    await p.producer.tick(); // seed
    await p.producer.tick(); // api is novel, baseline 0 -> no spike
    expect(p.emitted).toEqual([]);
  });
});

describe("createLogWatchProducer novel detector", () => {
  it("fires once for a group key never seen for the watch", async () => {
    const client = fakeClient({
      aggregateQueue: [
        [{ group: "web", count: 1 }],
        [{ group: "web", count: 1 }, { group: "api", count: 1 }],
        [{ group: "api", count: 1 }],
      ],
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { novel_groups: true } }));
    await p.producer.tick(); // seed: web known
    await p.producer.tick(); // api is novel -> one event
    expect(p.emitted).toHaveLength(1);
    expect(p.emitted[0].subject_ref).toBe("errors/api");
    expect((p.emitted[0].payload as { detectors: string[] }).detectors).toEqual([
      "novel",
    ]);
    await p.producer.tick(); // api now known -> no repeat
    expect(p.emitted).toHaveLength(1);
  });
});

describe("createLogWatchProducer combined detectors", () => {
  it("lists every fired detector in ONE event", async () => {
    // Seed web at 10, steady at 10, then a novel 'api' with a huge count trips
    // both threshold and novel (spike needs a baseline it does not yet have).
    const client = fakeClient({
      aggregateQueue: [
        [{ group: "web", count: 10 }],
        [{ group: "api", count: 50 }],
      ],
      searchResult: [
        { timestamp: "t", status: "error", service: "api", message: "boom" },
      ],
    });
    const p = build(client);
    p.applyConfig(
      cfg({ detect: { min_count: 5, spike_multiplier: 2, novel_groups: true } })
    );
    await p.producer.tick(); // seed
    await p.producer.tick(); // api: threshold + novel (baseline 0 -> no spike)
    expect(p.emitted).toHaveLength(1);
    const payload = p.emitted[0].payload as {
      detectors: string[];
      samples: unknown[];
      explorer_url: string;
    };
    expect(payload.detectors).toEqual(["threshold", "novel"]);
    expect(payload.samples).toHaveLength(1);
    expect(payload.explorer_url).toContain("/logs?");
  });

  it("scopes the sample search to the tripped group and window", async () => {
    const searchCalls: { query: string; from: number; to: number; limit?: number }[] = [];
    const client = fakeClient({
      aggregateQueue: [[], [{ group: "web", count: 10 }]],
      onSearch: (params) => searchCalls.push(params),
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { min_count: 1 }, window_seconds: 120, sample_limit: 3 }));
    await p.producer.tick(); // seed
    await p.producer.tick();
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe("status:error service:web");
    expect(searchCalls[0].to - searchCalls[0].from).toBe(120_000);
    expect(searchCalls[0].limit).toBe(3);
  });
});

describe("createLogWatchProducer dedupe stability", () => {
  it("keeps the dedupe_key stable across ticks for the same (watch, group)", async () => {
    const client = fakeClient({
      aggregateQueue: [
        [{ group: "web", count: 9 }],
        [{ group: "web", count: 10 }],
        [{ group: "web", count: 11 }],
      ],
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { min_count: 5 } }));
    await p.producer.tick(); // seed
    await p.producer.tick();
    await p.producer.tick();
    expect(p.emitted).toHaveLength(2);
    expect(new Set(p.emitted.map((e) => e.dedupe_key))).toEqual(
      new Set(["datadog:errors:web"])
    );
  });
});

describe("createLogWatchProducer fail-quiet", () => {
  it("emits nothing and records the error when a tick throws", async () => {
    const client = fakeClient({
      aggregateQueue: [[{ group: "web", count: 1 }]],
      aggregateThrows: new Error("429 rate limited"),
    });
    const p = build(client);
    p.applyConfig(cfg({ detect: { min_count: 1 } }));
    await p.producer.tick();
    expect(p.emitted).toEqual([]);
    expect(p.getStatus().last_error).toMatch(/429/);
    // Not seeded: the next successful tick still seeds silently.
    const client2 = fakeClient({ aggregateQueue: [[{ group: "web", count: 100 }]] });
    // Swap in a working client by rebuilding is not possible; assert seeded state.
    expect(p.getStatus().seeded_count).toBe(0);
    void client2;
  });

  it("emits nothing when a key secret is unavailable", async () => {
    const emitted: NewEvent[] = [];
    const { scheduler } = schedulerSpy();
    const producer = createLogWatchProducer({
      scheduler,
      resolveSecret: async () => undefined,
      emit: async (e) => {
        emitted.push(e);
        return undefined;
      },
      clientFactory: () => fakeClient({ aggregateQueue: [[{ group: "web", count: 1 }]] }),
      clock: () => 1,
    });
    producer.applyConfig(cfg({ detect: { min_count: 1 } }));
    await producer.producer.tick();
    expect(emitted).toEqual([]);
    expect(producer.getStatus().last_error).toMatch(/API key secret unavailable/);
  });
});

describe("createLogWatchProducer group cap", () => {
  it("truncates to the cap and logs the truncation (never silent)", async () => {
    const many: Bucket[] = [];
    for (let i = 0; i <= DATADOG_MAX_GROUPS_PER_TICK; i++) {
      many.push({ group: `g${i}`, count: 100 });
    }
    // Seed with an empty window so every group is novel+over-threshold next tick.
    const { logger, warns } = recordingLogger();
    const client = fakeClient({ aggregateQueue: [[], many] });
    const p = build(client, { logger });
    p.applyConfig(cfg({ detect: { min_count: 1 } }));
    await p.producer.tick(); // seed
    await p.producer.tick(); // detect, but capped
    expect(p.emitted).toHaveLength(DATADOG_MAX_GROUPS_PER_TICK);
    const truncation = warns.find((w) => w.msg.includes("truncated"));
    expect(truncation).toBeDefined();
    expect(truncation?.extra).toMatchObject({
      returned: DATADOG_MAX_GROUPS_PER_TICK + 1,
      cap: DATADOG_MAX_GROUPS_PER_TICK,
    });
  });
});

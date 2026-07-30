import type { NewEvent } from "../../interfaces";
import type { Trigger, TriggerScheduler } from "../../services/triggerScheduler";

import type { DatadogMonitorState } from "./client";
import type { DatadogModuleConfig } from "./index";
import {
  createMonitorWatchProducer,
  DATADOG_MONITOR_PRODUCER_ID,
  type DatadogMonitorReadClient,
} from "./monitorWatch";

/** A scripted fake that returns one monitor-state list per tick. */
function fakeClient(script: {
  queue: DatadogMonitorState[][];
  onList?: (params?: { monitorTags?: string[] }) => void;
  throws?: unknown;
}): DatadogMonitorReadClient {
  let tick = 0;
  return {
    async listMonitorStates(params) {
      script.onList?.(params);
      if (script.throws !== undefined) throw script.throws;
      const list = script.queue[tick] ?? [];
      tick += 1;
      return list;
    },
  };
}

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

function build(client: DatadogMonitorReadClient) {
  const emitted: NewEvent[] = [];
  const { scheduler, triggers } = schedulerSpy();
  const producer = createMonitorWatchProducer({
    scheduler,
    resolveSecret: async (ref) => `${ref}-value`,
    emit: async (event) => {
      emitted.push(event);
      return undefined;
    },
    clientFactory: () => client,
    clock: () => 42,
  });
  return { ...producer, emitted, triggers };
}

/** One ungrouped monitor with an overall state. */
function monitor(
  id: number,
  overall_state: string,
  extra: Partial<DatadogMonitorState> = {}
): DatadogMonitorState {
  return {
    id,
    name: `m${id}`,
    query: `q${id}`,
    overall_state,
    groups: [],
    url: `https://app.datadoghq.com/monitors/${id}`,
    ...extra,
  };
}

const ENABLED: DatadogModuleConfig = {
  enabled: true,
  api_key_secret_ref: "API",
  app_key_secret_ref: "APP",
  monitors: { enabled: true },
};

describe("createMonitorWatchProducer trigger", () => {
  it("arms an interval only when both the module and monitors are enabled", () => {
    const p = build(fakeClient({ queue: [] }));
    p.applyConfig(ENABLED);
    expect(p.triggers.at(-1)).toEqual({
      id: DATADOG_MONITOR_PRODUCER_ID,
      trigger: { kind: "interval", seconds: 60 },
    });
    p.applyConfig({ ...ENABLED, monitors: { enabled: false } });
    expect(p.triggers.at(-1)?.trigger).toEqual({ kind: "manual" });
    p.applyConfig({ ...ENABLED, enabled: false });
    expect(p.triggers.at(-1)?.trigger).toEqual({ kind: "manual" });
  });

  it("forwards the configured monitor_tags to the client", async () => {
    const seen: ({ monitorTags?: string[] } | undefined)[] = [];
    const client = fakeClient({
      queue: [[monitor(1, "OK")]],
      onList: (params) => seen.push(params),
    });
    const p = build(client);
    p.applyConfig({ ...ENABLED, monitors: { enabled: true, monitor_tags: ["team:core"] } });
    await p.producer.tick();
    expect(seen[0]).toEqual({ monitorTags: ["team:core"] });
  });
});

describe("createMonitorWatchProducer transition matrix", () => {
  it("seeds silently, then fires on change, stays quiet on no-change, and fires on recovery", async () => {
    const client = fakeClient({
      queue: [
        [monitor(1, "OK")], // seed
        [monitor(1, "Alert")], // change OK -> Alert
        [monitor(1, "Alert")], // no-change
        [monitor(1, "OK")], // recovery Alert -> OK
      ],
    });
    const p = build(client);
    p.applyConfig(ENABLED);

    await p.producer.tick(); // seed
    expect(p.emitted).toEqual([]);
    expect(p.getStatus().seeded_count).toBe(1);

    await p.producer.tick(); // change
    expect(p.emitted).toHaveLength(1);
    const change = p.emitted[0];
    expect(change.type).toBe("datadog.monitor.transition");
    expect(change.subject_kind).toBe("monitor");
    expect(change.subject_ref).toBe("1");
    expect(change.dedupe_key).toBe("datadog:monitor:1:*");
    expect(change.payload).toMatchObject({
      monitor_id: 1,
      name: "m1",
      query: "q1",
      group: "*",
      from_state: "OK",
      to_state: "Alert",
      url: "https://app.datadoghq.com/monitors/1",
    });

    await p.producer.tick(); // no-change
    expect(p.emitted).toHaveLength(1);

    await p.producer.tick(); // recovery
    expect(p.emitted).toHaveLength(2);
    expect(p.emitted[1].payload).toMatchObject({
      from_state: "Alert",
      to_state: "OK",
    });
  });

  it("tracks per-group states independently", async () => {
    const grouped = (s1: string, s2: string): DatadogMonitorState =>
      monitor(7, "Alert", {
        groups: [
          { group: "host:a", state: s1 },
          { group: "host:b", state: s2 },
        ],
      });
    const client = fakeClient({
      queue: [
        [grouped("OK", "OK")], // seed
        [grouped("Alert", "OK")], // only host:a transitions
      ],
    });
    const p = build(client);
    p.applyConfig(ENABLED);
    await p.producer.tick(); // seed (2 groups)
    expect(p.getStatus().seeded_count).toBe(2);
    await p.producer.tick();
    expect(p.emitted).toHaveLength(1);
    expect(p.emitted[0].dedupe_key).toBe("datadog:monitor:7:host:a");
    expect(p.emitted[0].payload).toMatchObject({
      group: "host:a",
      from_state: "OK",
      to_state: "Alert",
    });
  });

  it("records a newly-appearing monitor silently, firing only on its next change", async () => {
    const client = fakeClient({
      queue: [
        [monitor(1, "OK")], // seed
        [monitor(1, "OK"), monitor(2, "Alert")], // monitor 2 is new -> silent
        [monitor(1, "OK"), monitor(2, "OK")], // now 2 transitions
      ],
    });
    const p = build(client);
    p.applyConfig(ENABLED);
    await p.producer.tick(); // seed
    await p.producer.tick(); // monitor 2 appears, recorded silently
    expect(p.emitted).toEqual([]);
    await p.producer.tick(); // monitor 2: Alert -> OK
    expect(p.emitted).toHaveLength(1);
    expect(p.emitted[0].subject_ref).toBe("2");
    expect(p.emitted[0].payload).toMatchObject({ from_state: "Alert", to_state: "OK" });
  });
});

describe("createMonitorWatchProducer fail-quiet", () => {
  it("emits nothing and records the error when a tick throws", async () => {
    const client = fakeClient({ queue: [[monitor(1, "OK")]], throws: new Error("429") });
    const p = build(client);
    p.applyConfig(ENABLED);
    await p.producer.tick();
    expect(p.emitted).toEqual([]);
    expect(p.getStatus().last_error).toMatch(/429/);
    expect(p.getStatus().seeded_count).toBe(0);
  });

  it("emits nothing when a key secret is unavailable", async () => {
    const emitted: NewEvent[] = [];
    const { scheduler } = schedulerSpy();
    const producer = createMonitorWatchProducer({
      scheduler,
      resolveSecret: async () => undefined,
      emit: async (e) => {
        emitted.push(e);
        return undefined;
      },
      clientFactory: () => fakeClient({ queue: [[monitor(1, "OK")]] }),
      clock: () => 1,
    });
    producer.applyConfig(ENABLED);
    await producer.producer.tick();
    expect(emitted).toEqual([]);
    expect(producer.getStatus().last_error).toMatch(/API key secret unavailable/);
  });
});

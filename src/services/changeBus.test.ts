import {
  COALESCE_WINDOW_MS,
  publish,
  subscribe,
  type ResourceChange,
} from "./changeBus";

describe("changeBus", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("delivers a published resource to a subscriber after the window", () => {
    const seen: ResourceChange[] = [];
    subscribe((c) => seen.push(c));

    publish("playbooks");
    // Nothing is delivered synchronously — the broadcast is trailing-edge.
    expect(seen).toEqual([]);

    jest.advanceTimersByTime(COALESCE_WINDOW_MS);
    expect(seen).toEqual([{ resource: "playbooks", ts: expect.any(Number) }]);
  });

  it("coalesces a burst for one resource into a single broadcast", () => {
    const seen: ResourceChange[] = [];
    subscribe((c) => seen.push(c));

    publish("dispatches");
    jest.advanceTimersByTime(COALESCE_WINDOW_MS - 100);
    publish("dispatches");
    publish("dispatches");
    // The extra publishes fold into the first window, not extend it.
    jest.advanceTimersByTime(100);

    expect(seen).toEqual([{ resource: "dispatches", ts: expect.any(Number) }]);
  });

  it("broadcasts distinct resources independently", () => {
    const seen: string[] = [];
    subscribe((c) => seen.push(c.resource));

    publish("rules");
    publish("events");
    jest.advanceTimersByTime(COALESCE_WINDOW_MS);

    expect(seen.sort()).toEqual(["events", "rules"]);
  });

  it("broadcasts again for a resource published after its window elapsed", () => {
    const seen: string[] = [];
    subscribe((c) => seen.push(c.resource));

    publish("runs");
    jest.advanceTimersByTime(COALESCE_WINDOW_MS);
    publish("runs");
    jest.advanceTimersByTime(COALESCE_WINDOW_MS);

    expect(seen).toEqual(["runs", "runs"]);
  });

  it("stops delivering after unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribe((c) => seen.push(c.resource));

    publish("settings");
    jest.advanceTimersByTime(COALESCE_WINDOW_MS);
    unsubscribe();
    publish("settings");
    jest.advanceTimersByTime(COALESCE_WINDOW_MS);

    expect(seen).toEqual(["settings"]);
  });

  it("isolates a throwing subscriber from its peers", () => {
    const seen: string[] = [];
    subscribe(() => {
      throw new Error("bad subscriber");
    });
    subscribe((c) => seen.push(c.resource));

    publish("notifiers");
    expect(() => jest.advanceTimersByTime(COALESCE_WINDOW_MS)).not.toThrow();
    expect(seen).toEqual(["notifiers"]);
  });

  it("never throws from publish (fire-and-forget)", () => {
    expect(() => publish("secrets")).not.toThrow();
    jest.advanceTimersByTime(COALESCE_WINDOW_MS);
  });
});

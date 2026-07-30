import { createLogger, type Logger } from "../log";

import {
  cronNextFire,
  parseCron,
  TriggerScheduler,
  type TickResolver,
} from "./triggerScheduler";

/** A logger that swallows output; scheduler logs are noise in these tests. */
function silentLogger(): Logger {
  return createLogger({ sink: () => {} });
}

/** Build a resolver over a plain map of producerId → tick. */
function resolverFor(ticks: Record<string, () => Promise<void>>): TickResolver {
  return (id) => ticks[id];
}

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z (a Thursday)

describe("cron parser + next-fire", () => {
  it("parses *, numbers, */n, and comma lists", () => {
    const parsed = parseCron("0,30 */6 * * *");
    expect([...parsed.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...parsed.hour].sort((a, b) => a - b)).toEqual([0, 6, 12, 18]);
    expect(parsed.domStar).toBe(true);
    expect(parsed.dowStar).toBe(true);
  });

  it("folds day-of-week 7 onto 0 (Sunday)", () => {
    const parsed = parseCron("0 0 * * 7");
    expect(parsed.dow.has(0)).toBe(true);
    expect(parsed.dow.has(7)).toBe(false);
    expect(parsed.dowStar).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/invalid step/);
    expect(() => parseCron("x * * * *")).toThrow(/out of range/);
  });

  it("computes the next */15 minute strictly after now", () => {
    expect(cronNextFire("*/15 * * * *", BASE)).toBe(Date.UTC(2026, 0, 1, 0, 15));
    // Mid-interval, seconds are dropped and we round up to the next match.
    const midway = Date.UTC(2026, 0, 1, 0, 7, 30);
    expect(cronNextFire("*/15 * * * *", midway)).toBe(Date.UTC(2026, 0, 1, 0, 15));
  });

  it("computes the next daily fire", () => {
    expect(cronNextFire("0 0 * * *", BASE)).toBe(Date.UTC(2026, 0, 2, 0, 0));
  });

  it("computes the next weekday fire (Monday noon)", () => {
    expect(cronNextFire("0 12 * * 1", BASE)).toBe(Date.UTC(2026, 0, 5, 12, 0));
  });

  it("ORs day-of-month and day-of-week when both are restricted", () => {
    // dom 10 OR Monday: the first Monday (Jan 5) beats the 10th.
    expect(cronNextFire("0 0 10 * 1", BASE)).toBe(Date.UTC(2026, 0, 5, 0, 0));
    // Past that Monday, the 10th (a Saturday) still fires via the dom branch.
    const afterMonday = Date.UTC(2026, 0, 6, 0, 0);
    expect(cronNextFire("0 0 10 * 1", afterMonday)).toBe(Date.UTC(2026, 0, 10, 0, 0));
  });

  it("ANDs the day fields when one is a wildcard", () => {
    // Only day-of-month restricted → fires on the 10th regardless of weekday.
    expect(cronNextFire("0 0 10 * *", BASE)).toBe(Date.UTC(2026, 0, 10, 0, 0));
  });

  it("searches multiple years for a Feb-29-only schedule", () => {
    // 2026 and 2027 are not leap years; the next Feb 29 is in 2028.
    expect(cronNextFire("0 0 29 2 *", BASE)).toBe(Date.UTC(2028, 1, 29, 0, 0));
  });
});

describe("TriggerScheduler", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeScheduler(ticks: Record<string, () => Promise<void>>) {
    return new TriggerScheduler({
      resolveTick: resolverFor(ticks),
      logger: silentLogger(),
    });
  }

  it("fires an interval trigger and re-arms each period", async () => {
    let count = 0;
    const scheduler = makeScheduler({ p: async () => { count += 1; } });
    scheduler.applyTrigger("p", { kind: "interval", seconds: 5 });

    expect(scheduler.getProducerStatus("p")?.nextFireAt).toBe(BASE + 5000);

    await jest.advanceTimersByTimeAsync(5000);
    expect(count).toBe(1);
    expect(scheduler.getProducerStatus("p")?.lastTickAt).toBe(BASE + 5000);
    expect(scheduler.getProducerStatus("p")?.nextFireAt).toBe(BASE + 10000);

    await jest.advanceTimersByTimeAsync(5000);
    expect(count).toBe(2);

    scheduler.stop();
  });

  it("reconciles idempotently: re-applying the same trigger leaves one timer", async () => {
    let count = 0;
    const scheduler = makeScheduler({ p: async () => { count += 1; } });
    scheduler.applyTrigger("p", { kind: "interval", seconds: 5 });
    scheduler.applyTrigger("p", { kind: "interval", seconds: 5 });

    await jest.advanceTimersByTimeAsync(5000);
    expect(count).toBe(1); // one timer, not two

    scheduler.stop();
  });

  it("re-arms with the new cadence on a changed trigger", async () => {
    let count = 0;
    const scheduler = makeScheduler({ p: async () => { count += 1; } });
    scheduler.applyTrigger("p", { kind: "interval", seconds: 5 });
    // Change before the first fire: the 5s timer must be cleared.
    scheduler.applyTrigger("p", { kind: "interval", seconds: 10 });

    await jest.advanceTimersByTimeAsync(5000);
    expect(count).toBe(0); // old 5s timer was cleared

    await jest.advanceTimersByTimeAsync(5000);
    expect(count).toBe(1); // new 10s timer fires

    scheduler.stop();
  });

  it("fires a cron trigger and re-arms for the next occurrence", async () => {
    let count = 0;
    const scheduler = makeScheduler({ p: async () => { count += 1; } });
    scheduler.applyTrigger("p", { kind: "cron", expr: "*/15 * * * *" });

    expect(scheduler.getProducerStatus("p")?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 15));

    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(count).toBe(1);
    expect(scheduler.getProducerStatus("p")?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 0, 30));

    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(count).toBe(2);

    scheduler.stop();
  });

  it("runs a manual fire on demand and never on a timer", async () => {
    let count = 0;
    const scheduler = makeScheduler({ p: async () => { count += 1; } });
    scheduler.applyTrigger("p", { kind: "manual" });

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(count).toBe(0); // manual never self-fires

    await scheduler.fireNow("p");
    expect(count).toBe(1);
    expect(scheduler.getProducerStatus("p")?.lastTickAt).toBe(BASE + 60 * 60 * 1000);
    expect(scheduler.getProducerStatus("p")?.lastError).toBeNull();
  });

  it("captures a tick error on the status and keeps firing", async () => {
    let count = 0;
    const scheduler = makeScheduler({
      p: async () => {
        count += 1;
        if (count === 1) throw new Error("boom");
      },
    });
    scheduler.applyTrigger("p", { kind: "interval", seconds: 5 });

    await jest.advanceTimersByTimeAsync(5000);
    expect(scheduler.getProducerStatus("p")?.lastError).toBe("boom");
    expect(scheduler.getProducerStatus("p")?.lastTickAt).toBe(BASE + 5000);

    // A throwing tick does not stop the interval; the next fire succeeds and
    // clears the recorded error.
    await jest.advanceTimersByTimeAsync(5000);
    expect(count).toBe(2);
    expect(scheduler.getProducerStatus("p")?.lastError).toBeNull();

    scheduler.stop();
  });

  it("records a missing-producer error when the tick cannot be resolved", async () => {
    const scheduler = makeScheduler({}); // nothing resolves
    await scheduler.fireNow("ghost");
    expect(scheduler.getProducerStatus("ghost")?.lastError).toMatch(/no producer registered/);
  });

  it("returns undefined status for a never-scheduled producer", () => {
    const scheduler = makeScheduler({});
    expect(scheduler.getProducerStatus("unknown")).toBeUndefined();
  });

  it("clear stops future fires for one producer", async () => {
    let count = 0;
    const scheduler = makeScheduler({ p: async () => { count += 1; } });
    scheduler.applyTrigger("p", { kind: "interval", seconds: 5 });
    scheduler.clear("p");

    await jest.advanceTimersByTimeAsync(20000);
    expect(count).toBe(0);
    expect(scheduler.getProducerStatus("p")).toBeUndefined();
  });
});

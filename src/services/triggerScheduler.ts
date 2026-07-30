/**
 * The trigger scheduler: it arms producer `tick`s on a cadence and never inspects
 * what a producer actually does. A trigger is one of three generic shapes —
 *
 *   - `{ kind: "manual" }`             — never fires on its own; run via {@link
 *                                        TriggerScheduler.fireNow}.
 *   - `{ kind: "interval", seconds }`  — fires every `seconds` seconds.
 *   - `{ kind: "cron", expr }`         — fires on a 5-field cron schedule.
 *
 * Cron uses a minimal in-repo parser (no runtime dependency): five space-
 * separated fields — minute hour day-of-month month day-of-week — each a comma
 * list of a wildcard, a plain number, or a wildcard step "slash n". Day-of-week
 * is 0–6 (0 = Sunday, 7 also
 * accepted as Sunday). Times are evaluated in **UTC** so scheduling is
 * deterministic regardless of host timezone. The classic day-of-month / day-of-
 * week rule applies: when both are restricted (neither is `*`) a minute matches
 * if EITHER matches; when either is `*` both must match.
 *
 * Reconciliation is idempotent: {@link TriggerScheduler.applyTrigger} clears any
 * existing timer for the producer and re-arms from scratch, so applying the same
 * trigger twice leaves exactly one timer. Producer `tick` errors are caught,
 * logged, and recorded on a per-producer status ({@link
 * TriggerScheduler.getProducerStatus}) — a throwing producer never tears down the
 * scheduler or stops future fires.
 *
 * Per the architecture principle this module is domain-neutral: it moves opaque
 * producer ids through a cadence and never learns their intent.
 */

import { log, type Logger } from "../log";

/** A generic firing cadence for a producer. The scheduler never inspects intent. */
export type Trigger =
  | { kind: "manual" }
  | { kind: "interval"; seconds: number }
  | { kind: "cron"; expr: string };

/** The tick a producer id resolves to, or `undefined` when none is registered. */
export type TickResolver = (
  producerId: string
) => (() => Promise<void>) | undefined;

/** Injected collaborators for a {@link TriggerScheduler}. */
export interface TriggerSchedulerDeps {
  /**
   * Resolve a producer id to its `tick`. Typically backed by a
   * {@link import("../modules/registry").ModuleRegistry}. A tick that resolves to
   * `undefined` at fire time records a "no producer" error on the status rather
   * than throwing.
   */
  resolveTick: TickResolver;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Clock returning epoch ms; defaults to `Date.now`. Injectable for tests. */
  clock?: () => number;
}

/** The readable status of one producer's scheduling. */
export interface ProducerStatus {
  producerId: string;
  /** The trigger currently applied, or `null` if only fired manually. */
  trigger: Trigger | null;
  /** Epoch ms of the last tick attempt (success OR failure), or `null`. */
  lastTickAt: number | null;
  /** Error message of the last tick, or `null` when the last tick succeeded. */
  lastError: string | null;
  /** Epoch ms of the next scheduled fire, or `null` for manual/unarmed. */
  nextFireAt: number | null;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Minimal 5-field cron parser + next-fire computation (UTC).
// ---------------------------------------------------------------------------

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when the day-of-month field was literally `*`. */
  domStar: boolean;
  /** True when the day-of-week field was literally `*`. */
  dowStar: boolean;
}

/** Inclusive numeric bounds of each cron field, by position. */
const FIELD_BOUNDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

/**
 * Parse one cron field into the set of matching values. Supports `*`, a plain
 * number, and a wildcard step ("slash n"), combined in a comma list. Throws on
 * any other form or an
 * out-of-range value — a malformed trigger must surface at {@link applyTrigger}
 * time, not fire silently.
 */
function parseField(spec: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  const terms = spec.split(",");
  for (const rawTerm of terms) {
    const term = rawTerm.trim();
    if (term === "") {
      throw new Error(`cron ${name} field has an empty term: "${spec}"`);
    }
    if (term === "*") {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    if (term.startsWith("*/")) {
      const step = Number(term.slice(2));
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`cron ${name} field has an invalid step: "${term}"`);
      }
      for (let v = min; v <= max; v += step) out.add(v);
      continue;
    }
    const n = Number(term);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(
        `cron ${name} field value out of range [${min},${max}]: "${term}"`
      );
    }
    out.add(n);
  }
  return out;
}

/**
 * Parse a 5-field cron expression (minute hour day-of-month month day-of-week).
 * Day-of-week 7 is folded to 0 (Sunday). Throws on the wrong field count or any
 * malformed field.
 */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields, got ${fields.length}: "${expr}"`
    );
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) =>
    parseField(f, FIELD_BOUNDS[i].min, FIELD_BOUNDS[i].max, FIELD_BOUNDS[i].name)
  );
  // Fold Sunday-as-7 onto 0 so it matches Date#getUTCDay (0–6).
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domStar: fields[2] === "*",
    dowStar: fields[4] === "*",
  };
}

/** True when a UTC `date` satisfies the parsed cron schedule. */
function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute.has(date.getUTCMinutes())) return false;
  if (!parsed.hour.has(date.getUTCHours())) return false;
  if (!parsed.month.has(date.getUTCMonth() + 1)) return false;

  const domMatch = parsed.dom.has(date.getUTCDate());
  const dowMatch = parsed.dow.has(date.getUTCDay());
  // Vixie-cron rule: OR the day fields when both are restricted, else AND.
  if (parsed.domStar || parsed.dowStar) {
    return domMatch && dowMatch;
  }
  return domMatch || dowMatch;
}

/** Search horizon: minutes over ~5 years, enough to cover Feb-29-only rules. */
const CRON_HORIZON_MINUTES = 5 * 366 * 24 * 60;

/**
 * The epoch-ms of the first minute strictly after `fromMs` that satisfies `expr`,
 * evaluated in UTC. Throws if `expr` is malformed or no fire time falls within
 * the ~5-year search horizon (e.g. an impossible date like `* * 30 2 *`).
 */
export function cronNextFire(expr: string, fromMs: number): number {
  const parsed = parseCron(expr);
  const cursor = new Date(fromMs);
  // Advance to the start of the next whole minute — fires land on minute
  // boundaries and never at exactly `fromMs`.
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < CRON_HORIZON_MINUTES; i++) {
    if (cronMatches(parsed, cursor)) return cursor.getTime();
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`cron expression has no fire time within horizon: "${expr}"`);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Per-producer bookkeeping held by the scheduler. */
interface Entry {
  trigger: Trigger;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined;
  /**
   * Bumped every time the producer is re-armed or cleared. A timer callback
   * captures the epoch at schedule time and no-ops if it no longer matches, so a
   * fire that was in flight across an {@link TriggerScheduler.applyTrigger} can
   * never re-arm or double-fire a stale schedule.
   */
  epoch: number;
  nextFireAt: number | null;
  lastTickAt: number | null;
  lastError: string | null;
}

/**
 * Arms producer ticks on generic triggers. Construct one per process with a
 * {@link TickResolver}, call {@link TriggerScheduler.applyTrigger} to (re)arm a
 * producer, {@link TriggerScheduler.fireNow} to run one immediately, and
 * {@link TriggerScheduler.stop} to clear every timer at shutdown.
 */
export class TriggerScheduler {
  private readonly resolveTick: TickResolver;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(deps: TriggerSchedulerDeps) {
    this.resolveTick = deps.resolveTick;
    this.logger = (deps.logger ?? log).child({ component: "triggerScheduler" });
    this.clock = deps.clock ?? Date.now;
  }

  /**
   * (Re)arm `producerId` on `trigger`, idempotently: any existing timer is
   * cleared first, so applying a trigger repeatedly leaves exactly one timer.
   * The producer's last-tick status is preserved across a re-arm. Throws if a
   * cron `expr` is malformed or an interval `seconds` is not a positive number —
   * a bad trigger is rejected here rather than firing silently.
   */
  applyTrigger(producerId: string, trigger: Trigger): void {
    if (trigger.kind === "interval") {
      if (!Number.isFinite(trigger.seconds) || trigger.seconds <= 0) {
        throw new Error(
          `interval trigger requires positive seconds, got ${trigger.seconds}`
        );
      }
    } else if (trigger.kind === "cron") {
      // Parse eagerly so a malformed expression throws now, not at fire time.
      parseCron(trigger.expr);
    }

    const entry = this.ensureEntry(producerId);
    this.disarm(entry);
    entry.trigger = trigger;
    entry.epoch += 1;
    entry.nextFireAt = null;
    this.arm(producerId, entry);
    this.logger.info("trigger applied", { producerId, trigger });
  }

  /**
   * Run `producerId`'s tick immediately, independent of its trigger — the manual
   * path, and also usable to force an out-of-band poll. Resolves once the tick
   * settles; the tick's outcome is recorded on the producer status and never
   * rejects.
   */
  async fireNow(producerId: string): Promise<void> {
    this.ensureEntry(producerId);
    await this.runTick(producerId);
  }

  /** The readable status of `producerId`, or `undefined` if never scheduled. */
  getProducerStatus(producerId: string): ProducerStatus | undefined {
    const entry = this.entries.get(producerId);
    if (!entry) return undefined;
    return {
      producerId,
      trigger: entry.trigger,
      lastTickAt: entry.lastTickAt,
      lastError: entry.lastError,
      nextFireAt: entry.nextFireAt,
    };
  }

  /**
   * Clear a single producer's timer and forget it. Bumps the epoch so any timer
   * callback already in flight no-ops. Idempotent.
   */
  clear(producerId: string): void {
    const entry = this.entries.get(producerId);
    if (!entry) return;
    this.disarm(entry);
    entry.epoch += 1;
    this.entries.delete(producerId);
  }

  /** Clear every producer timer. Call at shutdown so nothing holds the process. */
  stop(): void {
    for (const producerId of [...this.entries.keys()]) {
      this.clear(producerId);
    }
  }

  /** Fetch or lazily create the bookkeeping entry for a producer. */
  private ensureEntry(producerId: string): Entry {
    let entry = this.entries.get(producerId);
    if (!entry) {
      entry = {
        trigger: { kind: "manual" },
        timer: undefined,
        epoch: 0,
        nextFireAt: null,
        lastTickAt: null,
        lastError: null,
      };
      this.entries.set(producerId, entry);
    }
    return entry;
  }

  /** Clear an entry's timer, if any. */
  private disarm(entry: Entry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
      clearInterval(entry.timer as ReturnType<typeof setInterval>);
      entry.timer = undefined;
    }
  }

  /** Arm the timer for an entry's current trigger. Manual triggers arm nothing. */
  private arm(producerId: string, entry: Entry): void {
    const { trigger } = entry;
    if (trigger.kind === "interval") {
      const periodMs = trigger.seconds * 1000;
      entry.nextFireAt = this.clock() + periodMs;
      entry.timer = setInterval(() => {
        const current = this.entries.get(producerId);
        if (current) current.nextFireAt = this.clock() + periodMs;
        void this.runTick(producerId);
      }, periodMs);
      entry.timer.unref?.();
    } else if (trigger.kind === "cron") {
      this.armCron(producerId, entry, entry.epoch);
    }
    // manual: nothing to arm.
  }

  /** Schedule the next single cron fire, re-arming after it runs. */
  private armCron(producerId: string, entry: Entry, epoch: number): void {
    if (entry.trigger.kind !== "cron") return;
    const now = this.clock();
    const next = cronNextFire(entry.trigger.expr, now);
    entry.nextFireAt = next;
    entry.timer = setTimeout(() => {
      void this.fireCron(producerId, epoch);
    }, Math.max(0, next - now));
    entry.timer.unref?.();
  }

  /** Run one cron fire and, if the schedule is unchanged, arm the next. */
  private async fireCron(producerId: string, epoch: number): Promise<void> {
    const entry = this.entries.get(producerId);
    if (!entry || entry.epoch !== epoch) return; // superseded by a re-arm/clear
    await this.runTick(producerId);
    const after = this.entries.get(producerId);
    if (after && after.epoch === epoch && after.trigger.kind === "cron") {
      this.armCron(producerId, after, epoch);
    }
  }

  /**
   * Resolve and run a producer's tick, recording the outcome on its status. Any
   * thrown value (or a missing producer) is caught and stored as `lastError`;
   * this method never rejects.
   */
  private async runTick(producerId: string): Promise<void> {
    const entry = this.entries.get(producerId);
    if (!entry) return;

    const tick = this.resolveTick(producerId);
    if (!tick) {
      entry.lastTickAt = this.clock();
      entry.lastError = "no producer registered for id";
      this.logger.warn("tick skipped: no producer registered", { producerId });
      return;
    }

    try {
      await tick();
      entry.lastTickAt = this.clock();
      entry.lastError = null;
    } catch (err) {
      entry.lastTickAt = this.clock();
      entry.lastError = errorMessage(err);
      this.logger.error("producer tick failed", {
        producerId,
        error: entry.lastError,
      });
    }
  }
}

import type { Knex } from "knex";

import { getDb } from "../db/db";
import { countDispatchesCreatedSince, createDispatch } from "../db/dispatches";
import { insertEvent, markEventDispatched } from "../db/events";
import { getPlaybook } from "../db/playbooks";
import { listRules } from "../db/rules";
import { getSetting } from "../db/settings";
import type { EmitResult, EventRecord, NewEvent } from "../interfaces";
import { log, type Logger } from "../log";

import { publish as publishChange } from "./changeBus";
import { deliverForEvent } from "./notifications";
import { matchNotifyTargets, matchRules } from "./ruleEngine";

/** app_settings key controlling the dedupe cooldown window, in seconds. */
export const COOLDOWN_SETTING_KEY = "event_dedupe_cooldown_seconds";

/** Default cooldown window when the setting is absent or unparseable. */
export const DEFAULT_COOLDOWN_SECONDS = 300;

/** app_settings key: the identity that a rule's `@Me` operand resolves to. */
export const IDENTITY_ME_SETTING = "identity_me";

/** app_settings key: max dispatches created from a single event. */
export const MAX_PER_EVENT_SETTING = "dispatch_max_per_event";
/** Default per-event dispatch cap when the setting is absent or unparseable. */
export const DEFAULT_MAX_PER_EVENT = 10;

/** app_settings key: max dispatches created within the trailing hour. */
export const MAX_PER_HOUR_SETTING = "dispatch_max_per_hour";
/** Default per-hour dispatch cap when the setting is absent or unparseable. */
export const DEFAULT_MAX_PER_HOUR = 100;

/**
 * app_settings key: the chain-depth ceiling for callback-driven dispatching. An
 * event whose payload carries a `chain_depth` at or above this cap creates no
 * dispatches, so a rule that reacts to a run outcome by dispatching another run
 * cannot loop forever.
 */
export const MAX_CHAIN_DEPTH_SETTING = "dispatch_max_chain_depth";
/** Default chain-depth cap when the setting is absent or unparseable. */
export const DEFAULT_MAX_CHAIN_DEPTH = 3;

/** The trailing window, in milliseconds, over which the per-hour cap counts. */
const HOUR_MS = 60 * 60 * 1000;

/** Anything the intake can kick to wake the drain loop once work is enqueued. */
export interface Kickable {
  kick(): void;
}

/** Injected collaborators for {@link emitEvent}'s dispatch-wiring step. */
export interface EmitDeps {
  /** Dispatcher to wake once at least one dispatch is enqueued. */
  dispatcher?: Kickable;
  /** Logger for cap-enforcement warnings; defaults to the shared logger. */
  logger?: Logger;
}

/** Per-call options that alter how {@link emitEvent} records an event. */
export interface EmitOptions {
  /**
   * When true, the inserted event is NOT matched against rules and creates no
   * dispatches — it is recorded as a plain event only. Defaults to `false`, so
   * every existing caller keeps the current match-and-dispatch behavior. Used by
   * on-demand materialize paths where a dispatch (if any) is created separately.
   */
  skipRuleMatching?: boolean;
}

/** Row shape used by the suppression lookup. */
interface DedupeRow {
  ts: number;
  dedupe_key: string | null;
  cleared_at: number | null;
}

/**
 * Read a finite numeric `chain_depth` off an event's opaque payload, else null.
 * The payload is never assumed to have a shape — a non-object payload, a missing
 * key, or a non-finite value all yield null (so the chain guard is a no-op).
 */
function readChainDepth(payload: unknown): number | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).chain_depth;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function resolveCooldownSeconds(db: Knex): Promise<number> {
  const raw = await getSetting(COOLDOWN_SETTING_KEY, undefined, db);
  if (raw === undefined) return DEFAULT_COOLDOWN_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_COOLDOWN_SECONDS;
}

/**
 * Read a non-negative integer setting, falling back to `fallback` when the key
 * is unset or its value does not parse to a finite, non-negative number. A cap
 * of 0 is honored (it drops everything) — only garbage falls back.
 */
async function readCapSetting(
  key: string,
  fallback: number,
  db: Knex
): Promise<number> {
  const raw = await getSetting(key, undefined, db);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Wire an inserted event to the dispatch queue: match it against the enabled
 * rules and, subject to the two dispatch caps, create a `queued` dispatch row
 * per surviving target then wake the dispatcher. Returns the timestamp stamped
 * onto the event's `last_dispatched_at`, or `null` when nothing was created.
 *
 * Cap enforcement:
 *   - `dispatch_max_per_hour`: if dispatches created in the trailing hour have
 *     already reached the cap, nothing is created (all-or-nothing rate gate).
 *   - `dispatch_max_per_event`: at most this many targets are kept; any excess
 *     is dropped with a logged warning.
 * Either cap dropping every target leaves `last_dispatched_at` untouched.
 */
async function dispatchForEvent(
  event: EventRecord,
  db: Knex,
  deps: EmitDeps
): Promise<number | null> {
  const logger = deps.logger ?? log;

  // Chain-depth guard: an event that carries a numeric `chain_depth` at or above
  // the cap creates NO dispatches. This bounds callback-driven chains (a rule
  // reacting to a `run.completed`/`run.failed` event by dispatching another run)
  // so they cannot loop forever. Events without a numeric `chain_depth` (every
  // ordinary producer event) are unaffected.
  const chainDepth = readChainDepth(event.payload);
  if (chainDepth !== null) {
    const cap = await readCapSetting(
      MAX_CHAIN_DEPTH_SETTING,
      DEFAULT_MAX_CHAIN_DEPTH,
      db
    );
    if (chainDepth >= cap) {
      logger.warn("dispatch_max_chain_depth reached; creating no dispatches", {
        eventId: event.id,
        chainDepth,
        cap,
      });
      return null;
    }
  }

  const me = (await getSetting(IDENTITY_ME_SETTING, "", db)) ?? "";
  const enabledRules = (await listRules(db)).filter((rule) => rule.enabled);
  const matched = matchRules(event, enabledRules, { me });
  if (matched.length === 0) return null;

  // Per-hour rate gate: an all-or-nothing check on the trailing-hour count.
  const maxPerHour = await readCapSetting(
    MAX_PER_HOUR_SETTING,
    DEFAULT_MAX_PER_HOUR,
    db
  );
  const hourCount = await countDispatchesCreatedSince(Date.now() - HOUR_MS, db);
  if (hourCount >= maxPerHour) {
    logger.warn("dispatch_max_per_hour reached; creating no dispatches", {
      eventId: event.id,
      hourCount,
      cap: maxPerHour,
      matched: matched.length,
    });
    return null;
  }

  // Per-event cap: keep the first N targets, drop and warn on the rest.
  const maxPerEvent = await readCapSetting(
    MAX_PER_EVENT_SETTING,
    DEFAULT_MAX_PER_EVENT,
    db
  );
  let selected = matched;
  if (matched.length > maxPerEvent) {
    selected = matched.slice(0, maxPerEvent);
    logger.warn("dispatch_max_per_event exceeded; dropping excess targets", {
      eventId: event.id,
      matched: matched.length,
      cap: maxPerEvent,
      dropped: matched.length - maxPerEvent,
    });
  }
  if (selected.length === 0) return null;

  // Fail-closed on a dangling target: a rule whose dispatch target names a
  // playbook that no longer exists (e.g. it was deleted while the rule kept
  // pointing at it) must NOT create a dispatch — the `dispatches.playbook_id` FK
  // would otherwise throw and break intake. Skip it with a logged warning so the
  // rest of the matched targets still dispatch.
  let created = 0;
  for (const result of selected) {
    const playbookId = result.target.playbook_id;
    if (!(await getPlaybook(playbookId, db))) {
      logger.warn("rule targets a missing playbook; skipping dispatch", {
        eventId: event.id,
        ruleId: result.ruleId,
        playbookId,
      });
      continue;
    }
    await createDispatch(
      {
        event_id: event.id,
        rule_id: result.ruleId,
        playbook_id: playbookId,
      },
      db
    );
    created += 1;
  }
  if (created === 0) return null;

  const dispatchedAt = Date.now();
  await markEventDispatched(event.id, dispatchedAt, db);
  deps.dispatcher?.kick();
  return dispatchedAt;
}

/**
 * Fire the notify targets of every matching enabled rule for an inserted event.
 *
 * Notify is INDEPENDENT of dispatch: it is NOT subject to the per-event/per-hour
 * dispatch caps or the chain-depth gate (those gate dispatch creation only), so
 * a rule with only notify targets — or a run-callback event that the chain guard
 * would block from dispatching — still delivers its notifications. Each target's
 * delivery is isolated by the delivery service and never throws; this wrapper
 * additionally guards the match/resolve step so a notify failure can never break
 * event intake.
 */
async function notifyForEvent(
  event: EventRecord,
  db: Knex,
  deps: EmitDeps
): Promise<void> {
  const logger = deps.logger ?? log;
  try {
    const me = (await getSetting(IDENTITY_ME_SETTING, "", db)) ?? "";
    const enabledRules = (await listRules(db)).filter((rule) => rule.enabled);
    const matched = matchNotifyTargets(event, enabledRules, { me });
    if (matched.length === 0) return;
    await deliverForEvent(
      event,
      matched.map((result) => result.target),
      db,
      { logger }
    );
  } catch (err) {
    logger.error("notify wiring failed; isolating from intake", {
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record an event, applying dedupe-cooldown suppression.
 *
 * When the event carries a `dedupe_key`, a prior un-cleared event sharing that
 * key whose `ts` falls within the cooldown window (relative to this event's ts)
 * suppresses the new event: nothing is inserted and `{suppressed: true}` is
 * returned. A prior event whose `cleared_at` is set no longer suppresses, so the
 * next matching event re-arms and is inserted (suppress-and-re-arm). Events
 * without a `dedupe_key` are always inserted.
 *
 * A non-suppressed insert is then wired to the dispatch queue: the event is
 * matched against the enabled rules and a `queued` dispatch is created per
 * surviving target (subject to the per-event and per-hour caps), after which the
 * injected dispatcher is kicked. A suppressed event creates no dispatches.
 *
 * The same non-suppressed insert also fires the notify targets of every matching
 * enabled rule (persisting to the notification log). Notify is independent of the
 * dispatch caps and chain-depth gate — a rule may carry dispatch targets, notify
 * targets, or both — and per-notifier delivery failures never break intake.
 *
 * Passing `{ skipRuleMatching: true }` records the event but skips the entire
 * rule-match-and-dispatch-and-notify step (used by on-demand materialize paths);
 * it defaults to false so every existing caller is unaffected.
 */
export async function emitEvent(
  event: NewEvent,
  db: Knex = getDb(),
  deps: EmitDeps = {},
  options: EmitOptions = {}
): Promise<EmitResult> {
  const ts = event.ts ?? Date.now();

  if (event.dedupe_key != null) {
    const cooldownSeconds = await resolveCooldownSeconds(db);
    const windowStart = ts - cooldownSeconds * 1000;

    // Most recent un-cleared event sharing this dedupe_key.
    const prior = await db<DedupeRow>("events")
      .where({ dedupe_key: event.dedupe_key })
      .whereNull("cleared_at")
      .orderBy("ts", "desc")
      .orderBy("id", "desc")
      .first();

    if (prior && prior.ts >= windowStart) {
      return { suppressed: true, reason: "cooldown" };
    }
  }

  const inserted = await insertEvent({ ...event, ts }, db);
  // Signal the live SPA that an event landed. Fire-and-forget: the row is
  // committed and a publish never affects intake.
  publishChange("events");
  // A materialize (or any skip-rule-matching caller) records the event only; it
  // runs no rules, creates no dispatches, and fires no notifiers, leaving
  // last_dispatched_at null.
  if (!options.skipRuleMatching) {
    const dispatchedAt = await dispatchForEvent(inserted, db, deps);
    if (dispatchedAt !== null) inserted.last_dispatched_at = dispatchedAt;
    // Notify fires for every non-suppressed inserted event, independent of the
    // dispatch caps and chain-depth gate above.
    await notifyForEvent(inserted, db, deps);
  }
  return { suppressed: false, event: inserted };
}

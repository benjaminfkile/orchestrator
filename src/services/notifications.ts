/**
 * Notification delivery: render a rule's notify targets against a triggering
 * event and record the outcome in the notification log.
 *
 * `deliverForEvent` is the whole surface. A notification is JUST a notification —
 * there are no delivery kinds. Per fired notifier it ALWAYS (a) inserts exactly
 * one notification-log row (the in-app record backing the inbox) AND (b) makes a
 * best-effort attempt to raise a native desktop toast. A desktop failure never
 * hides the notification: the row stays `delivered` and the toast error is
 * recorded in its `error` column.
 *
 * It is domain-neutral — a notifier's intent lives entirely in its name,
 * `config`, and title/body templates; no code here branches on that content.
 * Delivery is isolated per target and NEVER throws into the caller: a missing
 * notifier or a template that fails to render is recorded (or skipped) rather
 * than propagated, so a bad notifier can never break event intake.
 *
 * Notifiers are a core OUTBOUND-SINK concept and are intentionally exempt from
 * the READ-ONLY rule that constrains integration modules.
 */

import type { Knex } from "knex";

import { getDb } from "../db/db";
import { insertNotification } from "../db/notificationLog";
import { getNotifier } from "../db/notifiers";
import { renderTemplate } from "../executor/prompt";
import type {
  EventRecord,
  NotificationLogRecord,
  NotifierRecord,
  RuleNotifyTarget,
} from "../interfaces";
import { log, type Logger } from "../log";

import {
  showDesktopNotification,
  type DesktopNotification,
  type DesktopNotifyResult,
} from "./desktopNotify";
import { emitNotification } from "./notificationEmitter";

/** Raise a native desktop notification; matches {@link showDesktopNotification}. */
export type ShowDesktop = (
  input: DesktopNotification
) => Promise<DesktopNotifyResult>;

/** Injected collaborators for {@link deliverForEvent}. */
export interface DeliverDeps {
  /** Logger for per-target failures; defaults to the shared logger. */
  logger?: Logger;
  /** Desktop-toast sink; defaults to {@link showDesktopNotification}. */
  showDesktop?: ShowDesktop;
}

/**
 * Render a notifier's title/body templates against `event` using the SAME engine
 * the executor uses for prompts — `{{event.*}}` and `{{payload.*}}` roots, with
 * any unresolved token rendering to the empty string. Reused verbatim so the
 * substitution behavior never drifts from the executor's.
 */
function promptEventOf(event: EventRecord) {
  return {
    id: event.id,
    source: event.source,
    type: event.type,
    subject_ref: event.subject_ref,
    payload: event.payload,
  };
}

function render(notifier: NotifierRecord, event: EventRecord): {
  title: string;
  body: string;
} {
  const promptEvent = promptEventOf(event);
  return {
    title: renderTemplate(notifier.title_template, promptEvent),
    body: renderTemplate(notifier.body_template, promptEvent),
  };
}

/**
 * Append a notification-log row and publish it to the in-process emitter so any
 * live SSE subscriber (the web inbox) sees it immediately. The emit is isolated
 * inside the emitter and never throws, so it cannot affect delivery.
 */
async function persist(
  entry: Parameters<typeof insertNotification>[0],
  db: Knex
): Promise<NotificationLogRecord> {
  const record = await insertNotification(entry, db);
  emitNotification(record);
  return record;
}

/**
 * Deliver `event` through each notify `target`. Per target:
 *   - resolve the notifier; a missing notifier is skipped (no row) and logged;
 *   - a DISABLED notifier is skipped (no row);
 *   - otherwise render the title/body once, insert EXACTLY ONE notification-log
 *     row (the in-app record) and ALWAYS attempt a best-effort desktop toast.
 *
 * A desktop failure never hides the notification: the row is `delivered`
 * regardless, and the toast's error (if any) is recorded in the row's `error`
 * column (else null). Delivery is fully isolated: any thrown error while
 * handling one target is caught and logged, never propagated, so one bad target
 * cannot affect the others or the caller. Returns the rows that were written
 * (skips produce none).
 */
export async function deliverForEvent(
  event: EventRecord,
  targets: RuleNotifyTarget[],
  db: Knex = getDb(),
  deps: DeliverDeps = {}
): Promise<NotificationLogRecord[]> {
  const logger = deps.logger ?? log;
  const showDesktop = deps.showDesktop ?? showDesktopNotification;
  const written: NotificationLogRecord[] = [];

  for (const target of targets) {
    try {
      const notifier = await getNotifier(target.notifier_id, db);
      if (!notifier) {
        logger.warn("notify target references a missing notifier; skipping", {
          eventId: event.id,
          notifierId: target.notifier_id,
        });
        continue;
      }
      if (!notifier.enabled) continue;

      const { title, body } = render(notifier, event);

      // Best-effort desktop toast: attempted for every notification but never
      // allowed to fail or hide it. A failure is captured as the row's error.
      const toast = await showDesktop({ title, body });

      written.push(
        await persist(
          {
            notifier_id: notifier.id,
            event_id: event.id,
            title,
            body,
            status: "delivered",
            error: toast.ok ? undefined : toast.error,
          },
          db
        )
      );
    } catch (err) {
      // Isolate any unexpected failure (a DB error, a notifier resolution error)
      // to this target; delivery must never throw into event intake.
      logger.error("notification delivery failed; isolating target", {
        eventId: event.id,
        notifierId: target.notifier_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return written;
}

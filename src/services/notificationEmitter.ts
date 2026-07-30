/**
 * In-process fan-out for freshly written notification-log rows.
 *
 * This is the single-process bridge between {@link deliverForEvent} (which
 * appends rows) and the SSE endpoint (which streams them to the web inbox). The
 * app runs one process and one user, so a module-local subscriber set is all the
 * plumbing needed — there is no cross-process bus to coordinate.
 *
 * Emission is fully isolated: a subscriber that throws is swallowed so one bad
 * listener can never break notification delivery or the other subscribers.
 */

import type { NotificationLogRecord } from "../interfaces";

/** A subscriber invoked with each newly written notification-log row. */
export type NotificationListener = (record: NotificationLogRecord) => void;

/** Live subscribers; each SSE connection registers exactly one. */
const listeners = new Set<NotificationListener>();

/**
 * Publish a newly written notification to every current subscriber. Errors
 * thrown by a subscriber are caught and ignored so delivery is never affected.
 */
export function emitNotification(record: NotificationLogRecord): void {
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // A misbehaving subscriber must never break delivery or its peers.
    }
  }
}

/**
 * Register `listener` to receive every subsequently emitted notification.
 * Returns an unsubscribe function that removes it; call it when the connection
 * closes.
 */
export function subscribeNotifications(
  listener: NotificationListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

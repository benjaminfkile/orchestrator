// Typed data-access helpers for the notification inbox plus a thin wrapper over
// the Server-Sent Events stream. These wrap the generic `apiFetch` (and the raw
// EventSource) so the bell, provider, and inbox page stay declarative and their
// tests can mock this module wholesale. `/api/notifications` exposes a paged
// read API, an unread count, per-row + bulk mark-read, and a live SSE stream.

import { apiFetch, API_BASE } from "./api";

/** Terminal delivery status of a notification-log row. */
export type NotificationStatus = "delivered" | "failed";

/**
 * A notification-log row as returned by `GET /api/notifications`, newest-first.
 * `read_at` is null until the row is marked read; `notifier_id`/`event_id` are
 * nullable so a row survives deletion of either.
 */
export interface NotificationRecord {
  id: number;
  notifier_id: number | null;
  event_id: number | null;
  title: string;
  body: string;
  status: NotificationStatus;
  error: string | null;
  read_at: number | null;
  created_at: number;
}

/** Query parameters for a page of notifications (newest-first, id cursor). */
export interface ListNotificationsParams {
  /** Maximum rows to return. */
  limit?: number;
  /** Return only rows with an id strictly less than this cursor. */
  cursor?: number;
  /** When true, return only unread rows. */
  unread?: boolean;
  /** Free-text search; each whitespace term must match (backend `q` param). */
  q?: string;
}

/** Fetch a page of notifications, newest-first. */
export function listNotifications(
  params: ListNotificationsParams = {},
): Promise<NotificationRecord[]> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor !== undefined) query.set("cursor", String(params.cursor));
  if (params.unread) query.set("unread", "1");
  if (params.q !== undefined && params.q.trim() !== "") query.set("q", params.q);
  const qs = query.toString();
  return apiFetch<NotificationRecord[]>(`/notifications${qs ? `?${qs}` : ""}`);
}

/** Fetch the count of rows not yet marked read. */
export async function getUnreadCount(): Promise<number> {
  const { count } = await apiFetch<{ count: number }>(
    `/notifications/unread-count`,
  );
  return count;
}

/** Mark a single notification read; resolves to the updated record. */
export function markNotificationRead(id: number): Promise<NotificationRecord> {
  return apiFetch<NotificationRecord>(`/notifications/${id}/read`, {
    method: "POST",
  });
}

/** Mark every unread notification read; resolves to the number updated. */
export async function markAllNotificationsRead(): Promise<number> {
  const { updated } = await apiFetch<{ updated: number }>(
    `/notifications/read-all`,
    { method: "POST" },
  );
  return updated;
}

/** Callbacks for {@link subscribeNotificationStream}. */
export interface NotificationStreamHandlers {
  /** Invoked with each newly written notification pushed over the stream. */
  onNotification: (record: NotificationRecord) => void;
  /** Optional transport-error hook (the browser auto-reconnects EventSources). */
  onError?: (event: Event) => void;
}

/**
 * Open a live SSE connection to `/api/notifications/stream` and invoke
 * `onNotification` for each pushed row. Returns an unsubscribe function that
 * closes the connection; call it on unmount. Malformed frames are ignored so a
 * single bad payload cannot break the stream.
 */
export function subscribeNotificationStream(
  handlers: NotificationStreamHandlers,
): () => void {
  // Non-browser hosts (SSR, test runners) may lack EventSource; degrade to a
  // no-op subscription rather than throwing into the caller's effect.
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`${API_BASE}/notifications/stream`);
  source.onmessage = (event) => {
    try {
      handlers.onNotification(JSON.parse(event.data) as NotificationRecord);
    } catch {
      // Ignore a malformed frame; the stream stays open for the next one.
    }
  };
  if (handlers.onError) source.onerror = handlers.onError;
  return () => source.close();
}

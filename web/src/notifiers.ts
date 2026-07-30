// Typed data-access helpers for the Notifiers management page. These wrap the
// generic `apiFetch` in named, strongly-typed calls so the page stays
// declarative and its tests can mock this module wholesale. `/api/notifiers`
// exposes CRUD. A notification is JUST a notification — there is no delivery
// `kind`: every fired notifier always lands in the in-app log AND best-effort
// raises a desktop toast. `config` is kept for future use.

import { apiFetch } from "./api";

/** A notifier record as returned by `GET /api/notifiers`, id ascending. */
export interface NotifierRecord {
  id: number;
  name: string;
  config: Record<string, unknown>;
  title_template: string;
  body_template: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Fields sent when creating a notifier; only name is required. */
export interface NewNotifier {
  name: string;
  config?: Record<string, unknown>;
  title_template?: string;
  body_template?: string;
  enabled?: boolean;
}

/** Fields sent when updating a notifier. Any omitted field is left unchanged. */
export interface NotifierUpdate {
  name?: string;
  config?: Record<string, unknown>;
  title_template?: string;
  body_template?: string;
  enabled?: boolean;
}

/** List all notifiers ordered by id ascending. */
export function listNotifiers(): Promise<NotifierRecord[]> {
  return apiFetch<NotifierRecord[]>(`/notifiers`);
}

/** Create a notifier; resolves to the stored record. */
export function createNotifier(notifier: NewNotifier): Promise<NotifierRecord> {
  return apiFetch<NotifierRecord>(`/notifiers`, {
    method: "POST",
    body: notifier,
  });
}

/** Apply a partial update to a notifier; resolves to the updated record. */
export function updateNotifier(
  id: number,
  patch: NotifierUpdate,
): Promise<NotifierRecord> {
  return apiFetch<NotifierRecord>(`/notifiers/${id}`, {
    method: "PATCH",
    body: patch,
  });
}

/** Delete a notifier by id. Resolves once the backend returns 204. */
export function deleteNotifier(id: number): Promise<void> {
  return apiFetch<void>(`/notifiers/${id}`, { method: "DELETE" });
}

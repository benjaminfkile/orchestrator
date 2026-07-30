// Thin wrapper over the app-wide change stream. `GET /api/changes/stream` is a
// Server-Sent Events feed of `{resource, ts}` frames — one per coalesced data
// change (see the backend change bus). The shell subscribes once and fans each
// resource name out to the pages watching it, which refetch their current query.
// Isolating the raw EventSource here keeps the provider declarative and lets its
// tests mock this module wholesale (mirrors `notifications.ts`).

import { API_BASE } from "./api";

/** A change frame pushed over the stream: which resource changed, and when. */
export interface ResourceChange {
  /** Opaque resource name, e.g. `"playbooks"`; never branched on. */
  resource: string;
  /** Broadcast time in epoch milliseconds. */
  ts: number;
}

/** Callbacks for {@link subscribeChangeStream}. */
export interface ChangeStreamHandlers {
  /** Invoked with each pushed change frame. */
  onChange: (change: ResourceChange) => void;
  /**
   * Invoked each time the connection (re)opens. The browser auto-reconnects a
   * dropped EventSource; callers use this to trigger a catch-up refetch for
   * frames that may have been missed while the socket was down.
   */
  onOpen?: () => void;
  /** Optional transport-error hook (the browser auto-reconnects EventSources). */
  onError?: (event: Event) => void;
}

/**
 * Open a live SSE connection to `/api/changes/stream` and invoke `onChange` for
 * each pushed frame (and `onOpen` on every (re)connect). Returns an unsubscribe
 * function that closes the connection; call it on unmount. Malformed frames are
 * ignored so a single bad payload cannot break the stream.
 */
export function subscribeChangeStream(
  handlers: ChangeStreamHandlers,
): () => void {
  // Non-browser hosts (SSR, test runners) may lack EventSource; degrade to a
  // no-op subscription rather than throwing into the caller's effect.
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`${API_BASE}/changes/stream`);
  source.onmessage = (event) => {
    try {
      handlers.onChange(JSON.parse(event.data) as ResourceChange);
    } catch {
      // Ignore a malformed frame; the stream stays open for the next one.
    }
  };
  if (handlers.onOpen) source.onopen = handlers.onOpen;
  if (handlers.onError) source.onerror = handlers.onError;
  return () => source.close();
}

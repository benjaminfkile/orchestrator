/**
 * In-process change bus: a resource-granular "something changed" signal.
 *
 * Every successful data mutation publishes the name of the resource that
 * changed (a plain string — `"playbooks"`, `"dispatches"`, `"events"`, …); a
 * single SSE endpoint (see the changes-stream router) fans those names out to
 * the live SPA, which refetches the affected query. The app runs one process
 * and one user, so a module-local subscriber set is all the plumbing needed —
 * there is no cross-process bus to coordinate.
 *
 * Two load-bearing properties keep this safe to call from anywhere on a write
 * path:
 *
 *   - **Fire-and-forget.** {@link publish} never throws into its caller. A
 *     publish is a best-effort side effect of a write that has already
 *     committed; it must never be able to fail the request that triggered it.
 *   - **Per-resource coalescing.** Bursts of publishes for the SAME resource
 *     inside a short window collapse into ONE broadcast, so a busy dispatch
 *     pipeline flipping a row through several statuses does not spam the wire.
 *     The broadcast fires on the trailing edge of the window, so subscribers
 *     always see it after the underlying writes have landed.
 *
 * Resource names are opaque strings with no domain intent — the code never
 * branches on their content.
 */

/** A published change: the resource that changed and when it was broadcast. */
export interface ResourceChange {
  /** Opaque resource name, e.g. `"playbooks"`; never branched on. */
  resource: string;
  /** Broadcast time in epoch milliseconds. */
  ts: number;
}

/** A subscriber invoked once per coalesced broadcast. */
export type ChangeListener = (change: ResourceChange) => void;

/**
 * Coalescing window in milliseconds: publishes for one resource within this
 * span of the first collapse into a single trailing-edge broadcast.
 */
export const COALESCE_WINDOW_MS = 500;

/** Live subscribers; each SSE connection registers exactly one. */
const listeners = new Set<ChangeListener>();

/** Resources with a broadcast already scheduled, keyed to their pending timer. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Deliver a coalesced change to every current subscriber, isolating throws. */
function broadcast(resource: string): void {
  const change: ResourceChange = { resource, ts: Date.now() };
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // A misbehaving subscriber must never break a peer or the write path.
    }
  }
}

/**
 * Publish that `resource` changed. The first publish for a resource schedules a
 * single broadcast one coalescing window later; further publishes for the same
 * resource within that window are folded into it (they do not extend it). Never
 * throws — a publish is a fire-and-forget side effect of an already-committed
 * write.
 *
 * @param resource opaque resource name to broadcast
 * @param windowMs coalescing window; defaults to {@link COALESCE_WINDOW_MS}
 */
export function publish(
  resource: string,
  windowMs: number = COALESCE_WINDOW_MS
): void {
  try {
    if (pending.has(resource)) return;
    const timer = setTimeout(() => {
      pending.delete(resource);
      broadcast(resource);
    }, windowMs);
    // Never let a pending coalesce timer hold the process open on its own.
    if (typeof timer.unref === "function") timer.unref();
    pending.set(resource, timer);
  } catch {
    // Fire-and-forget: a scheduling failure must never fail the caller's write.
  }
}

/**
 * Register `listener` to receive every subsequent coalesced broadcast. Returns
 * an unsubscribe function that removes it; call it when the connection closes.
 */
export function subscribe(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

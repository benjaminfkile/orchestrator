// Resolves where clicking a notification row should take the user, derived
// PURELY from the generic shape of the triggering event's opaque payload. This
// is domain-neutral by construction (per CLAUDE.md): it never branches on event
// type strings or intent words, only on the presence/type of well-known fields —
// exactly the EventSubjectFields convention (read `payload.url` only when it
// happens to be a string, etc.). No payload shape is ever assumed.

/** A minimal view of an event: its id and its already-parsed opaque payload. */
export interface ResolvableEvent {
  id: number;
  payload: unknown;
}

/**
 * The navigation target for a clicked notification, in precedence order:
 *
 *  - `run`      — the payload carries a finite numeric dispatch identifier (the
 *                 id the `/runs/:id` detail route resolves via `getDispatch`);
 *                 navigate to that run's detail page.
 *  - `external` — the payload carries a string `url`; open it in a new tab.
 *  - `event`    — neither of the above; focus the triggering event on the Events
 *                 page.
 *  - `none`     — there is no event to resolve (null `event_id` or a 404).
 */
export type NotificationTarget =
  | { kind: "run"; dispatchId: number }
  | { kind: "external"; url: string }
  | { kind: "event"; eventId: number }
  | { kind: "none" };

/**
 * Resolve the click target for a notification from its triggering event.
 *
 * `null`/`undefined` (no `event_id`, or the event fetch 404'd) resolves to
 * `none`. Fields are read only when they carry the expected type, so a payload
 * of an unexpected shape simply falls through to the Events-page focus.
 */
export function resolveNotificationTarget(
  event: ResolvableEvent | null | undefined,
): NotificationTarget {
  if (!event) return { kind: "none" };

  const { payload } = event;
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;

    // (a) A finite numeric dispatch id → the run detail route (`/runs/:id`,
    // which resolves the id as a dispatch, not a run). Read generically: only
    // when the field is actually a finite number.
    const dispatchId = record.dispatch_id;
    if (typeof dispatchId === "number" && Number.isFinite(dispatchId)) {
      return { kind: "run", dispatchId };
    }

    // (b) A string `url` → an external subject (e.g. a work item); open it.
    const url = record.url;
    if (typeof url === "string" && url !== "") {
      return { kind: "external", url };
    }
  }

  // (c) Fall back to focusing the event itself on the Events page.
  return { kind: "event", eventId: event.id };
}

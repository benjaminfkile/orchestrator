import { describe, expect, it } from "vitest";

import { resolveNotificationTarget } from "./notificationTarget";

describe("resolveNotificationTarget", () => {
  it("returns none for a null event (null event_id or a 404)", () => {
    expect(resolveNotificationTarget(null)).toEqual({ kind: "none" });
    expect(resolveNotificationTarget(undefined)).toEqual({ kind: "none" });
  });

  it("prefers a finite numeric dispatch id → run detail", () => {
    const target = resolveNotificationTarget({
      id: 7,
      payload: { dispatch_id: 42, url: "https://example.com/x", run_id: 99 },
    });
    expect(target).toEqual({ kind: "run", dispatchId: 42 });
  });

  it("falls through to url when the dispatch id is not a finite number", () => {
    expect(
      resolveNotificationTarget({
        id: 7,
        payload: { dispatch_id: "42", url: "https://example.com/x" },
      }),
    ).toEqual({ kind: "external", url: "https://example.com/x" });

    expect(
      resolveNotificationTarget({
        id: 7,
        payload: { dispatch_id: Infinity, url: "https://example.com/x" },
      }),
    ).toEqual({ kind: "external", url: "https://example.com/x" });
  });

  it("opens a string url when there is no dispatch id", () => {
    const target = resolveNotificationTarget({
      id: 7,
      payload: { url: "https://dev.azure.com/item/1" },
    });
    expect(target).toEqual({
      kind: "external",
      url: "https://dev.azure.com/item/1",
    });
  });

  it("ignores a non-string or empty url", () => {
    expect(
      resolveNotificationTarget({ id: 7, payload: { url: 123 } }),
    ).toEqual({ kind: "event", eventId: 7 });
    expect(
      resolveNotificationTarget({ id: 7, payload: { url: "" } }),
    ).toEqual({ kind: "event", eventId: 7 });
  });

  it("focuses the event when the payload carries neither field", () => {
    expect(
      resolveNotificationTarget({ id: 13, payload: { foo: "bar" } }),
    ).toEqual({ kind: "event", eventId: 13 });
  });

  it("focuses the event for a non-object or null payload", () => {
    expect(resolveNotificationTarget({ id: 5, payload: null })).toEqual({
      kind: "event",
      eventId: 5,
    });
    expect(resolveNotificationTarget({ id: 5, payload: "nope" })).toEqual({
      kind: "event",
      eventId: 5,
    });
  });
});

import type { NotificationLogRecord } from "../interfaces";

import {
  emitNotification,
  subscribeNotifications,
} from "./notificationEmitter";

function record(id: number): NotificationLogRecord {
  return {
    id,
    notifier_id: 1,
    event_id: 1,
    title: `t${id}`,
    body: "b",
    status: "delivered",
    error: null,
    read_at: null,
    created_at: 1_700_000_000_000,
  };
}

describe("notificationEmitter", () => {
  it("delivers each emission to every current subscriber", () => {
    const a: NotificationLogRecord[] = [];
    const b: NotificationLogRecord[] = [];
    const offA = subscribeNotifications((r) => a.push(r));
    const offB = subscribeNotifications((r) => b.push(r));

    emitNotification(record(1));
    emitNotification(record(2));

    expect(a.map((r) => r.id)).toEqual([1, 2]);
    expect(b.map((r) => r.id)).toEqual([1, 2]);
    offA();
    offB();
  });

  it("stops delivering after unsubscribe", () => {
    const seen: number[] = [];
    const off = subscribeNotifications((r) => seen.push(r.id));
    emitNotification(record(1));
    off();
    emitNotification(record(2));
    expect(seen).toEqual([1]);
  });

  it("isolates a throwing subscriber from its peers", () => {
    const seen: number[] = [];
    const offBad = subscribeNotifications(() => {
      throw new Error("boom");
    });
    const offGood = subscribeNotifications((r) => seen.push(r.id));

    expect(() => emitNotification(record(7))).not.toThrow();
    expect(seen).toEqual([7]);
    offBad();
    offGood();
  });
});

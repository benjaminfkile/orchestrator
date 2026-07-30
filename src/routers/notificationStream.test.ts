import { EventEmitter } from "events";

import type { Request, Response } from "express";

import type { NotificationLogRecord } from "../interfaces";
import type { NotificationListener } from "../services/notificationEmitter";

import { streamNotifications } from "./notificationStream";

/** Minimal Response double capturing headers, body writes, and the close hook. */
function fakeResponse() {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    writableEnded: false,
    destroyed: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    flushHeaders() {},
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener);
      return this;
    },
    close() {
      emitter.emit("close");
    },
  };
  return { res: res as unknown as Response, writes, headers };
}

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

describe("streamNotifications", () => {
  it("writes SSE headers and a data frame per emitted notification", async () => {
    let emit: NotificationListener = () => {};
    const subscribe = (listener: NotificationListener) => {
      emit = listener;
      return () => {};
    };
    const { res, writes, headers } = fakeResponse();

    const done = streamNotifications({} as Request, res, {
      subscribe,
      heartbeatMs: 100_000,
    });

    expect(headers["Content-Type"]).toContain("text/event-stream");
    expect(headers["Cache-Control"]).toBe("no-cache");

    emit(record(1));
    emit(record(2));

    expect(writes).toEqual([
      `data: ${JSON.stringify(record(1))}\n\n`,
      `data: ${JSON.stringify(record(2))}\n\n`,
    ]);

    (res as unknown as { close: () => void }).close();
    await done;
  });

  it("unsubscribes when the client disconnects", async () => {
    let unsubscribed = false;
    const subscribe = () => () => {
      unsubscribed = true;
    };
    const { res } = fakeResponse();

    const done = streamNotifications({} as Request, res, {
      subscribe,
      heartbeatMs: 100_000,
    });
    (res as unknown as { close: () => void }).close();
    await done;

    expect(unsubscribed).toBe(true);
  });
});

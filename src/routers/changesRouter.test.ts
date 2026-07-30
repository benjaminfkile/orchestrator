import { EventEmitter } from "events";

import type { Request, Response } from "express";

import type { ChangeListener, ResourceChange } from "../services/changeBus";

import { streamChanges } from "./changesRouter";

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

function change(resource: string): ResourceChange {
  return { resource, ts: 1_700_000_000_000 };
}

describe("streamChanges", () => {
  it("writes SSE headers and a data frame per emitted change", async () => {
    let emit: ChangeListener = () => {};
    const subscribe = (listener: ChangeListener) => {
      emit = listener;
      return () => {};
    };
    const { res, writes, headers } = fakeResponse();

    const done = streamChanges({} as Request, res, {
      subscribe,
      heartbeatMs: 100_000,
    });

    expect(headers["Content-Type"]).toContain("text/event-stream");
    expect(headers["Cache-Control"]).toBe("no-cache");

    emit(change("playbooks"));
    emit(change("dispatches"));

    expect(writes).toEqual([
      `data: ${JSON.stringify(change("playbooks"))}\n\n`,
      `data: ${JSON.stringify(change("dispatches"))}\n\n`,
    ]);

    (res as unknown as { close: () => void }).close();
    await done;
  });

  it("writes a heartbeat comment on the ping interval", async () => {
    jest.useFakeTimers();
    try {
      const { res, writes } = fakeResponse();
      const done = streamChanges({} as Request, res, {
        subscribe: () => () => {},
        heartbeatMs: 1_000,
      });

      jest.advanceTimersByTime(2_500);
      expect(writes).toEqual([`: ping\n\n`, `: ping\n\n`]);

      (res as unknown as { close: () => void }).close();
      await done;
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("unsubscribes when the client disconnects", async () => {
    let unsubscribed = false;
    const subscribe = () => () => {
      unsubscribed = true;
    };
    const { res } = fakeResponse();

    const done = streamChanges({} as Request, res, {
      subscribe,
      heartbeatMs: 100_000,
    });
    (res as unknown as { close: () => void }).close();
    await done;

    expect(unsubscribed).toBe(true);
  });
});

import type { Request, Response } from "express";

import {
  subscribeNotifications,
  type NotificationListener,
} from "../services/notificationEmitter";

/** Subscribe to notification emissions; matches {@link subscribeNotifications}. */
export type Subscribe = (listener: NotificationListener) => () => void;

/** Resolved timings/collaborators for a single SSE connection. */
export interface StreamOptions {
  /** Emitter subscription; defaults to the shared {@link subscribeNotifications}. */
  subscribe?: Subscribe;
  /** Comment-ping interval keeping the connection warm. Defaults to 15s. */
  heartbeatMs?: number;
}

/**
 * Stream newly written notifications to the client as Server-Sent Events. Each
 * emitted `notification_log` row is written as one `data:` frame carrying the
 * JSON record; a periodic comment ping keeps intermediaries from idling the
 * connection shut. The subscription is torn down when the client disconnects.
 *
 * Mirrors the streamed-endpoint precedent (see {@link streamDispatchLog}): the
 * returned promise resolves only once the response is closed, so the route
 * handler's async chain completes when the stream ends.
 */
export function streamNotifications(
  _req: Request,
  res: Response,
  opts: StreamOptions = {}
): Promise<void> {
  const subscribe = opts.subscribe ?? subscribeNotifications;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Send headers now so the browser's EventSource opens immediately rather than
  // waiting on the first notification.
  res.flushHeaders();

  return new Promise<void>((resolve) => {
    const unsubscribe = subscribe((record) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`data: ${JSON.stringify(record)}\n\n`);
    });

    // A bare comment line is a valid SSE frame the client ignores; it keeps
    // proxies from treating an idle stream as dead.
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`: ping\n\n`);
    }, heartbeatMs);
    // Never let the ping timer hold the process open on its own.
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      resolve();
    });
  });
}

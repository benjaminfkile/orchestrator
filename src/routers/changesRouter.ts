import express from "express";
import type { Request, Response } from "express";

import {
  subscribe as subscribeChanges,
  type ChangeListener,
} from "../services/changeBus";

import { handler } from "./http";

/** Subscribe to change-bus broadcasts; matches {@link subscribeChanges}. */
export type Subscribe = (listener: ChangeListener) => () => void;

/** Resolved timings/collaborators for a single SSE connection. */
export interface StreamOptions {
  /** Change-bus subscription; defaults to the shared {@link subscribeChanges}. */
  subscribe?: Subscribe;
  /** Comment-ping interval keeping the connection warm. Defaults to 15s. */
  heartbeatMs?: number;
}

/**
 * Stream coalesced resource changes to the client as Server-Sent Events. Each
 * broadcast is written as one `data:` frame carrying `{resource, ts}`; a
 * periodic comment ping keeps intermediaries from idling the connection shut.
 * The subscription is torn down when the client disconnects.
 *
 * Modeled directly on the notification stream (see `streamNotifications`): same
 * headers, same heartbeat/cleanup convention. The returned promise resolves only
 * once the response is closed, so the route handler's async chain completes when
 * the stream ends.
 */
export function streamChanges(
  _req: Request,
  res: Response,
  opts: StreamOptions = {}
): Promise<void> {
  const subscribe = opts.subscribe ?? subscribeChanges;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Send headers now so the browser's EventSource opens immediately rather than
  // waiting on the first change.
  res.flushHeaders();

  return new Promise<void>((resolve) => {
    const unsubscribe = subscribe((change) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`data: ${JSON.stringify(change)}\n\n`);
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

/**
 * `/api/changes` — the live data-change signal for the SPA.
 *
 *   GET /stream   Server-Sent Events: one `{resource, ts}` frame per coalesced
 *                 data change, so an open page can refetch its current query
 *                 whenever its resource is named.
 */
const changesRouter = express.Router();

changesRouter.get(
  "/stream",
  handler(async (req, res) => {
    await streamChanges(req, res);
  })
);

export default changesRouter;

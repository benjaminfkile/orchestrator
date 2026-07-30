import fs from "fs";

import type { Request, Response } from "express";

import { getDispatch } from "../db/dispatches";

/** Statuses at which a dispatch is finished and its log stops growing. */
const TERMINAL_STATUSES = new Set(["done", "failed"]);

/** Resolved timings for a single tail; supplied by the router with defaults. */
export interface TailOptions {
  /** Dispatch id whose log is being tailed (also used for the status poll). */
  id: number;
  /** Absolute path of the log file to stream. */
  logPath: string;
  /** Interval between reads for appended bytes. */
  pollIntervalMs: number;
  /** Interval between terminal-status checks. */
  statusIntervalMs: number;
}

/**
 * Tail a dispatch's log file over a chunked `text/plain` response: emit whatever
 * the file already holds, then poll every `pollIntervalMs` for appended bytes,
 * closing the response once the dispatch reaches a terminal status (checked
 * every `statusIntervalMs`) or the client disconnects.
 *
 * The returned promise resolves when the response is closed for any reason, so
 * the route handler's async chain completes only after the stream is done.
 */
export function streamDispatchLog(
  _req: Request,
  res: Response,
  opts: TailOptions
): Promise<void> {
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  // Defeat proxy/browser buffering so appended lines surface as they are read.
  res.setHeader("Cache-Control", "no-cache");
  // Send headers now (before any body) so the client sees a live chunked stream
  // rather than waiting on the first write.
  res.flushHeaders();

  return new Promise<void>((resolve) => {
    let done = false;
    // Byte offset already delivered to the client; only bytes beyond it are sent.
    let offset = 0;
    // Guards against a slow read overlapping the next poll tick.
    let reading = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let statusTimer: NodeJS.Timeout | undefined;

    /** Read any bytes appended since `offset` and write them to the response. */
    const flushAppended = async (): Promise<void> => {
      if (reading || res.writableEnded || res.destroyed) return;
      reading = true;
      try {
        const stat = await fs.promises.stat(opts.logPath);
        if (stat.size > offset && !res.writableEnded && !res.destroyed) {
          const length = stat.size - offset;
          const buf = Buffer.alloc(length);
          const fd = await fs.promises.open(opts.logPath, "r");
          try {
            await fd.read(buf, 0, length, offset);
          } finally {
            await fd.close();
          }
          offset += length;
          res.write(buf);
        }
      } catch {
        // The file vanished or a read failed; stop tailing and let the terminal
        // check (or client disconnect) close the response.
      } finally {
        reading = false;
      }
    };

    const stop = (): void => {
      done = true;
      if (pollTimer) clearInterval(pollTimer);
      if (statusTimer) clearInterval(statusTimer);
    };

    /** Flush any final bytes then end the response cleanly. */
    const finish = async (): Promise<void> => {
      if (done) return;
      await flushAppended();
      if (done) return;
      stop();
      res.end();
    };

    /** Close the stream once the dispatch is finished (or has disappeared). */
    const checkStatus = async (): Promise<void> => {
      if (done) return;
      try {
        const dispatch = await getDispatch(opts.id);
        if (!dispatch || TERMINAL_STATUSES.has(dispatch.status)) {
          await finish();
        }
      } catch {
        // A transient status read failure should not tear the stream down; the
        // next tick retries, and a client disconnect still closes it.
      }
    };

    // A client disconnect (or the normal `res.end()` above) closes the response;
    // either way tear down the timers and resolve.
    res.on("close", () => {
      stop();
      resolve();
    });

    void (async () => {
      // Deliver the current contents first.
      await flushAppended();
      if (done) return;
      // Close immediately if the dispatch is already terminal, otherwise arm the
      // append and status polls.
      await checkStatus();
      if (done) return;
      pollTimer = setInterval(() => void flushAppended(), opts.pollIntervalMs);
      statusTimer = setInterval(() => void checkStatus(), opts.statusIntervalMs);
    })();
  });
}

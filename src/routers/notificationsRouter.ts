import express from "express";

import {
  countUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../db/notificationLog";

import {
  handler,
  parseIdParam,
  parseIntQuery,
  parseSearchQuery,
} from "./http";
import { streamNotifications } from "./notificationStream";

/**
 * `/api/notifications` — read + read-state for the notification-log inbox.
 *
 *   GET  /                newest-first, cursor-paginated (`limit`, `cursor`),
 *                         `unread=1` restricts to unread rows, `?q=` free-text
 *                         searches title/body/status/error
 *   GET  /unread-count    { count } of rows not yet marked read
 *   GET  /stream          Server-Sent Events: one frame per newly written row
 *   POST /:id/read        mark one row read, 404 when absent
 *   POST /read-all        mark every unread row read, returns { updated }
 */
const notificationsRouter = express.Router();

/** Upper bound on a single page of notifications. */
const MAX_LIMIT = 500;

notificationsRouter.get(
  "/",
  handler(async (req, res) => {
    const limit = parseIntQuery(req.query.limit, "limit", 1, MAX_LIMIT) ?? 50;
    const cursor = parseIntQuery(
      req.query.cursor,
      "cursor",
      1,
      Number.MAX_SAFE_INTEGER
    );
    const unreadOnly = req.query.unread === "1";
    const q = parseSearchQuery(req.query.q);
    const notifications = await listNotifications({
      limit,
      cursor,
      unreadOnly,
      q,
    });
    res.status(200).json(notifications);
  })
);

notificationsRouter.get(
  "/unread-count",
  handler(async (_req, res) => {
    res.status(200).json({ count: await countUnread() });
  })
);

notificationsRouter.get(
  "/stream",
  handler(async (req, res) => {
    await streamNotifications(req, res);
  })
);

notificationsRouter.post(
  "/read-all",
  handler(async (_req, res) => {
    const updated = await markAllNotificationsRead();
    res.status(200).json({ updated });
  })
);

notificationsRouter.post(
  "/:id/read",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const updated = await markNotificationRead(id);
    if (!updated) {
      res.status(404).json({ error: "notification not found" });
      return;
    }
    res.status(200).json(updated);
  })
);

export default notificationsRouter;

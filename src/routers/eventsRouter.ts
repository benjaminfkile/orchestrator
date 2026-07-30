import express from "express";

import { getEventById, getEventFacets, listEvents } from "../db/events";
import { getRuntime } from "../runtime";

import {
  handler,
  parseIdParam,
  parseIntQuery,
  parseSearchQuery,
} from "./http";

/**
 * `/api/events` — read-only access to the recorded event stream.
 *
 *   GET /            newest-first, cursor-paginated by id (`limit`, `before`);
 *                    `?q=` free-text searches source/type/subject/payload JSON
 *   GET /facets      distinct `source`/`type` values, for filter/rule pickers
 *   GET /:id         a single event, 404 when absent
 */
const eventsRouter = express.Router();

/** Sort a set of strings ascending into a fresh array. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Upper bound on a single page of events. */
const MAX_LIMIT = 500;

eventsRouter.get(
  "/",
  handler(async (req, res) => {
    const limit = parseIntQuery(req.query.limit, "limit", 1, MAX_LIMIT) ?? 50;
    const before = parseIntQuery(
      req.query.before,
      "before",
      1,
      Number.MAX_SAFE_INTEGER
    );
    const q = parseSearchQuery(req.query.q);
    const events = await listEvents({ limit, cursor: before, q });
    res.status(200).json(events);
  })
);

eventsRouter.get(
  "/facets",
  handler(async (_req, res) => {
    const facets = await getEventFacets();
    // Merge in the event types the registered modules advertise, so a fresh
    // install with an empty events table still offers suggestions. The registry
    // is optional (no modules wired → DB distincts only); sources come solely
    // from recorded events since modules don't advertise a source vocabulary.
    const moduleTypes = getRuntime().registry?.listEventTypes() ?? [];
    res.status(200).json({
      sources: facets.sources,
      types: sortedUnique([...facets.types, ...moduleTypes]),
    });
  })
);

eventsRouter.get(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const event = await getEventById(id);
    if (!event) {
      res.status(404).json({ error: "event not found" });
      return;
    }
    res.status(200).json(event);
  })
);

export default eventsRouter;

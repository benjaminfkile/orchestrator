import express from "express";

import {
  getEventById,
  getEventFacets,
  getLatestUnclearedEventByDedupeKey,
  listEvents,
} from "../db/events";
import { log } from "../log";
import { getRuntime } from "../runtime";
import { emitEvent } from "../services/eventIntake";

import {
  handler,
  HttpError,
  isPlainObject,
  optionalString,
  parseIdParam,
  parseIntQuery,
  parseSearchQuery,
  rejectUnknownKeys,
  requireBody,
  requireString,
} from "./http";

/**
 * `/api/events` covers the recorded event stream plus a manual mint entry point.
 *
 *   GET /            newest-first, cursor-paginated by id (`limit`, `before`);
 *                    `?q=` free-text searches source/type/subject/payload JSON
 *   GET /facets      distinct `source`/`type` values, for filter/rule pickers
 *   GET /:id         a single event, 404 when absent
 *   POST /           mint a synthetic event through the normal intake so a
 *                    dispatch can be created on a fresh stack that has no
 *                    integration modules configured. Body:
 *                      { source?     default "manual"
 *                      , type        required, e.g. "test.manual"
 *                      , subject_ref required
 *                      , subject_kind? default "manual"
 *                      , payload?    optional JSON object }
 *                    A deterministic `dedupe_key`
 *                    (`manual:<source>:<type>:<subject_ref>`) is applied so the
 *                    normal cooldown collapses repeats: a first mint returns
 *                    201 with the created event, a mint that lands inside the
 *                    cooldown returns 200 with the existing event. The event is
 *                    published on the change bus and matched against rules the
 *                    same way any produced event is.
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

/** The keys a manual-mint request body may carry. */
const MANUAL_EVENT_KEYS = [
  "source",
  "type",
  "subject_ref",
  "subject_kind",
  "payload",
] as const;

/** Default `source` when the caller omits it. */
const DEFAULT_MANUAL_SOURCE = "manual";
/** Default `subject_kind` when the caller omits it. */
const DEFAULT_MANUAL_SUBJECT_KIND = "manual";

eventsRouter.post(
  "/",
  handler(async (req, res) => {
    const body = requireBody(req.body);
    rejectUnknownKeys(body, MANUAL_EVENT_KEYS, "event");
    // `type` and `subject_ref` are required; the other three are optional with
    // documented defaults (source "manual", subject_kind "manual", payload {}).
    const type = requireString(body.type, "type");
    const subject_ref = requireString(body.subject_ref, "subject_ref");
    optionalString(body.source, "source");
    optionalString(body.subject_kind, "subject_kind");
    const source =
      typeof body.source === "string" && body.source.length > 0
        ? body.source
        : DEFAULT_MANUAL_SOURCE;
    const subject_kind =
      typeof body.subject_kind === "string" && body.subject_kind.length > 0
        ? body.subject_kind
        : DEFAULT_MANUAL_SUBJECT_KIND;
    if (body.payload !== undefined && !isPlainObject(body.payload)) {
      throw new HttpError(400, "payload must be a JSON object");
    }
    const payload = (body.payload as Record<string, unknown> | undefined) ?? {};

    // Deterministic dedupe_key so the normal cooldown collapses repeats of the
    // same (source, type, subject_ref) triple: a first mint inserts; a second
    // within the cooldown is suppressed and we return the existing row.
    const dedupe_key = `manual:${source}:${type}:${subject_ref}`;

    const result = await emitEvent(
      { source, type, subject_kind, subject_ref, payload, dedupe_key },
      undefined,
      { dispatcher: getRuntime().dispatcher }
    );

    if (result.suppressed) {
      const existing = await getLatestUnclearedEventByDedupeKey(dedupe_key);
      if (!existing) {
        // Race: the prior row was cleared between the suppression check and
        // our lookup. Report the collapse honestly rather than fabricating a
        // 201 for a row that was never inserted.
        throw new HttpError(
          409,
          "manual event suppressed by cooldown but no prior event found"
        );
      }
      log.info("manual event minted (deduped)", {
        source,
        type,
        subject_ref,
        existing_event_id: existing.id,
      });
      res.status(200).json(existing);
      return;
    }

    log.info("manual event minted", {
      event_id: result.event.id,
      source,
      type,
      subject_ref,
    });
    res.status(201).json(result.event);
  })
);

export default eventsRouter;

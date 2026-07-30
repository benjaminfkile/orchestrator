import express from "express";

import { listFindings } from "../db/findings";
import { getRun, getRunSubjectFields, listRunHistory } from "../db/runs";

import { parseStatusQuery } from "./dispatchesRouter";
import {
  handler,
  parseIdParam,
  parseIntQuery,
  parseSearchQuery,
} from "./http";

/**
 * `/api/runs` — read run history and single execution attempts.
 *
 *   GET /      run-history list, one row per dispatch (its latest run's outcome
 *              left-joined), newest first; `?status=` filters to one dispatch
 *              state, `?limit=` caps the row count, and `?q=` free-text searches
 *              (playbook name, status, error, subject fields, and the runs'
 *              result/collected/findings text) — all compose
 *   GET /:id   one run with its findings embedded, 404 when absent
 */
const runsRouter = express.Router();

runsRouter.get(
  "/",
  handler(async (req, res) => {
    const status = parseStatusQuery(req.query.status);
    const limit = parseIntQuery(req.query.limit, "limit", 1, 1000);
    const q = parseSearchQuery(req.query.q);
    res.status(200).json(await listRunHistory({ status, limit, q }));
  })
);

runsRouter.get(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const run = await getRun(id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    const findings = await listFindings(id);
    // Additive: trace the run back to its triggering event's subject without a
    // second request. Joined by the run's `dispatch_id`.
    const subject = await getRunSubjectFields(run.dispatch_id);
    res.status(200).json({ ...run, findings, ...subject });
  })
);

export default runsRouter;

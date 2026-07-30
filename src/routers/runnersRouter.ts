import express from "express";

import { runnerIds } from "../runners/registry";

import { handler } from "./http";

/**
 * `/api/runners` — expose the registered runner ids so the SPA can populate the
 * playbook editor's runner picker.
 *
 *   GET / — `{ runners: ["claude-code", ...] }`
 *
 * The list is derived from the runner registry; a runner id is opaque to the
 * core (behavior lives entirely inside the runner), so this endpoint carries no
 * per-runner config schema — just the ids a playbook may name.
 */
const runnersRouter = express.Router();

runnersRouter.get(
  "/",
  handler(async (_req, res) => {
    res.status(200).json({ runners: runnerIds() });
  })
);

export default runnersRouter;

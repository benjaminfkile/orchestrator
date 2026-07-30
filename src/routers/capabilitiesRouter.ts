import express from "express";

import { getRuntime } from "../runtime";

import { handler } from "./http";

/**
 * `/api/capabilities` — list the capabilities registered across all integration
 * modules so the UI can offer a grant picker for the playbook editor.
 *
 *   GET /   the registered capability ids, each with its owning module id
 *
 * Each entry is `{ id, module_id }`. When no module system is wired the list is
 * empty rather than an error — a fresh install with no modules simply has nothing
 * to grant.
 */
const capabilitiesRouter = express.Router();

capabilitiesRouter.get(
  "/",
  handler(async (_req, res) => {
    const { registry } = getRuntime();
    const capabilities = registry?.listCapabilityDescriptors() ?? [];
    res.status(200).json(capabilities);
  })
);

export default capabilitiesRouter;

import express from "express";

import { exportConfig, SecretLeakError } from "../config/exporter";
import {
  importConfig,
  ImportError,
  type ImportMode,
} from "../config/importer";
import { getSecret, listSecretKeys } from "../secrets";

import { handler, HttpError, requireBody } from "./http";

/**
 * `/api/config` — portable config export/import.
 *
 *   GET  /export       a single JSON document (playbooks, rules, module config,
 *                      whitelisted settings, required-secrets manifest) served as
 *                      an attachment. `?scrub=environment` additionally blanks
 *                      environment identifiers for public sharing.
 *
 *   POST /import        {document, mode?, dry_run?} — reproduces an export
 *                      document locally. `mode` is "merge" (default, skip name
 *                      collisions) or "overwrite" (replace them). `dry_run` runs
 *                      no writes and returns the full plan. The apply is one
 *                      transaction; a dangling reference rolls back everything.
 *
 * The export references secrets by NAME only. This router is the ONLY place that
 * reads the secret store, and it does so purely to hand the currently stored
 * {name,value} pairs to the exporter's post-serialization leak scan (on export)
 * and the currently stored NAMES to the importer's missing-secrets computation
 * (on import) — neither the exporter nor the importer touches the store. A
 * document found to embed a stored secret VALUE fails export loudly (409) rather
 * than being masked; the importer never creates, reads, or modifies secrets.
 */
const configRouter = express.Router();

configRouter.get(
  "/export",
  handler(async (req, res) => {
    const rawScrub = req.query.scrub;
    if (rawScrub !== undefined && rawScrub !== "environment") {
      throw new HttpError(400, "scrub must be 'environment' when present");
    }
    const scrub = rawScrub === "environment" ? "environment" : undefined;

    // Read the stored secrets ONCE, here, purely for the leak scan. Names come
    // from the store; values are resolved by name. The exporter never sees the
    // store — only this snapshot list.
    const secrets = listSecretKeys().map((name) => ({
      name,
      value: getSecret(name) ?? "",
    }));

    let doc;
    try {
      doc = await exportConfig({
        nowIso: new Date().toISOString(),
        secrets,
        scrub,
      });
    } catch (err) {
      if (err instanceof SecretLeakError) {
        // A pasted secret in a template is a leak the user must fix; surface the
        // offending object rather than a masked/altered document.
        throw new HttpError(409, err.message);
      }
      throw err;
    }

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="orchestrator-config.json"'
    );
    res.status(200).json(doc);
  })
);

configRouter.post(
  "/import",
  handler(async (req, res) => {
    const body = requireBody(req.body);

    if (!("document" in body)) {
      throw new HttpError(400, "document is required");
    }

    const rawMode = body.mode;
    if (
      rawMode !== undefined &&
      rawMode !== "merge" &&
      rawMode !== "overwrite"
    ) {
      throw new HttpError(400, "mode must be 'merge' or 'overwrite'");
    }
    const mode = rawMode as ImportMode | undefined;

    const rawDryRun = body.dry_run;
    if (rawDryRun !== undefined && typeof rawDryRun !== "boolean") {
      throw new HttpError(400, "dry_run must be a boolean");
    }
    const dryRun = rawDryRun === true;

    // Hand the importer NAMES only. This router is the only place that reads the
    // secret store; the importer never touches it.
    const secretNames = listSecretKeys();

    let plan;
    try {
      plan = await importConfig({
        document: body.document,
        mode,
        dryRun,
        secretNames,
      });
    } catch (err) {
      if (err instanceof ImportError) {
        throw new HttpError(err.status, err.message);
      }
      throw err;
    }

    res.status(200).json(plan);
  })
);

export default configRouter;

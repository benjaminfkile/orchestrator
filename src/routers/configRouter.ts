import express from "express";

import {
  exportConfig,
  SecretLeakError,
  UnknownExclusionError,
  type ExportExclude,
} from "../config/exporter";
import {
  importConfig,
  ImportError,
  type ImportMode,
} from "../config/importer";
import { getSecret, listSecretKeys } from "../secrets";

import {
  handler,
  HttpError,
  isPlainObject,
  optionalStringArray,
  requireBody,
} from "./http";

/**
 * `/api/config` — portable config export/import.
 *
 *   GET  /export       a single JSON document (playbooks, rules, snippets,
 *                      module config, whitelisted settings, required-secrets
 *                      manifest) served as an attachment. `?scrub=environment`
 *                      additionally blanks environment identifiers for public
 *                      sharing. Serves the FULL export unconditionally; use
 *                      `POST /export` to pick what to include.
 *
 *   POST /export       `{exclude?: {playbooks?, rules?, snippets?, notifiers?}}`
 *                      returns the same document as `GET /export` minus the
 *                      excluded entries, plus a `warnings` array listing any
 *                      included rule whose dispatch or notify target refers to
 *                      an excluded or never-exported entity. Unknown names in
 *                      `exclude` are a 400 listing them. Selection is
 *                      per-export only; nothing is persisted anywhere. The
 *                      response envelope is `{document, warnings}`.
 *
 *   POST /import       `{document, mode?, dry_run?}`: reproduces an export
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

/**
 * Read the stored secrets once for the leak scan. Names come from the store;
 * values are resolved by name. The exporter never sees the store itself, only
 * this snapshot list.
 */
function snapshotSecrets(): Array<{ name: string; value: string }> {
  return listSecretKeys().map((name) => ({
    name,
    value: getSecret(name) ?? "",
  }));
}

/** Render an {@link UnknownExclusionError} as the router's 400 body. */
function unknownExclusionResponse(err: UnknownExclusionError): {
  status: number;
  body: { error: string; unknown: UnknownExclusionError["unknown"] };
} {
  return {
    status: 400,
    body: { error: err.message, unknown: err.unknown },
  };
}

configRouter.get(
  "/export",
  handler(async (req, res) => {
    const rawScrub = req.query.scrub;
    if (rawScrub !== undefined && rawScrub !== "environment") {
      throw new HttpError(400, "scrub must be 'environment' when present");
    }
    const scrub = rawScrub === "environment" ? "environment" : undefined;

    let result;
    try {
      result = await exportConfig({
        nowIso: new Date().toISOString(),
        secrets: snapshotSecrets(),
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
    res.status(200).json(result.document);
  })
);

configRouter.post(
  "/export",
  handler(async (req, res) => {
    // GET /export is the full document; POST /export accepts a per-export
    // exclusion set chosen in the UI's dialog and returns the filtered doc
    // alongside any dangling-reference warnings for the caller to display.
    const body = req.body === undefined || req.body === null ? {} : req.body;
    if (!isPlainObject(body)) {
      throw new HttpError(400, "request body must be a JSON object");
    }

    const rawScrub = body.scrub;
    if (rawScrub !== undefined && rawScrub !== "environment") {
      throw new HttpError(400, "scrub must be 'environment' when present");
    }
    const scrub = rawScrub === "environment" ? "environment" : undefined;

    let exclude: ExportExclude | undefined;
    const rawExclude = body.exclude;
    if (rawExclude !== undefined) {
      if (!isPlainObject(rawExclude)) {
        throw new HttpError(400, "exclude must be a JSON object when present");
      }
      const allowed = ["playbooks", "rules", "snippets", "notifiers"] as const;
      for (const key of Object.keys(rawExclude)) {
        if (!(allowed as readonly string[]).includes(key)) {
          throw new HttpError(400, `unknown exclude field: ${key}`);
        }
      }
      optionalStringArray(rawExclude.playbooks, "exclude.playbooks");
      optionalStringArray(rawExclude.rules, "exclude.rules");
      optionalStringArray(rawExclude.snippets, "exclude.snippets");
      optionalStringArray(rawExclude.notifiers, "exclude.notifiers");
      exclude = {
        playbooks: rawExclude.playbooks as string[] | undefined,
        rules: rawExclude.rules as string[] | undefined,
        snippets: rawExclude.snippets as string[] | undefined,
        notifiers: rawExclude.notifiers as string[] | undefined,
      };
    }

    let result;
    try {
      result = await exportConfig({
        nowIso: new Date().toISOString(),
        secrets: snapshotSecrets(),
        scrub,
        exclude,
      });
    } catch (err) {
      if (err instanceof UnknownExclusionError) {
        const { status, body: payload } = unknownExclusionResponse(err);
        res.status(status).json(payload);
        return;
      }
      if (err instanceof SecretLeakError) {
        throw new HttpError(409, err.message);
      }
      throw err;
    }

    res.status(200).json({
      document: result.document,
      warnings: result.warnings,
    });
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

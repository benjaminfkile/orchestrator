import express from "express";

import { getModuleConfig, setModuleConfig } from "../db/moduleConfig";
import { getRuntime } from "../runtime";
import { publish } from "../services/changeBus";

import {
  handler,
  HttpError,
  optionalBoolean,
  optionalString,
  rejectUnknownKeys,
  requireBody,
  requireInt,
} from "./http";

/**
 * `/api/modules` — inspect registered integration modules and edit their config.
 *
 *   GET /                list module ids, each with its producers' live statuses
 *   GET /:id/config      the module's stored config (opaque JSON), 404 if unknown
 *   PUT /:id/config      replace the config; validated by the module's optional
 *                        hook (400 on rejection) then persisted, which reconciles
 *                        the module's producer triggers
 *   POST /:id/backfill   invoke a producer's optional generic backfill hook to
 *                        replay its watched items through the normal event intake;
 *                        404 unknown module, 400 when no producer supports it
 *
 * Module ids are strings (not the numeric ids the other routers use), so the id
 * is taken straight from the path and checked against the registry.
 */
const modulesRouter = express.Router();

/** Resolve the registry, or 503 when no module system is wired into the app. */
function requireRegistry() {
  const { registry } = getRuntime();
  if (!registry) {
    throw new HttpError(503, "module system is not available");
  }
  return registry;
}

modulesRouter.get(
  "/",
  handler(async (_req, res) => {
    const registry = requireRegistry();
    const { scheduler } = getRuntime();
    const modules = registry.listModules().map((module) => ({
      id: module.id,
      producers: (module.producers ?? []).map((producer) => {
        const status = scheduler?.getProducerStatus(producer.id);
        return {
          producerId: producer.id,
          trigger: status?.trigger ?? null,
          lastTickAt: status?.lastTickAt ?? null,
          lastError: status?.lastError ?? null,
          nextFireAt: status?.nextFireAt ?? null,
        };
      }),
    }));
    res.status(200).json(modules);
  })
);

modulesRouter.get(
  "/:id/config",
  handler(async (req, res) => {
    const registry = requireRegistry();
    const { id } = req.params;
    if (!registry.getModule(id)) {
      res.status(404).json({ error: "module not found" });
      return;
    }
    const config = await getModuleConfig(id);
    res.status(200).json({ module_id: id, config: config ?? null });
  })
);

modulesRouter.put(
  "/:id/config",
  handler(async (req, res) => {
    const registry = requireRegistry();
    const { id } = req.params;
    const module = registry.getModule(id);
    if (!module) {
      res.status(404).json({ error: "module not found" });
      return;
    }
    const config = requireBody(req.body);
    // Let the module reject a malformed config BEFORE anything is stored, so a
    // bad write never lands and later breaks reconcile.
    if (module.validateConfig) {
      try {
        await module.validateConfig(config);
      } catch (err) {
        throw new HttpError(
          400,
          err instanceof Error ? err.message : "invalid module config"
        );
      }
    }
    // Persist, then reconcile: passing the registry as the notifier fires the
    // module's applyConfig hook so its producer triggers are re-derived.
    await setModuleConfig(id, config, undefined, registry);
    // Signal the live SPA that module config changed. Fire-and-forget: the
    // write has already committed and a publish never fails the request.
    publish("modules");
    res.status(200).json({ module_id: id, config });
  })
);

modulesRouter.post(
  "/:id/backfill",
  handler(async (req, res) => {
    const registry = requireRegistry();
    const { id } = req.params;
    const module = registry.getModule(id);
    if (!module) {
      res.status(404).json({ error: "module not found" });
      return;
    }

    const body = requireBody(req.body);
    rejectUnknownKeys(body, ["producer_id", "limit", "dry_run"], "backfill");
    optionalString(body.producer_id, "producer_id");
    optionalBoolean(body.dry_run, "dry_run");
    const limit =
      body.limit === undefined
        ? undefined
        : requireInt(body.limit, "limit", 1, 1_000_000);
    const dryRun = body.dry_run === true;

    // Resolve the target producer: an explicit producer_id must exist on this
    // module AND implement backfill; otherwise pick the module's first
    // backfill-capable producer. "Does not support backfill" is a 400.
    const producers = module.producers ?? [];
    let producer;
    if (typeof body.producer_id === "string") {
      producer = producers.find((p) => p.id === body.producer_id);
      if (!producer) {
        res.status(404).json({ error: "producer not found" });
        return;
      }
      if (!producer.backfill) {
        throw new HttpError(400, "producer does not support backfill");
      }
    } else {
      producer = producers.find((p) => p.backfill);
      if (!producer) {
        throw new HttpError(400, "module does not support backfill");
      }
    }

    // The module owns whether a backfill is currently possible (config, enabled
    // state, credentials); surface its refusal as a 400 with the module's own
    // message rather than a 500.
    let result;
    try {
      result = await producer.backfill!({ limit, dryRun });
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : "backfill failed"
      );
    }
    res.status(200).json(result);
  })
);

export default modulesRouter;

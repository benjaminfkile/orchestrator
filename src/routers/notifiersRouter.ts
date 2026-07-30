import express from "express";

import {
  createNotifier,
  deleteNotifier,
  getNotifier,
  listNotifiers,
  updateNotifier,
} from "../db/notifiers";

import {
  handler,
  HttpError,
  isPlainObject,
  optionalBoolean,
  optionalString,
  parseIdParam,
  rejectUnknownKeys,
  requireBody,
  requireString,
} from "./http";

/**
 * `/api/notifiers` — CRUD for user-built notifiers (outbound sinks).
 *
 *   GET /            list, id ascending
 *   GET /:id         one notifier, 404 when absent
 *   POST /           create (name required; config/templates optional)
 *   PATCH /:id       partial update, 404 when absent
 *   DELETE /:id      remove, 404 when absent
 *
 * A notification is JUST a notification: there is no delivery `kind`, so `kind`
 * is not an accepted key — a body carrying it is rejected as unknown.
 */
const notifiersRouter = express.Router();

/** Validate an optional `config` object field (may be absent), else 400. */
function optionalConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new HttpError(400, "config must be an object");
  }
  return value;
}

notifiersRouter.get(
  "/",
  handler(async (_req, res) => {
    res.status(200).json(await listNotifiers());
  })
);

notifiersRouter.get(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const notifier = await getNotifier(id);
    if (!notifier) {
      res.status(404).json({ error: "notifier not found" });
      return;
    }
    res.status(200).json(notifier);
  })
);

/** The keys a notifier request body may carry. */
const NOTIFIER_KEYS = [
  "name",
  "config",
  "title_template",
  "body_template",
  "enabled",
] as const;

notifiersRouter.post(
  "/",
  handler(async (req, res) => {
    const body = requireBody(req.body);
    rejectUnknownKeys(body, NOTIFIER_KEYS, "notifier");
    const name = requireString(body.name, "name");
    const config = optionalConfig(body.config);
    optionalString(body.title_template, "title_template");
    optionalString(body.body_template, "body_template");
    optionalBoolean(body.enabled, "enabled");
    const created = await createNotifier({
      name,
      config,
      title_template: body.title_template as string | undefined,
      body_template: body.body_template as string | undefined,
      enabled: body.enabled as boolean | undefined,
    });
    res.status(201).json(created);
  })
);

notifiersRouter.patch(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const body = requireBody(req.body);
    rejectUnknownKeys(body, NOTIFIER_KEYS, "notifier");
    if (body.name !== undefined) requireString(body.name, "name");
    const config = optionalConfig(body.config);
    optionalString(body.title_template, "title_template");
    optionalString(body.body_template, "body_template");
    optionalBoolean(body.enabled, "enabled");
    const updated = await updateNotifier(id, {
      name: body.name as string | undefined,
      config,
      title_template: body.title_template as string | undefined,
      body_template: body.body_template as string | undefined,
      enabled: body.enabled as boolean | undefined,
    });
    if (!updated) {
      res.status(404).json({ error: "notifier not found" });
      return;
    }
    res.status(200).json(updated);
  })
);

notifiersRouter.delete(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (!(await deleteNotifier(id))) {
      res.status(404).json({ error: "notifier not found" });
      return;
    }
    res.status(204).end();
  })
);

export default notifiersRouter;

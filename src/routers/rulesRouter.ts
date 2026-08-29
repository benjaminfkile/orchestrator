import express from "express";

import { getPlaybook } from "../db/playbooks";
import {
  createRule,
  getRule,
  listRules,
  updateRule,
} from "../db/rules";
import type {
  RuleDispatchTarget,
  RuleMatch,
  RuleNotifyTarget,
} from "../interfaces";
import { deleteRuleWithHistory } from "../services/ruleDeletion";

import {
  handler,
  HttpError,
  isPlainObject,
  optionalBoolean,
  parseIdParam,
  rejectUnknownKeys,
  requireBody,
  requireInt,
  requireString,
} from "./http";

/**
 * `/api/rules` — CRUD plus enable/disable for user-configured rules.
 *
 *   GET /                 list, id ascending
 *   GET /:id              one rule, 404 when absent
 *   POST /                create (validates match/dispatch; playbook_ids must exist)
 *   PATCH /:id            partial update (same validation), 404 when absent
 *   DELETE /:id           remove; 404 when absent, 409 while an in-flight
 *                         dispatch references the rule. On success the terminal
 *                         dispatches that referenced it have their `rule_id`
 *                         nulled so history stays readable.
 *   POST /:id/enable      set enabled=true, 404 when absent
 *   POST /:id/disable     set enabled=false, 404 when absent
 */
const rulesRouter = express.Router();

/**
 * Validate a rule `match` object against the {@link RuleMatch} shape: optional
 * string `source`/`type` and an optional object `criteria`, no other keys.
 */
function validateMatch(value: unknown): RuleMatch {
  if (!isPlainObject(value)) {
    throw new HttpError(400, "match must be an object");
  }
  rejectUnknownKeys(value, ["source", "type", "criteria"], "match");
  if (value.source !== undefined && typeof value.source !== "string") {
    throw new HttpError(400, "match.source must be a string");
  }
  if (value.type !== undefined && typeof value.type !== "string") {
    throw new HttpError(400, "match.type must be a string");
  }
  if (value.criteria !== undefined && !isPlainObject(value.criteria)) {
    throw new HttpError(400, "match.criteria must be an object");
  }
  return value as RuleMatch;
}

/**
 * Validate a rule `dispatch` array against the {@link RuleDispatchTarget} shape:
 * each target is `{playbook_id: int, bindings?: object}` and every referenced
 * playbook must exist (else 400). Returns the typed targets.
 */
async function validateDispatch(
  value: unknown
): Promise<RuleDispatchTarget[]> {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "dispatch must be an array");
  }
  const targets: RuleDispatchTarget[] = [];
  for (const [i, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      throw new HttpError(400, `dispatch[${i}] must be an object`);
    }
    rejectUnknownKeys(entry, ["playbook_id", "bindings"], `dispatch[${i}]`);
    const playbookId = requireInt(
      entry.playbook_id,
      `dispatch[${i}].playbook_id`,
      1,
      Number.MAX_SAFE_INTEGER
    );
    if (entry.bindings !== undefined && !isPlainObject(entry.bindings)) {
      throw new HttpError(400, `dispatch[${i}].bindings must be an object`);
    }
    if (!(await getPlaybook(playbookId))) {
      throw new HttpError(
        400,
        `dispatch[${i}].playbook_id ${playbookId} does not exist`
      );
    }
    targets.push({
      playbook_id: playbookId,
      ...(entry.bindings !== undefined
        ? { bindings: entry.bindings as Record<string, unknown> }
        : {}),
    });
  }
  return targets;
}

/**
 * Validate a rule `notify` array against the {@link RuleNotifyTarget} shape: each
 * target is `{notifier_id: int}`, no other keys. Referential existence of the
 * notifier is not enforced here — a notifier that is later deleted simply
 * produces no delivery, matching the delivery service's skip-and-log behavior.
 * Returns the typed targets.
 */
function validateNotify(value: unknown): RuleNotifyTarget[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "notify must be an array");
  }
  const targets: RuleNotifyTarget[] = [];
  for (const [i, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      throw new HttpError(400, `notify[${i}] must be an object`);
    }
    rejectUnknownKeys(entry, ["notifier_id"], `notify[${i}]`);
    const notifierId = requireInt(
      entry.notifier_id,
      `notify[${i}].notifier_id`,
      1,
      Number.MAX_SAFE_INTEGER
    );
    targets.push({ notifier_id: notifierId });
  }
  return targets;
}

rulesRouter.get(
  "/",
  handler(async (_req, res) => {
    res.status(200).json(await listRules());
  })
);

rulesRouter.get(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const rule = await getRule(id);
    if (!rule) {
      res.status(404).json({ error: "rule not found" });
      return;
    }
    res.status(200).json(rule);
  })
);

rulesRouter.post(
  "/",
  handler(async (req, res) => {
    const body = requireBody(req.body);
    rejectUnknownKeys(
      body,
      ["name", "enabled", "match", "dispatch", "notify"],
      "rule"
    );
    const name = requireString(body.name, "name");
    optionalBoolean(body.enabled, "enabled");
    const match =
      body.match === undefined ? undefined : validateMatch(body.match);
    const dispatch =
      body.dispatch === undefined
        ? undefined
        : await validateDispatch(body.dispatch);
    const notify =
      body.notify === undefined ? undefined : validateNotify(body.notify);
    const created = await createRule({
      name,
      enabled: body.enabled as boolean | undefined,
      match,
      dispatch,
      notify,
    });
    res.status(201).json(created);
  })
);

rulesRouter.patch(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const body = requireBody(req.body);
    rejectUnknownKeys(
      body,
      ["name", "enabled", "match", "dispatch", "notify"],
      "rule"
    );
    if (body.name !== undefined) requireString(body.name, "name");
    optionalBoolean(body.enabled, "enabled");
    const match =
      body.match === undefined ? undefined : validateMatch(body.match);
    const dispatch =
      body.dispatch === undefined
        ? undefined
        : await validateDispatch(body.dispatch);
    const notify =
      body.notify === undefined ? undefined : validateNotify(body.notify);
    const updated = await updateRule(id, {
      name: body.name as string | undefined,
      enabled: body.enabled as boolean | undefined,
      match,
      dispatch,
      notify,
    });
    if (!updated) {
      res.status(404).json({ error: "rule not found" });
      return;
    }
    res.status(200).json(updated);
  })
);

rulesRouter.delete(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const result = await deleteRuleWithHistory(id);
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "rule not found" });
      return;
    }
    if (result.outcome === "in_flight") {
      res.status(409).json({
        error: `rule has ${result.inFlight} in-flight dispatches`,
      });
      return;
    }
    res.status(204).end();
  })
);

/** Shared enable/disable handler: flip `enabled`, 404 when the rule is absent. */
function setEnabled(enabled: boolean) {
  return handler(async (req: express.Request, res: express.Response) => {
    const id = parseIdParam(req.params.id);
    const updated = await updateRule(id, { enabled });
    if (!updated) {
      res.status(404).json({ error: "rule not found" });
      return;
    }
    res.status(200).json(updated);
  });
}

rulesRouter.post("/:id/enable", setEnabled(true));
rulesRouter.post("/:id/disable", setEnabled(false));

export default rulesRouter;

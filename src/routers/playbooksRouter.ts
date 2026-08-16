import express from "express";

import {
  createPlaybook,
  getPlaybook,
  listPlaybooks,
  updatePlaybook,
} from "../db/playbooks";
import {
  LEASE_ISOLATION_LEVELS,
  type EnvRequirement,
  type LeaseIsolation,
  type PlaybookUpdate,
} from "../interfaces";
import { getRunner, runnerIds } from "../runners/registry";
import {
  deletePlaybookWithHistory,
  getPlaybookUsage,
} from "../services/playbookDeletion";

import {
  handler,
  HttpError,
  isPlainObject,
  optionalString,
  parseIdParam,
  rejectUnknownKeys,
  requireBody,
  requireInt,
  requireString,
} from "./http";

/**
 * `/api/playbooks` — CRUD for playbooks.
 *
 *   GET /            list, id ascending
 *   GET /:id         one playbook, 404 when absent
 *   GET /:id/usage   what a delete would cascade + which rules reference it
 *   POST /           create (validates shape; unique name → 409)
 *   PATCH /:id       partial update (same validation), 404 when absent, 409 on name clash
 *   DELETE /:id      remove + CASCADE run history; 409 when in-flight, 404 when absent
 *
 * Deleting a playbook CASCADES its terminal run history (dispatches → runs →
 * findings → on-disk log files) and then the playbook row; a playbook with any
 * in-flight (non-terminal) dispatch is refused with 409 so a run is never yanked
 * mid-flight. A referencing rule is NOT a barrier: after the delete its dispatch
 * target is dangling, but the dispatch path fail-closes on an unknown playbook id
 * at dispatch creation (see {@link dispatchForEvent} — it skips + warns rather
 * than throwing), so a dangling target simply never fires. `GET /:id/usage`
 * exposes the cascade counts and the enabled referencing rules so the UI can warn
 * before the user confirms.
 */
const playbooksRouter = express.Router();

/** Every writable playbook field, used to reject stray keys on the body. */
const PLAYBOOK_FIELDS = [
  "name",
  "image",
  "host",
  "isolation",
  "ttl_seconds",
  "resources",
  "network",
  "userdata_template",
  "prompt_template",
  "runner",
  "runner_config",
  "env_requirements",
  "steps",
  "granted_capabilities",
  "output_kind",
] as const;

/** Validate an optional {@link PlaybookResources} object of non-negative ints. */
function validateResources(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new HttpError(400, "resources must be an object");
  }
  rejectUnknownKeys(value, ["cpus", "memory_mb", "pids"], "resources");
  for (const key of ["cpus", "memory_mb", "pids"] as const) {
    if (value[key] !== undefined) {
      requireInt(value[key], `resources.${key}`, 0, Number.MAX_SAFE_INTEGER);
    }
  }
}

/**
 * Reject the retired claude-code-specific keys. They now live inside the opaque
 * `runner_config` of the claude-code runner, so a body carrying them is stale —
 * fail it clearly rather than silently dropping the values.
 */
function rejectLegacyRunnerKeys(body: Record<string, unknown>): void {
  for (const key of ["model", "allowed_tools"] as const) {
    if (key in body) {
      throw new HttpError(
        400,
        `"${key}" is no longer a playbook field — set it inside runner_config for the claude-code runner`
      );
    }
  }
}

/**
 * Validate an optional `runner` field: a non-empty string that names a runner
 * registered in the registry. An unknown id is a 400 — the core will never be
 * able to resolve it at dispatch time.
 */
function validateRunner(value: unknown): void {
  if (value === undefined) return;
  const id = requireString(value, "runner");
  if (!getRunner(id)) {
    throw new HttpError(
      400,
      `unknown runner "${id}" — registered runners: ${runnerIds().join(", ")}`
    );
  }
}

/** Validate an optional `runner_config`: an opaque object, never interpreted here. */
function validateRunnerConfig(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new HttpError(400, "runner_config must be an object");
  }
}

/**
 * Validate an optional playbook `steps` array against the {@link PlaybookStep}
 * shape: each step has a `phase` of `pre`|`collect`, a string `command_template`,
 * and a string `label`.
 */
function validateSteps(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new HttpError(400, "steps must be an array");
  }
  value.forEach((step, i) => {
    if (!isPlainObject(step)) {
      throw new HttpError(400, `steps[${i}] must be an object`);
    }
    rejectUnknownKeys(
      step,
      ["phase", "command_template", "label"],
      `steps[${i}]`
    );
    if (step.phase !== "pre" && step.phase !== "collect") {
      throw new HttpError(400, `steps[${i}].phase must be "pre" or "collect"`);
    }
    requireString(step.command_template, `steps[${i}].command_template`);
    requireString(step.label, `steps[${i}].label`);
  });
}

/**
 * Validate an optional playbook `granted_capabilities` array against the
 * {@link GrantedCapability} shape: each entry has a non-empty string
 * `capability_id` and an optional `config` object. Stays domain-neutral — a
 * `capability_id` is opaque here and never branched on.
 */
function validateGrantedCapabilities(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new HttpError(400, "granted_capabilities must be an array");
  }
  value.forEach((grant, i) => {
    if (!isPlainObject(grant)) {
      throw new HttpError(400, `granted_capabilities[${i}] must be an object`);
    }
    rejectUnknownKeys(
      grant,
      ["capability_id", "config"],
      `granted_capabilities[${i}]`
    );
    requireString(grant.capability_id, `granted_capabilities[${i}].capability_id`);
    if (grant.config !== undefined && !isPlainObject(grant.config)) {
      throw new HttpError(
        400,
        `granted_capabilities[${i}].config must be an object`
      );
    }
  });
}

/**
 * Validate the optional `host` selector: a string (opaque — never interpreted
 * here) or `null` to clear it back to the configured default host. Absent leaves
 * it unchanged.
 */
function validateHost(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new HttpError(400, "host must be a string or null");
  }
}

/**
 * Validate the optional `isolation` level: one of the allowed
 * {@link LEASE_ISOLATION_LEVELS} strings, or `null` to clear it back to the
 * server default. Absent leaves it unchanged. Rejecting an unknown value here
 * mirrors wisper's own 400 so a bad level fails at save time, not at dispatch.
 */
function validateIsolation(value: unknown): void {
  if (value === undefined || value === null) return;
  if (
    typeof value !== "string" ||
    !LEASE_ISOLATION_LEVELS.includes(value as LeaseIsolation)
  ) {
    throw new HttpError(
      400,
      `isolation must be one of ${LEASE_ISOLATION_LEVELS.join(", ")} or null`
    );
  }
}

/**
 * Validate an optional `env_requirements` array. Each entry is either a
 * non-empty string (the legacy shape — inject into the lease env) or an object
 * `{name, inject: "step-only"}` (available to server-side template rendering
 * but NOT injected into the lease env). Any other shape is a 400 at save time
 * so a misconfiguration is caught here, before it can quietly become a
 * silently-skipped requirement at dispatch time (see `parseEnvRequirements`).
 */
function validateEnvRequirements(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new HttpError(400, "env_requirements must be an array");
  }
  value.forEach((entry, i) => {
    if (typeof entry === "string") {
      if (entry.length === 0) {
        throw new HttpError(
          400,
          `env_requirements[${i}] must be a non-empty string`
        );
      }
      return;
    }
    if (!isPlainObject(entry)) {
      throw new HttpError(
        400,
        `env_requirements[${i}] must be a string or an object`
      );
    }
    rejectUnknownKeys(entry, ["name", "inject"], `env_requirements[${i}]`);
    requireString(entry.name, `env_requirements[${i}].name`);
    if (entry.inject !== "step-only") {
      throw new HttpError(
        400,
        `env_requirements[${i}].inject must be "step-only"`
      );
    }
  });
}

/** Validate the fields shared by create and patch; `require` gates required ones. */
function validateCommon(body: Record<string, unknown>): void {
  validateHost(body.host);
  validateIsolation(body.isolation);
  optionalString(body.network, "network");
  optionalString(body.userdata_template, "userdata_template");
  optionalString(body.prompt_template, "prompt_template");
  optionalString(body.output_kind, "output_kind");
  validateRunner(body.runner);
  validateRunnerConfig(body.runner_config);
  validateEnvRequirements(body.env_requirements);
  validateResources(body.resources);
  validateSteps(body.steps);
  validateGrantedCapabilities(body.granted_capabilities);
}

/**
 * Project a validated body onto the optional playbook fields, preserving the
 * absent-vs-present distinction so the repo layer applies table defaults on
 * create and leaves omitted columns untouched on patch.
 */
function optionalFields(body: Record<string, unknown>): PlaybookUpdate {
  const out: PlaybookUpdate = {};
  if (body.host !== undefined) out.host = body.host as string | null;
  if (body.isolation !== undefined) {
    out.isolation = body.isolation as LeaseIsolation | null;
  }
  if (body.resources !== undefined) {
    out.resources = body.resources as PlaybookUpdate["resources"];
  }
  if (body.network !== undefined) out.network = body.network as string;
  if (body.userdata_template !== undefined) {
    out.userdata_template = body.userdata_template as string;
  }
  if (body.prompt_template !== undefined) {
    out.prompt_template = body.prompt_template as string;
  }
  if (body.runner !== undefined) out.runner = body.runner as string;
  if (body.runner_config !== undefined) {
    out.runner_config = body.runner_config as Record<string, unknown>;
  }
  if (body.env_requirements !== undefined) {
    out.env_requirements = body.env_requirements as EnvRequirement[];
  }
  if (body.steps !== undefined) out.steps = body.steps as unknown[];
  if (body.granted_capabilities !== undefined) {
    out.granted_capabilities =
      body.granted_capabilities as PlaybookUpdate["granted_capabilities"];
  }
  if (body.output_kind !== undefined) {
    out.output_kind = body.output_kind as string;
  }
  return out;
}

/** Throw 409 when another playbook (id ≠ `excludeId`) already owns `name`. */
async function assertNameFree(name: string, excludeId?: number): Promise<void> {
  const clash = (await listPlaybooks()).find(
    (p) => p.name === name && p.id !== excludeId
  );
  if (clash) {
    throw new HttpError(409, `a playbook named "${name}" already exists`);
  }
}

playbooksRouter.get(
  "/",
  handler(async (_req, res) => {
    res.status(200).json(await listPlaybooks());
  })
);

playbooksRouter.get(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const playbook = await getPlaybook(id);
    if (!playbook) {
      res.status(404).json({ error: "playbook not found" });
      return;
    }
    res.status(200).json(playbook);
  })
);

playbooksRouter.get(
  "/:id/usage",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (!(await getPlaybook(id))) {
      res.status(404).json({ error: "playbook not found" });
      return;
    }
    res.status(200).json(await getPlaybookUsage(id));
  })
);

playbooksRouter.post(
  "/",
  handler(async (req, res) => {
    const body = requireBody(req.body);
    rejectLegacyRunnerKeys(body);
    rejectUnknownKeys(body, PLAYBOOK_FIELDS, "playbook");
    const name = requireString(body.name, "name");
    const image = requireString(body.image, "image");
    const ttlSeconds = requireInt(
      body.ttl_seconds,
      "ttl_seconds",
      1,
      Number.MAX_SAFE_INTEGER
    );
    validateCommon(body);
    await assertNameFree(name);
    const created = await createPlaybook({
      name,
      image,
      ttl_seconds: ttlSeconds,
      ...optionalFields(body),
    });
    res.status(201).json(created);
  })
);

playbooksRouter.patch(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const body = requireBody(req.body);
    rejectLegacyRunnerKeys(body);
    rejectUnknownKeys(body, PLAYBOOK_FIELDS, "playbook");
    if (body.name !== undefined) {
      const name = requireString(body.name, "name");
      await assertNameFree(name, id);
    }
    if (body.image !== undefined) requireString(body.image, "image");
    if (body.ttl_seconds !== undefined) {
      requireInt(body.ttl_seconds, "ttl_seconds", 1, Number.MAX_SAFE_INTEGER);
    }
    validateCommon(body);
    const patch: PlaybookUpdate = optionalFields(body);
    if (body.name !== undefined) patch.name = body.name as string;
    if (body.image !== undefined) patch.image = body.image as string;
    if (body.ttl_seconds !== undefined) {
      patch.ttl_seconds = body.ttl_seconds as number;
    }
    const updated = await updatePlaybook(id, patch);
    if (!updated) {
      res.status(404).json({ error: "playbook not found" });
      return;
    }
    res.status(200).json(updated);
  })
);

playbooksRouter.delete(
  "/:id",
  handler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const result = await deletePlaybookWithHistory(id);
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "playbook not found" });
      return;
    }
    if (result.outcome === "in_flight") {
      res.status(409).json({
        error: `playbook has ${result.inFlight} in-flight dispatches`,
      });
      return;
    }
    res.status(204).end();
  })
);

export default playbooksRouter;

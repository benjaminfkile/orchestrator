import express from "express";

import { getConfig } from "../config";
import { getAllSettings, setSetting } from "../db/settings";
import {
  DEFAULT_LEASE_IMAGE_SETTING,
  DISPATCH_TIMEOUT_SETTING,
} from "../executor/executor";
import {
  CONCURRENCY_SETTING,
  INTERVAL_SETTING,
  MAX_ATTEMPTS_SETTING,
} from "../services/dispatcher";
import {
  COOLDOWN_SETTING_KEY,
  IDENTITY_ME_SETTING,
  MAX_CHAIN_DEPTH_SETTING,
  MAX_PER_EVENT_SETTING,
  MAX_PER_HOUR_SETTING,
} from "../services/eventIntake";
import {
  RUN_BUDGET_PER_HOUR_SETTING,
  RUN_BUDGET_WINDOW_MINUTES_SETTING,
  TOKEN_BUDGET_PER_WINDOW_SETTING,
} from "../services/runBudget";
import { RUN_RETENTION_MAX_SETTING } from "../services/runRetention";
import { getRuntime } from "../runtime";
import { getSecret } from "../secrets";
import { WISPER_API_KEY_SECRET_NAME } from "../wisper/client";

import { handler, HttpError, requireBody, requireString } from "./http";

/**
 * `/api/settings` — the small set of app-wide tunables.
 *
 *   GET /        every stored setting as a `{key: value}` map
 *   GET /system  read-only host info the UI displays (wisper base URL + hostId,
 *                the client mode, and whether the API key secret is present),
 *                sourced from the boot config, never editable through settings
 *   PUT /        upsert one `{key, value}`; `key` must be a KNOWN setting and
 *                `value` a string (settings are stored as TEXT)
 *
 * Writes are whitelisted to the keys the core actually reads so a typo can never
 * silently create a dead setting.
 */
const settingsRouter = express.Router();

/**
 * The setting keys the core reads. Sourced from the owning modules' exported
 * constants so this list can never drift from what is actually consumed.
 */
export const KNOWN_SETTING_KEYS: readonly string[] = [
  CONCURRENCY_SETTING,
  INTERVAL_SETTING,
  MAX_ATTEMPTS_SETTING,
  DISPATCH_TIMEOUT_SETTING,
  COOLDOWN_SETTING_KEY,
  IDENTITY_ME_SETTING,
  MAX_CHAIN_DEPTH_SETTING,
  MAX_PER_EVENT_SETTING,
  MAX_PER_HOUR_SETTING,
  DEFAULT_LEASE_IMAGE_SETTING,
  RUN_BUDGET_PER_HOUR_SETTING,
  RUN_BUDGET_WINDOW_MINUTES_SETTING,
  TOKEN_BUDGET_PER_WINDOW_SETTING,
  RUN_RETENTION_MAX_SETTING,
];

settingsRouter.get(
  "/",
  handler(async (_req, res) => {
    res.status(200).json(await getAllSettings());
  })
);

/**
 * Whether the wisper API key secret is set — a BOOLEAN only, so the value never
 * crosses the API boundary. Resolved at call time from the secret store (or a
 * test-injected resolver), wrapped so a store that is not yet initialised — e.g.
 * in a router test with no keychain/master key — degrades to `false` rather than
 * throwing and 500-ing the read-only info endpoint.
 */
function wisperApiKeyPresent(): boolean {
  const resolve = getRuntime().wisperHosts?.resolveApiKey;
  try {
    const key = resolve ? resolve() : getSecret(WISPER_API_KEY_SECRET_NAME);
    return typeof key === "string" && key.length > 0;
  } catch {
    return false;
  }
}

/**
 * Read-only host facts the UI surfaces alongside the editable settings. These
 * come from the boot {@link getConfig} (env), not `app_settings`, so they are
 * displayed but never written here. `wisperHostId` is `null` when unconfigured;
 * `wisperMode` is the client mode (`dev`|`v1`); `wisperApiKeyPresent` reports
 * only WHETHER the API key secret is set, never its value.
 */
settingsRouter.get(
  "/system",
  handler((_req, res) => {
    const config = getConfig();
    res.status(200).json({
      wisperBaseUrl: config.wisperBaseUrl,
      wisperHostId: config.wisperHostId ?? null,
      wisperMode: config.wisperMode,
      wisperApiKeyPresent: wisperApiKeyPresent(),
    });
  })
);

settingsRouter.put(
  "/",
  handler(async (req, res) => {
    const body = requireBody(req.body);
    const key = requireString(body.key, "key");
    // A setting value may legitimately be the empty string (e.g. clearing
    // `identity_me`), so accept any string rather than requiring non-empty.
    if (typeof body.value !== "string") {
      throw new HttpError(400, "value must be a string");
    }
    const value = body.value;
    if (!KNOWN_SETTING_KEYS.includes(key)) {
      throw new HttpError(400, `unknown setting key: ${key}`);
    }
    await setSetting(key, value);
    res.status(200).json({ key, value });
  })
);

export default settingsRouter;

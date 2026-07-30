import express, { Request, Response } from "express";
import type { Knex } from "knex";

import { getConfig } from "../config";
import { getDb } from "../db/db";

/**
 * `GET /api/health` — a liveness/readiness probe:
 *
 *   { status: "ok", db: boolean, wisper: boolean }
 *
 * `db` is true when a trivial query succeeds. `wisper` is true when
 * `{WISPER_BASE_URL}/healthz` answers within a 2s timeout; the probe result is
 * cached for 30s so a health poller can never hammer wisper (or stall on its
 * timeout every call).
 */
const healthRouter = express.Router();

/** Timeout for a single wisper probe. */
export const WISPER_PROBE_TIMEOUT_MS = 2000;
/** How long a wisper probe result is reused before re-probing. */
export const WISPER_PROBE_CACHE_MS = 30_000;

/**
 * Injectable seams so the probe is testable without a live wisper or wall clock.
 * Default to the global `fetch` and `Date.now`.
 */
let fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) =>
  fetch(...args);
let now: () => number = () => Date.now();

/** Override the fetch/clock seams (tests only). */
export function setHealthDeps(deps: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): void {
  if (deps.fetchImpl) fetchImpl = deps.fetchImpl;
  if (deps.now) now = deps.now;
}

/** Restore the real fetch/clock seams and clear the cache (tests only). */
export function resetHealthDeps(): void {
  fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args);
  now = () => Date.now();
  cache = undefined;
}

/** Last wisper probe outcome, reused until `at + WISPER_PROBE_CACHE_MS`. */
let cache: { at: number; reachable: boolean } | undefined;

/** True when a trivial query against `db` succeeds. */
async function checkDb(db: Knex): Promise<boolean> {
  try {
    await db.raw("select 1");
    return true;
  } catch {
    return false;
  }
}

/** Probe `{baseUrl}/healthz` once, with a hard 2s timeout. Never throws. */
async function probeWisper(baseUrl: string): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, "")}/healthz`;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(WISPER_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The wisper reachability, served from a 30s cache to bound probe frequency. */
async function wisperReachable(baseUrl: string): Promise<boolean> {
  const t = now();
  if (cache && t - cache.at < WISPER_PROBE_CACHE_MS) {
    return cache.reachable;
  }
  const reachable = await probeWisper(baseUrl);
  cache = { at: t, reachable };
  return reachable;
}

healthRouter.get("/", async (_req: Request, res: Response) => {
  const [db, wisper] = await Promise.all([
    checkDb(getDb()),
    wisperReachable(getConfig().wisperBaseUrl),
  ]);
  res.status(200).json({ status: "ok", db, wisper });
});

export default healthRouter;

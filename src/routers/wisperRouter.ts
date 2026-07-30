import express from "express";

import { getRuntime } from "../runtime";
import { fetchWisperHosts } from "../services/wisperHosts";

import { handler } from "./http";

/**
 * `/api/wisper` — surface the wisper host catalog the SPA needs to build the
 * playbook Host picker, WITHOUT the client ever seeing the wisper API key.
 *
 *   GET /hosts — the rentable hosts as
 *     `{hosts: [{id, name, os, online, images: [{id, name, price_cents_per_min}]}], warning?}`
 *
 * SECURITY: in v1 mode the API key is resolved server-side from the secret store
 * and travels only in the outbound `GET /v1/catalog` request header. DEGRADE,
 * NEVER BREAK: the lookup always resolves (empty list + `warning` on any failure,
 * a single synthetic entry in dev mode), so this endpoint answers 200 even when
 * no credential is configured or the catalog is down — the Host field simply
 * falls back to free text.
 */
const wisperRouter = express.Router();

wisperRouter.get(
  "/hosts",
  handler(async (_req, res) => {
    // Production leaves the runtime override unset (boot config, global fetch,
    // process secret store); tests inject a fake catalog + explicit mode.
    const result = await fetchWisperHosts(getRuntime().wisperHosts ?? {});
    res.status(200).json(result);
  })
);

export default wisperRouter;

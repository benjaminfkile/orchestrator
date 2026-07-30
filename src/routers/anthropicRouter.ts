import express from "express";

import { getRuntime } from "../runtime";
import { fetchAnthropicModels } from "../services/anthropicModels";

import { handler } from "./http";

/**
 * `/api/anthropic` — surface Anthropic account metadata the SPA needs to build
 * richer playbook editors, without the client ever seeing a credential.
 *
 *   GET /models — the account's models as `{models: [{id, display_name}], warning?}`
 *
 * SECURITY: the API key / OAuth token is resolved server-side from the secret
 * store and travels only in the outbound request header. DEGRADE, NEVER BREAK:
 * the lookup always resolves (empty list + `warning` on any failure), so this
 * endpoint answers 200 even when no credential is configured or the upstream is
 * down — the Model field simply falls back to free text.
 */
const anthropicRouter = express.Router();

anthropicRouter.get(
  "/models",
  handler(async (_req, res) => {
    // Production leaves the runtime override unset (real host, global fetch,
    // process secret store); tests inject a mock server + in-memory secrets.
    const result = await fetchAnthropicModels(getRuntime().anthropic ?? {});
    res.status(200).json(result);
  })
);

export default anthropicRouter;

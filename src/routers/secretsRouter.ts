import express from "express";

import { listSecretKeys, setSecret, unsetSecret } from "../secrets";

import { handler, requireBody, requireString } from "./http";

/**
 * `/api/secrets` — manage the encrypted secret store, WRITE-ONLY by design.
 *
 *   GET /          the stored secret NAMES only (never a value)
 *   PUT /          upsert `{key, value}`; returns the name, never the value
 *   DELETE /:key   remove a secret (idempotent)
 *
 * A secret value is only ever readable inside a lease via the executor's env
 * injection; it never crosses this API boundary. This mirrors the store itself,
 * whose {@link import("../secrets").listSecretKeys} returns names only.
 */
const secretsRouter = express.Router();

secretsRouter.get(
  "/",
  handler((_req, res) => {
    res.status(200).json({ keys: listSecretKeys() });
  })
);

secretsRouter.put(
  "/",
  handler((req, res) => {
    const body = requireBody(req.body);
    const key = requireString(body.key, "key");
    const value = requireString(body.value, "value");
    setSecret(key, value);
    // Echo the NAME only — never the value, even on the write that set it.
    res.status(200).json({ key });
  })
);

secretsRouter.delete(
  "/:key",
  handler((req, res) => {
    unsetSecret(req.params.key);
    res.status(204).end();
  })
);

export default secretsRouter;

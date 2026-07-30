/**
 * The executor's injected secret resolver.
 *
 * A playbook declares the secret NAMES it needs in `env_requirements`; the
 * pipeline resolves each one to a value before renting a lease and injects the
 * resulting map into the lease `env` (so, e.g., `CLAUDE_CODE_OAUTH_TOKEN` reaches
 * the container and the `claude` CLI authenticates). This module is the single
 * place that reads those values out of the encrypted secret store.
 *
 * The resolver is deliberately per-name and value-only: it returns the decrypted
 * value for a known secret or `undefined` for an unknown one. It NEVER throws and
 * NEVER surfaces a name/value pair together — deciding what to do about a missing
 * secret (fail the dispatch before any lease is created, reporting only the
 * MISSING NAMES) is the executor's job, so no secret value can leak into an error
 * or a log here.
 */

import { getSecret } from "../secrets";

import type { EnvResolver } from "./executor";

/**
 * Build an {@link EnvResolver} backed by the encrypted secret store. Each
 * `env_requirements` name is looked up by {@link getSecret}, returning its
 * decrypted value or `undefined` when the store has no such secret.
 *
 * The underlying lookup is injectable purely so tests can supply a fake map
 * without touching the real keychain-backed store; production wiring uses the
 * process-wide store singleton.
 */
export function createSecretEnvResolver(
  lookup: (name: string) => string | undefined = getSecret
): EnvResolver {
  return (name: string) => lookup(name);
}

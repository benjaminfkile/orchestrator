/**
 * Anthropic model-list lookup — a READ-ONLY metadata fetch used to populate the
 * playbook Model picker in the SPA. It calls the public models endpoint
 * (`GET /v1/models`) and returns a domain-neutral `{id, display_name}` list
 * sorted with the most recently released models first.
 *
 * AUTH resolution order (both are secret NAMES resolved from the secret store,
 * never `process.env`):
 *   1. If `ANTHROPIC_API_KEY` is set, authenticate with the `x-api-key` header.
 *   2. Else if `CLAUDE_CODE_OAUTH_TOKEN` is set, authenticate with
 *      `Authorization: Bearer <token>` plus the `anthropic-beta: oauth-2025-04-20`
 *      header (this OAuth path is verified to work against the models endpoint).
 * The resolved secret VALUE travels only in the request header — it is never
 * logged, echoed into a warning, or returned to the client.
 *
 * DEGRADE, NEVER BREAK. The Model field is a convenience; a lookup failure must
 * not 500 the page. Every failure path (no credential, non-2xx, network/parse
 * error) resolves to `{models: [], warning}` so the router can always answer 200.
 *
 * The successful result is cached in-process for ~10 minutes so opening the
 * Playbooks page repeatedly does not re-hit the API. Failures are NOT cached, so
 * a transient outage clears as soon as the upstream recovers.
 */

/** Base URL of the Anthropic REST API host. */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/** API version pinned on every request. */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** Beta flag required alongside an OAuth bearer token on the models endpoint. */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/** Secret name holding a raw Anthropic API key (the preferred credential). */
export const ANTHROPIC_API_KEY_SECRET = "ANTHROPIC_API_KEY";

/** Secret name holding a Claude Code OAuth token (the fallback credential). */
export const ANTHROPIC_OAUTH_TOKEN_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";

/** How long a successful lookup is cached in-process (~10 minutes). */
export const ANTHROPIC_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

/** One model, reduced to the two fields the picker needs. */
export interface AnthropicModel {
  /** The model id, used verbatim as the playbook's Model value. */
  id: string;
  /** Human-readable name for the dropdown; falls back to the id. */
  display_name: string;
}

/**
 * The lookup outcome. `warning` is present only on a degraded path (missing
 * credential or an upstream failure); `models` is then an empty list.
 */
export interface AnthropicModelsResult {
  models: AnthropicModel[];
  warning?: string;
}

/** The `fetch` surface this service depends on; injectable for tests. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Injectable dependencies. Production leaves every field unset — the service
 * then uses the real Anthropic host, the global `fetch`, the process secret
 * store, and the wall clock; tests supply a mock server + in-memory secrets so
 * no real HTTP or credential is touched.
 */
export interface AnthropicModelsDeps {
  /** Base URL of the Anthropic host; defaults to {@link ANTHROPIC_API_BASE_URL}. */
  baseUrl?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Secret resolver; defaults to the process secret store's `getSecret`. */
  getSecret?: (key: string) => string | undefined;
  /** Clock, in epoch ms; defaults to `Date.now`. Cache TTL is measured against it. */
  now?: () => number;
  /** Cache lifetime override; defaults to {@link ANTHROPIC_MODELS_CACHE_TTL_MS}. */
  cacheTtlMs?: number;
  /** Optional abort signal for the request. */
  signal?: AbortSignal;
}

/** The in-process cache; holds only successful results. */
interface CacheEntry {
  expiresAt: number;
  result: AnthropicModelsResult;
}

let cache: CacheEntry | undefined;

/** Clear the in-process cache. Used by tests to isolate cases. */
export function resetAnthropicModelsCache(): void {
  cache = undefined;
}

/** The auth header set for a resolved credential, or `null` when none is set. */
function resolveAuthHeaders(
  getSecret: (key: string) => string | undefined
): Record<string, string> | null {
  const apiKey = getSecret(ANTHROPIC_API_KEY_SECRET);
  if (apiKey) {
    return {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
  }
  const oauthToken = getSecret(ANTHROPIC_OAUTH_TOKEN_SECRET);
  if (oauthToken) {
    return {
      authorization: `Bearer ${oauthToken}`,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "anthropic-version": ANTHROPIC_API_VERSION,
    };
  }
  return null;
}

/** One raw model object from the API, with only the fields we read typed. */
interface RawModel {
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
}

/**
 * Reduce the API payload to `{id, display_name}` sorted with current models
 * first. "Current" is decided by `created_at` (ISO-8601, so a lexical descending
 * sort puts the newest release first); models missing a timestamp sort last.
 */
function normalizeModels(parsed: unknown): AnthropicModel[] {
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const rows = data
    .filter(
      (m): m is RawModel =>
        typeof m === "object" && m !== null && typeof (m as RawModel).id === "string"
    )
    .map((m) => {
      const id = m.id as string;
      const displayName =
        typeof m.display_name === "string" && m.display_name.length > 0
          ? m.display_name
          : id;
      const createdAt = typeof m.created_at === "string" ? m.created_at : "";
      return { id, display_name: displayName, created_at: createdAt };
    })
    .filter((m) => m.id.length > 0);

  rows.sort((a, b) => {
    if (a.created_at && b.created_at) {
      // ISO-8601 timestamps compare lexically; newest first.
      return b.created_at.localeCompare(a.created_at);
    }
    if (a.created_at) return -1;
    if (b.created_at) return 1;
    return 0;
  });

  return rows.map(({ id, display_name }) => ({ id, display_name }));
}

/**
 * Fetch the Anthropic model list. Returns a cached successful result when one is
 * still fresh; otherwise resolves a credential and issues one GET. Any degraded
 * path yields `{models: [], warning}` — this function never throws or rejects.
 */
export async function fetchAnthropicModels(
  deps: AnthropicModelsDeps = {}
): Promise<AnthropicModelsResult> {
  const now = deps.now ?? Date.now;
  if (cache && cache.expiresAt > now()) {
    return cache.result;
  }

  const getSecret = deps.getSecret ?? loadDefaultGetSecret();
  const headers = resolveAuthHeaders(getSecret);
  if (!headers) {
    return {
      models: [],
      warning:
        `No Anthropic credential configured: set the ${ANTHROPIC_API_KEY_SECRET} ` +
        `or ${ANTHROPIC_OAUTH_TOKEN_SECRET} secret to list models.`,
    };
  }

  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const baseUrl = deps.baseUrl ?? ANTHROPIC_API_BASE_URL;
  // `limit=1000` pulls the full catalog in one page; the endpoint returns far
  // fewer models than that, so no pagination loop is needed.
  const url = `${baseUrl}/v1/models?limit=1000`;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: deps.signal,
    });
    if (!res.ok) {
      return {
        models: [],
        warning: `Anthropic model list request failed (HTTP ${res.status}).`,
      };
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    const models = normalizeModels(parsed);
    const result: AnthropicModelsResult = { models };
    const ttl = deps.cacheTtlMs ?? ANTHROPIC_MODELS_CACHE_TTL_MS;
    cache = { expiresAt: now() + ttl, result };
    return result;
  } catch {
    // Network error, aborted request, or malformed JSON — never surface details
    // (they could echo the request) and never cache the failure.
    return {
      models: [],
      warning: "Anthropic model list request failed.",
    };
  }
}

/**
 * Lazily load the process secret store's `getSecret`. Kept behind a function so
 * importing this module never forces the secrets module (and its native
 * keychain dependency) at import time, and so tests that inject `getSecret`
 * never touch the real store.
 */
function loadDefaultGetSecret(): (key: string) => string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getSecret } = require("../secrets") as {
    getSecret: (key: string) => string | undefined;
  };
  return getSecret;
}

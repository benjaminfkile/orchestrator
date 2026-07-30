/**
 * Wisper host-catalog lookup — a READ-ONLY metadata fetch used to populate the
 * playbook Host picker in the SPA without the browser ever holding the wisper
 * API key. It reads the authenticated consumer catalog (`GET /v1/catalog`)
 * SERVER-SIDE and reduces each host to the domain-neutral shape the picker needs:
 * `{id, name, os, online, images: [{id, name, price_cents_per_min}]}`.
 *
 * MODE-AWARE. In `v1` mode it fetches the real catalog with a bearer token
 * resolved (at call time) from the {@link WISPER_API_KEY_SECRET_NAME} secret — the
 * value travels only in the outbound header, is never logged, echoed into a
 * warning, or returned to the client. In `dev` mode there is no catalog, so it
 * returns a single SYNTHETIC entry for the configured `WISPER_HOST_ID` (os
 * unknown, assumed online, no priced images) so the UI degrades to a sensible
 * default rather than an empty picker.
 *
 * DEGRADE, NEVER BREAK. The Host field is a convenience; a lookup failure must
 * not 500 the page. Every failure path (no credential, non-2xx, network/parse
 * error) resolves to `{hosts: [], warning}` so the router always answers 200 —
 * exactly like {@link import("./anthropicModels").fetchAnthropicModels} does for
 * the Model picker. The picker stays freeform, so a blank (default host) or a
 * hand-typed host id remains committable regardless.
 */

import { getConfig, type Config } from "../config";
import {
  WISPER_API_KEY_SECRET_NAME,
  WisperApiError,
  bearerAuthorization,
  joinUrl,
  requestJson,
  toApiError,
  toAuthError,
} from "../wisper/client";

/** Default per-fetch timeout for the UI catalog fetch (`GET /v1/catalog`). */
export const DEFAULT_WISPER_HOSTS_TIMEOUT_MS = 30_000;

/** One image a host offers, reduced to the three fields the picker shows. */
export interface WisperHostImage {
  /** The catalog image id. */
  id: string;
  /** The wisp image ref/name shown in the option and committable as `image`. */
  name: string;
  /** Per-minute price in cents, or `null` when the catalog omits it. */
  price_cents_per_min: number | null;
}

/** One host, reduced to the fields the Host picker needs. `os` is the detail
 * users pick hosts by, so it is always surfaced (null when unknown). */
export interface WisperHost {
  /** The catalog host id, committed verbatim as the playbook's `host`. */
  id: string;
  /** Human-facing host name; a selector may match this OR {@link id}. */
  name: string;
  /** Operating system string (e.g. `linux`, `windows`), or null when unknown. */
  os: string | null;
  /** Whether the host is currently online. */
  online: boolean;
  images: WisperHostImage[];
}

/**
 * The lookup outcome. `warning` is present only on a degraded path (missing
 * credential or an upstream failure); `hosts` is then an empty list.
 */
export interface WisperHostsResult {
  hosts: WisperHost[];
  warning?: string;
}

/**
 * Injectable dependencies. Production leaves every field unset — the service
 * then reads the boot config (mode, base URL, host id), resolves the API key
 * from the process secret store, and uses the real wisper host; tests supply a
 * fake catalog + explicit mode so no real HTTP or credential is touched.
 */
export interface WisperHostsDeps {
  /** Wisper client mode; defaults to the boot config's `wisperMode`. */
  mode?: "dev" | "v1";
  /** Default host id for the dev synthetic entry; defaults to `wisperHostId`. */
  hostId?: string;
  /** Base URL of the wisper-api; defaults to the boot config's `wisperBaseUrl`. */
  baseUrl?: string;
  /** Per-fetch timeout; defaults to {@link DEFAULT_WISPER_HOSTS_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Resolves the wisper API key at CALL time (never `process.env`); defaults to
   * reading the {@link WISPER_API_KEY_SECRET_NAME} secret. Used only in v1 mode.
   */
  resolveApiKey?: () => string | undefined;
  /**
   * Test seam: override the raw catalog fetch. When set, `baseUrl`/`timeoutMs`/
   * `resolveApiKey` are unused and its rejection is treated like a real fetch
   * failure. Returns the parsed JSON body (any shape — {@link parseHosts} is
   * tolerant).
   */
  fetchCatalog?: (signal?: AbortSignal) => Promise<unknown>;
  /** Optional abort signal for the request. */
  signal?: AbortSignal;
}

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a non-empty string field, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A finite number field, or null. Used for the optional per-minute price. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reduce a raw `GET /v1/catalog` body to the picker's host shape, tolerating the
 * same field-name variation the lease/catalog parsers do. Accepts either a
 * top-level array of hosts, wisper's real `{ data: [...] }` page envelope, or a
 * `{ hosts: [...] }` envelope; a host id may arrive as `host_id` or `id`, the
 * host name as `label` (wisper's real key) or `name`, an image id as
 * `host_image_id` or `id`, an image name as
 * `image_ref`/`name`/`ref`, and a price as `price_cents_per_min`. A host with no
 * id, or an image missing both id and name, is skipped rather than fatal. A host
 * missing an explicit `online` flag is assumed online (the catalog lists rentable
 * hosts); `os` is null when the catalog omits it.
 */
export function parseHosts(raw: unknown): WisperHost[] {
  const hostsRaw = isRecord(raw) ? (raw.data ?? raw.hosts) : raw;
  const arr = Array.isArray(hostsRaw) ? hostsRaw : [];
  const hosts: WisperHost[] = [];
  for (const h of arr) {
    if (!isRecord(h)) continue;
    const id = str(h.host_id) ?? str(h.id);
    if (!id) continue;
    const name = str(h.label) ?? str(h.name) ?? id;
    const os = str(h.os) ?? null;
    const online = typeof h.online === "boolean" ? h.online : true;
    const imagesRaw = Array.isArray(h.images) ? h.images : [];
    const images: WisperHostImage[] = [];
    for (const im of imagesRaw) {
      if (!isRecord(im)) continue;
      const imageId = str(im.host_image_id) ?? str(im.id);
      const imageName = str(im.image_ref) ?? str(im.name) ?? str(im.ref);
      if (!imageId && !imageName) continue;
      images.push({
        id: imageId ?? imageName ?? "",
        name: imageName ?? imageId ?? "",
        price_cents_per_min: num(im.price_cents_per_min),
      });
    }
    hosts.push({ id, name, os, online, images });
  }
  return hosts;
}

/** Fetch the raw catalog over HTTP with a bearer token; map a non-200 to a typed error. */
async function fetchCatalogOverHttp(
  baseUrl: string,
  timeoutMs: number,
  resolveApiKey: () => string | undefined,
  signal?: AbortSignal
): Promise<unknown> {
  // bearerAuthorization throws a terminal, key-NAMING WisperApiError when the
  // secret is unset — caught below and surfaced as the warning, never a 500.
  const res = await requestJson(
    joinUrl(baseUrl, "/v1/catalog"),
    "GET",
    undefined,
    timeoutMs,
    signal,
    bearerAuthorization(resolveApiKey)
  );
  if (res.status !== 200) {
    throw res.status === 401 || res.status === 403
      ? toAuthError(res.status, res.body)
      : toApiError(res.status, res.body);
  }
  // JSON.parse may throw on a malformed body; the caller treats it as a failure.
  return JSON.parse(res.body);
}

/**
 * Fetch the host catalog for the SPA's Host picker. Never throws or rejects —
 * every degraded path resolves to `{hosts: [], warning}`.
 */
export async function fetchWisperHosts(
  deps: WisperHostsDeps = {}
): Promise<WisperHostsResult> {
  const cfg: Config = getConfig();
  const mode = deps.mode ?? cfg.wisperMode;

  if (mode === "dev") {
    // No catalog in dev mode: offer the single configured host so the picker
    // shows a sensible default rather than an empty list.
    const hostId = deps.hostId ?? cfg.wisperHostId;
    if (!hostId) {
      return {
        hosts: [],
        warning:
          "No wisper host configured: set WISPER_HOST_ID (or switch to v1 mode " +
          "for catalog-based host selection).",
      };
    }
    return {
      hosts: [{ id: hostId, name: hostId, os: null, online: true, images: [] }],
    };
  }

  const fetchCatalog =
    deps.fetchCatalog ??
    ((signal) =>
      fetchCatalogOverHttp(
        deps.baseUrl ?? cfg.wisperBaseUrl,
        deps.timeoutMs ?? DEFAULT_WISPER_HOSTS_TIMEOUT_MS,
        deps.resolveApiKey ?? defaultResolveApiKey(),
        signal
      ));

  try {
    const raw = await fetchCatalog(deps.signal);
    return { hosts: parseHosts(raw) };
  } catch (err) {
    // A WisperApiError message is curated and key-free (missing key, HTTP status,
    // insufficient funds), so it is safe and useful to surface. Anything else
    // (network/parse) gets a generic message — details could echo the request.
    const warning =
      err instanceof WisperApiError
        ? err.message
        : "wisper catalog request failed.";
    return { hosts: [], warning };
  }
}

/**
 * Lazily build the default API-key resolver from the process secret store. Kept
 * behind a function so importing this module never forces the secrets module (and
 * its native keychain dependency) at import time, and so tests that inject
 * `resolveApiKey`/`fetchCatalog` never touch the real store.
 */
function defaultResolveApiKey(): () => string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getSecret } = require("../secrets") as {
    getSecret: (key: string) => string | undefined;
  };
  return () => getSecret(WISPER_API_KEY_SECRET_NAME);
}

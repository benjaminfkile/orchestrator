import { log, type Logger } from "../log";

import {
  WisperApiError,
  bearerAuthorization,
  joinUrl,
  requestJson,
  toApiError,
  toAuthError,
} from "./client";

/**
 * The wisper `GET /v1/catalog` client used to resolve a playbook's domain-neutral
 * host selector and image NAME into the concrete catalog ids
 * (`host_id`/`host_image_id`) the `POST /v1/leases` body requires.
 *
 * Playbooks name images by their wisp image ref/name and (optionally) a host by
 * id OR name; the executor never sees a catalog id. In `v1` mode the client asks
 * the catalog what those names resolve to at dispatch time — so a host coming
 * online, an image being re-priced, or a host being renamed needs no playbook
 * edit. Resolution runs BEFORE any lease is created, so an unknown host, an
 * offline host (absent from the catalog), or an image a host does not offer fails
 * the dispatch loudly and up front — the same pre-lease semantics as a missing
 * secret or snippet.
 *
 * The catalog is cached in-process for a short TTL ({@link DEFAULT_CATALOG_CACHE_TTL_MS})
 * so a burst of dispatches shares one fetch; a FAILED fetch is never cached, so a
 * transient catalog outage self-heals on the next dispatch.
 */

/** A single priced image a host offers, as surfaced by the catalog. */
export interface CatalogImage {
  /** The catalog id sent as `host_image_id` when leasing. */
  host_image_id: string;
  /** The wisp image ref/name a playbook's `image` matches against. */
  image_ref: string;
}

/** A host in the catalog together with the images it offers. */
export interface CatalogHost {
  /** The catalog id sent as `host_id` when leasing. */
  host_id: string;
  /** The host's human-facing name; a selector may match this OR {@link host_id}. */
  name: string;
  images: CatalogImage[];
  /**
   * The isolation levels this host can provide (a subset of "shared" |
   * "sandboxed" | "vm"). Empty when the catalog omits the field — an older
   * server that predates isolation — in which case the client cannot fail fast
   * and defers the check to the server.
   */
  isolation_levels: string[];
  /**
   * The isolation level the host applies when a lease omits one, or `null` when
   * the catalog does not report it. Informational — the fail-fast check keys off
   * {@link isolation_levels}.
   */
  default_isolation: string | null;
}

/** The concrete catalog ids a lease body needs, produced by {@link HostImageResolver.resolve}. */
export interface ResolvedHostImage {
  host_id: string;
  host_image_id: string;
}

/**
 * Resolves a (host selector, image name) pair to concrete catalog ids. Injected
 * into {@link WisperClient} so tests can supply a fake catalog without a server.
 */
export interface HostImageResolver {
  resolve(
    hostSelector: string,
    imageName: string,
    isolation?: string,
    signal?: AbortSignal
  ): Promise<ResolvedHostImage>;
}

/** Default in-process catalog cache TTL (~60s). A failed fetch is not cached. */
export const DEFAULT_CATALOG_CACHE_TTL_MS = 60_000;

/** Default per-fetch timeout for `GET /v1/catalog`. */
export const DEFAULT_CATALOG_TIMEOUT_MS = 30_000;

/** Construction options for {@link WisperCatalog}. */
export interface WisperCatalogOptions {
  /** Base URL of the wisper-api (e.g. `http://localhost:8080`). */
  baseUrl: string;
  /**
   * Resolves the wisper API key at CALL time (never from `process.env`); the
   * catalog is an authenticated endpoint. A missing/empty key raises the same
   * terminal, key-NAMING error the lease calls do, before any request is sent.
   */
  resolveApiKey?: () => string | undefined;
  /** Cache TTL in ms; defaults to {@link DEFAULT_CATALOG_CACHE_TTL_MS}. */
  cacheTtlMs?: number;
  /** Per-fetch timeout in ms; defaults to {@link DEFAULT_CATALOG_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
  /** Clock for cache expiry, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Test seam: override the raw catalog fetch with a "fake catalog". When set,
   * `baseUrl`/`resolveApiKey`/`timeoutMs` are unused. Its rejections are treated
   * exactly like a real fetch failure (never cached).
   */
  fetchCatalog?: (signal?: AbortSignal) => Promise<CatalogHost[]>;
}

/** True for a non-null, non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a non-empty string field, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse a `GET /v1/catalog` body into typed hosts, tolerating field-name
 * variation the same way the lease parsers do. Accepts a top-level array of
 * hosts, wisper's real `{ data: [...] }` page envelope, or a `{ hosts: [...] }`
 * envelope; a host id may arrive as `host_id` or `id`, the host name as `label`
 * (wisper's real key) or `name`, an image id as `host_image_id` or `id`, and an
 * image name as `image_ref`, `name`, or `ref`. Malformed entries are skipped,
 * not fatal.
 */
export function parseCatalog(body: string): CatalogHost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WisperApiError({
      code: "invalid_catalog",
      httpStatus: 200,
      message: "wisper catalog response was not valid JSON",
      requestId: "",
      retryable: false,
    });
  }
  const hostsRaw = isRecord(parsed) ? (parsed.data ?? parsed.hosts) : parsed;
  const arr = Array.isArray(hostsRaw) ? hostsRaw : [];
  const hosts: CatalogHost[] = [];
  for (const h of arr) {
    if (!isRecord(h)) continue;
    const host_id = str(h.host_id) ?? str(h.id);
    if (!host_id) continue;
    const name = str(h.label) ?? str(h.name) ?? "";
    const imagesRaw = Array.isArray(h.images) ? h.images : [];
    const images: CatalogImage[] = [];
    for (const im of imagesRaw) {
      if (!isRecord(im)) continue;
      const host_image_id = str(im.host_image_id) ?? str(im.id);
      const image_ref = str(im.image_ref) ?? str(im.name) ?? str(im.ref);
      if (!host_image_id || !image_ref) continue;
      images.push({ host_image_id, image_ref });
    }
    const isolation_levels = Array.isArray(h.isolation_levels)
      ? h.isolation_levels.filter((v): v is string => typeof v === "string")
      : [];
    hosts.push({
      host_id,
      name,
      images,
      isolation_levels,
      default_isolation: str(h.default_isolation) ?? null,
    });
  }
  return hosts;
}

/** The authenticated, cached `GET /v1/catalog` client and name resolver. */
export class WisperCatalog implements HostImageResolver {
  private readonly baseUrl: string;
  private readonly resolveApiKey?: () => string | undefined;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fetchImpl: (signal?: AbortSignal) => Promise<CatalogHost[]>;

  /** The last successful fetch and when it expires; undefined until first fetch. */
  private cache?: { hosts: CatalogHost[]; expiresAt: number };

  constructor(options: WisperCatalogOptions) {
    this.baseUrl = options.baseUrl;
    this.resolveApiKey = options.resolveApiKey;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CATALOG_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
    this.logger = options.logger ?? log;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchCatalog ?? ((signal) => this.fetchOverHttp(signal));
  }

  /** Fetch the catalog over HTTP with a bearer token; map a non-200 to a typed error. */
  private async fetchOverHttp(signal?: AbortSignal): Promise<CatalogHost[]> {
    const res = await requestJson(
      joinUrl(this.baseUrl, "/v1/catalog"),
      "GET",
      undefined,
      this.timeoutMs,
      signal,
      bearerAuthorization(this.resolveApiKey)
    );
    if (res.status !== 200) {
      throw res.status === 401 || res.status === 403
        ? toAuthError(res.status, res.body)
        : toApiError(res.status, res.body);
    }
    return parseCatalog(res.body);
  }

  /**
   * Return the catalog hosts, serving a live cache within the TTL and otherwise
   * fetching afresh. A failed fetch propagates and is NEVER cached, so the next
   * call retries rather than serving a stale (or empty) failure.
   */
  private async getCatalog(signal?: AbortSignal): Promise<CatalogHost[]> {
    const nowMs = this.now();
    if (this.cache && nowMs < this.cache.expiresAt) {
      return this.cache.hosts;
    }
    const hosts = await this.fetchImpl(signal);
    this.cache = { hosts, expiresAt: nowMs + this.cacheTtlMs };
    return hosts;
  }

  /**
   * Resolve a host selector (matching a catalog host's id OR name) and an image
   * name (matching an `image_ref` the host offers) to their catalog ids. Throws a
   * plain, terminal Error naming BOTH sides when the host is unknown/offline or
   * the image is not offered — a pre-lease failure, exactly like a missing secret.
   *
   * When a non-empty `isolation` is requested and the host advertises its
   * `isolation_levels`, a level the host does NOT offer also fails here — before
   * any lease is created — with an Error naming the host and the levels it does
   * support. A host that advertises no levels (an older server) is not checked;
   * the request proceeds and wisper validates the field itself.
   */
  async resolve(
    hostSelector: string,
    imageName: string,
    isolation?: string,
    signal?: AbortSignal
  ): Promise<ResolvedHostImage> {
    const hosts = await this.getCatalog(signal);
    const host = hosts.find(
      (h) => h.host_id === hostSelector || h.name === hostSelector
    );
    if (!host) {
      throw new Error(
        `wisper host "${hostSelector}" is not available (unknown or offline)`
      );
    }
    const image = host.images.find((im) => im.image_ref === imageName);
    if (!image) {
      throw new Error(
        `image "${imageName}" is not offered by host "${hostSelector}"`
      );
    }
    if (
      isolation &&
      host.isolation_levels.length > 0 &&
      !host.isolation_levels.includes(isolation)
    ) {
      throw new Error(
        `host "${hostSelector}" cannot provide "${isolation}" isolation ` +
          `(offers: ${host.isolation_levels.join(", ")})`
      );
    }
    return { host_id: host.host_id, host_image_id: image.host_image_id };
  }
}

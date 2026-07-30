// Thin fetch wrapper around the orchestrator REST API. All backend routes live
// under `/api`; in dev, Vite proxies that prefix to the loopback Express server
// (see vite.config.ts). Responses are JSON; errors are normalized into a single
// ApiError type so callers never have to inspect raw Response objects.

/** Base path for every API request. Kept relative so the same build works in
 * dev (proxied) and in production (served from the same origin as the SPA). */
export const API_BASE = "/api";

/** Normalized error thrown for any non-2xx response or transport failure. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  /** Parsed error body when the server returned one, otherwise undefined. */
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiRequestOptions {
  method?: string;
  /** JSON-serializable request body; sets Content-Type automatically. */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Pull a human-readable message out of an error response body. The backend
 * routers return `{ error: string }`; fall back to the raw text otherwise. */
function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown; message?: unknown }).error;
    if (typeof err === "string" && err) return err;
    const msg = (body as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  if (typeof body === "string" && body) return body;
  return fallback;
}

/** Response header a discovery endpoint sets when it degraded a permission
 * failure to a 200 empty result; its value is a human-readable reason. */
export const RESTRICTED_HEADER = "X-Ado-Restricted";

/**
 * Core request: fetch, parse the body once, and throw {@link ApiError} on
 * transport failure or any non-2xx status. Returns the raw {@link Response}
 * alongside the parsed body so header-aware callers can inspect it.
 */
async function requestCore(
  path: string,
  options: ApiRequestOptions,
): Promise<{ res: Response; parsed: unknown }> {
  const { method = "GET", body, signal, headers = {} } = options;

  const init: RequestInit = { method, signal, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (cause) {
    // Network-level failure (server down, aborted, offline). Preserve abort
    // semantics so callers can distinguish cancellation from real errors.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(message, 0);
  }

  // Parse the body once; tolerate empty (e.g. 204) and non-JSON responses.
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(
      messageFromBody(parsed, `Request failed with status ${res.status}`),
      res.status,
      parsed,
    );
  }

  return { res, parsed };
}

/**
 * Perform a JSON request against the API and return the parsed body.
 *
 * @throws {ApiError} on transport failure or any non-2xx status.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  return (await requestCore(path, options)).parsed as T;
}

/**
 * Like {@link apiFetch}, but also surfaces the {@link RESTRICTED_HEADER} value
 * when present. Used by ADO discovery: a permission failure is a successful 200
 * with an empty list — NOT a 5xx that reddens the network log — and the header
 * carries the "your PAT is restricted" reason for the caller to show.
 */
export async function apiFetchRestrictable<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<{ data: T; restricted?: string }> {
  const { res, parsed } = await requestCore(path, options);
  const restricted = res.headers.get(RESTRICTED_HEADER) || undefined;
  return { data: parsed as T, restricted };
}

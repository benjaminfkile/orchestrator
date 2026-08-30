import { randomUUID } from "crypto";
import http from "http";
import https from "https";
import { URL } from "url";

import { getConfig, type Config, ConfigError } from "../config";
import type { LeaseIsolation } from "../interfaces";
import { log, type Logger } from "../log";
import { getSecret } from "../secrets";

import { WisperCatalog, type HostImageResolver } from "./catalog";

export type { LeaseIsolation } from "../interfaces";

/**
 * HTTP client for the local wisper-api dev lease surface
 * (`/dev/leases` endpoints).
 *
 * Only the two lifecycle operations orchestrator owns live here: renting a lease
 * ({@link WisperClient.createLease}) and releasing it
 * ({@link WisperClient.releaseLease}). Per the LEASE PRINCIPLE, lifecycle is
 * always driven by orchestrator code — never by the agent inside the lease.
 *
 * SECURITY: the `env` map handed to {@link WisperClient.createLease} carries
 * secrets injected into the lease. Its keys and values are NEVER written to a
 * log line or embedded in a thrown error. Only the server-supplied error
 * envelope (code/message/request_id) surfaces in {@link WisperApiError}.
 */

/** Resource limits requested for a lease. */
export interface WisperResources {
  cpus?: number;
  memory_mb?: number;
  pids?: number;
}

/**
 * A file staged into a lease at create time. `path` is an absolute unix-style
 * path (starts with `/`, no `..` segment, no backslash, at most 256 chars,
 * unique per request), and `content_base64` is the file's raw bytes, base64
 * encoded. Files are written into the container AFTER start and BEFORE
 * `userdata` runs, so userdata (and every exec after it) can read them.
 *
 * Per the wisper contract, a create request may carry AT MOST
 * {@link MAX_FILES_PER_LEASE} files whose DECODED sizes sum to at most
 * {@link MAX_FILES_TOTAL_BYTES}. On a windows lease the same unix-style paths
 * are mapped onto the container filesystem the same way exec working
 * directories already resolve. The `files` map is NEVER logged: file contents
 * may be sensitive (e.g. the fully rendered prompt).
 */
export interface LeaseFileSpec {
  path: string;
  content_base64: string;
}

/**
 * Maximum number of {@link LeaseFileSpec} entries a single create request may
 * carry. The wisper server enforces the same cap; this client-side constant
 * fails a request over the cap BEFORE it is sent, with a typed
 * {@link WisperApiError} whose code is `validation_error`.
 */
export const MAX_FILES_PER_LEASE = 16;

/**
 * Maximum SUMMED DECODED size (bytes) of every {@link LeaseFileSpec} on a
 * single create request. The wisper server enforces the same cap; this
 * client-side constant fails a request over the cap BEFORE it is sent, with a
 * typed {@link WisperApiError} whose code is `validation_error`.
 */
export const MAX_FILES_TOTAL_BYTES = 1024 * 1024;

/**
 * Maximum length of a single {@link LeaseFileSpec} `path` field. Matches the
 * wisper server-side cap; a longer path fails locally as `validation_error`.
 */
export const MAX_FILE_PATH_CHARS = 256;

/** Arguments for {@link WisperClient.createLease}. */
export interface CreateLeaseParams {
  image: string;
  /**
   * Optional host selector, opaque to callers. When omitted the client falls back
   * to its configured host id ({@link WisperClientOptions.hostId} — `WISPER_HOST_ID`).
   *
   * In `v1` mode it (and {@link CreateLeaseParams.image}) are resolved against the
   * wisper catalog to `host_id`/`host_image_id` BEFORE the lease is created — the
   * selector matches a catalog host's id OR name. In `dev` mode it is used
   * verbatim as the dev `hostId`, so a per-playbook host is meaningful in both
   * modes.
   */
  host?: string;
  /**
   * Optional lease isolation level, one of "shared" | "sandboxed" | "vm".
   * Included in the create-lease request body — on BOTH the `v1` (`POST
   * /v1/leases`) and `dev` (`POST /dev/leases`) surfaces — only when defined;
   * omitting it lets the wisper server apply its own default ("shared"), so it
   * is never defaulted client-side. In `v1` mode it is also checked against the
   * selected host's advertised `isolation_levels` during catalog resolution, so
   * a host that cannot provide the requested level fails the dispatch BEFORE any
   * lease is created — the same pre-lease semantics as an unknown host or
   * unoffered image.
   */
  isolation?: LeaseIsolation;
  network: string;
  resources: WisperResources;
  ttl_seconds: number;
  userdata: string;
  /**
   * Optional secret environment injected into the lease. NEVER logged and never
   * echoed into an error message by this client.
   */
  env?: Record<string, string>;
  /**
   * Optional files staged into the container AFTER start and BEFORE `userdata`
   * runs (so userdata and every exec after it can read them). See
   * {@link LeaseFileSpec} for shape and caps; the client validates the caps
   * and path shapes BEFORE sending; an oversize/malformed entry throws a
   * terminal {@link WisperApiError} with code `validation_error` instead of
   * being sent to the server. The list and its contents are NEVER logged.
   */
  files?: LeaseFileSpec[];
  /**
   * Timeout in ms for this call. Defaults to
   * {@link DEFAULT_CREATE_LEASE_TIMEOUT_MS} — the longest per-operation default,
   * because a createLease 201 blocks on lease readiness (see the method doc).
   */
  timeoutMs?: number;
  /**
   * Optional caller {@link AbortSignal}. Aborting destroys the in-flight request
   * and rejects the returned promise promptly.
   */
  signal?: AbortSignal;
}

/**
 * The operating-system family a lease's container runs. Governs how execs are
 * wrapped host-side (`/bin/sh -c` on linux, `cmd /c` on windows), which changes
 * how an exec command string must be quoted. Older wisper servers omit the field
 * from the create-lease response; that absence is normalized to `null` and MUST
 * be treated exactly like `linux` by callers.
 */
export type LeaseOs = "linux" | "windows";

/** A freshly rented lease, as returned by a 201 from `POST /dev/leases`. */
export interface Lease {
  leaseId: string;
  wispContractId: string;
  status: string;
  /**
   * OS family of the lease's container, from the create-lease response. `null`
   * when the server did not report one (older servers) — callers must treat that
   * the same as `linux`.
   */
  os: LeaseOs | null;
  /**
   * Isolation level the server actually granted, from the lease view. `null`
   * when the server did not report one (dev mode, or an older server that
   * predates isolation).
   */
  isolation: LeaseIsolation | null;
}

/** Per-call options for {@link WisperClient.execSync}. */
export interface ExecSyncOptions {
  /**
   * Request timeout in ms for this exec. Defaults to the client's configured
   * timeout ({@link DEFAULT_EXEC_TIMEOUT_MS} when unset). A timed-out request
   * rejects with a {@link WisperApiError} whose code is
   * `upstream_timeout_client`; it is not reported as a non-zero exit.
   */
  timeoutMs?: number;
  /**
   * Optional caller {@link AbortSignal}. Aborting destroys the in-flight request
   * and rejects the returned promise promptly.
   */
  signal?: AbortSignal;
}

/** A single streamed output chunk delivered to {@link ExecStreamOptions.onChunk}. */
export interface StreamChunk {
  /** Which output stream the bytes came from. */
  stream: "stdout" | "stderr";
  /** The decoded UTF-8 text for this chunk. */
  data: string;
}

/** Per-call options for {@link WisperClient.execStream}. */
export interface ExecStreamOptions {
  /**
   * Invoked once per `chunk` event, in wire order, as output arrives. Chunks are
   * delivered synchronously as frames are parsed; a throwing callback aborts the
   * stream and rejects the returned promise.
   */
  onChunk?: (chunk: StreamChunk) => void;
  /**
   * Idle (inter-chunk) timeout in ms for the stream. Defaults to the client's
   * configured timeout ({@link DEFAULT_EXEC_TIMEOUT_MS} when unset). A timed-out
   * stream rejects with a {@link WisperApiError} whose code is
   * `upstream_timeout_client`.
   */
  timeoutMs?: number;
  /**
   * Optional caller {@link AbortSignal}. Aborting destroys the response stream
   * and rejects the returned promise promptly.
   */
  signal?: AbortSignal;
}

/**
 * Terminal result of a streamed exec: the process exit code carried by the
 * SSE `exit` event. Like {@link ExecResult.exitCode}, a non-zero value is NOT an
 * error — the command ran and reported failure.
 */
export interface ExecStreamResult {
  exitCode: number;
}

/**
 * Result of a synchronous exec: `POST /dev/leases/{leaseId}/exec` returning
 * HTTP 200 with `{stdout, stderr, exit_code}` (note snake_case `exit_code`).
 *
 * A non-zero {@link ExecResult.exitCode} is NOT an error — the command ran to
 * completion and reported failure. Callers decide what a non-zero exit means.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; may be non-zero without being a client error. */
  exitCode: number;
}

/** Fields carried by a {@link WisperApiError}. */
export interface WisperApiErrorFields {
  /** Machine-readable error code from the envelope (e.g. `host_offline`). */
  code: string;
  /** HTTP status of the failing response. */
  httpStatus: number;
  /** Human-readable message from the envelope. */
  message: string;
  /** Server-assigned request id from the envelope, or "" when absent. */
  requestId: string;
  /** True when retrying the same call could plausibly succeed. */
  retryable: boolean;
}

/**
 * Machine-readable code for a client-side timeout — orchestrator gave up waiting
 * for wisper. Deliberately distinct from the server-sent `upstream_timeout` (the
 * wisper host's own upstream timed out) so callers can tell the two apart.
 */
const CLIENT_TIMEOUT_CODE = "upstream_timeout_client";

/**
 * Error codes for which retrying the same request may succeed: the host was
 * transiently offline, or an upstream call timed out (either server-sent,
 * `upstream_timeout`, or client-side, {@link CLIENT_TIMEOUT_CODE}). All other
 * codes describe a durable failure (validation, capacity, not-found, ...) and
 * are not retryable.
 */
const RETRYABLE_CODES = new Set<string>([
  "host_offline",
  "upstream_timeout",
  CLIENT_TIMEOUT_CODE,
]);

/**
 * Name of the secret holding the wisper API key. In `v1` mode the client
 * resolves this from the orchestrator secret store at call time and sends it as
 * `Authorization: Bearer <key>`. It is NEVER read from `process.env` and its
 * value is NEVER logged or placed in an error message — only the NAME appears in
 * config errors so an operator knows which secret to set.
 */
export const WISPER_API_KEY_SECRET_NAME = "WISPER_API_KEY";

/**
 * Build the `Authorization` header value for a v1 request from the resolved API
 * key. Resolves the key at CALL time (never `process.env`); a missing/empty key
 * throws a terminal, key-NAMING {@link WisperApiError} before any request is
 * sent. The key value is never logged and never placed in the error. Shared by
 * the lease client and the {@link WisperCatalog} so both authenticate identically.
 */
export function bearerAuthorization(
  resolveApiKey: (() => string | undefined) | undefined
): string {
  const key = resolveApiKey?.();
  if (!key) {
    throw new WisperApiError({
      code: "missing_api_key",
      httpStatus: 0,
      message:
        `${WISPER_API_KEY_SECRET_NAME} secret is not set; v1 mode requires it ` +
        "to authenticate with wisper. Add it via the secrets store.",
      requestId: "",
      retryable: false,
    });
  }
  return `Bearer ${key}`;
}

/**
 * A typed error raised for any non-2xx wisper response. The `code` comes from
 * the response envelope when present; `retryable` is derived from `code`.
 */
export class WisperApiError extends Error implements WisperApiErrorFields {
  readonly code: string;
  readonly httpStatus: number;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(fields: WisperApiErrorFields) {
    super(fields.message);
    this.name = "WisperApiError";
    this.code = fields.code;
    this.httpStatus = fields.httpStatus;
    this.requestId = fields.requestId;
    this.retryable = fields.retryable;
  }
}

/**
 * Default timeout for {@link WisperClient.createLease}, and the LONGEST of the
 * per-operation defaults. A createLease request blocks server-side: the `POST
 * /dev/leases` 201 is not sent until the lease has been provisioned and is
 * ready to accept execs (see {@link WisperClient.createLease}). The client must
 * therefore wait out that readiness await, which is far longer than a normal
 * request round-trip — hence the generous default here.
 */
export const DEFAULT_CREATE_LEASE_TIMEOUT_MS = 150_000;

/**
 * Default timeout for the exec and release operations. These do NOT block on
 * provisioning, so they use a shorter window than
 * {@link DEFAULT_CREATE_LEASE_TIMEOUT_MS}. For streaming execs it is an idle
 * (inter-chunk) timeout, not a wall-clock cap on total run time.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * @deprecated Use {@link DEFAULT_CREATE_LEASE_TIMEOUT_MS} (createLease) or
 * {@link DEFAULT_EXEC_TIMEOUT_MS} (exec/release). Retained as an alias for the
 * createLease default.
 */
export const DEFAULT_TIMEOUT_MS = DEFAULT_CREATE_LEASE_TIMEOUT_MS;

/** Which wisper surface {@link WisperClient} speaks to. */
export type WisperMode = "dev" | "v1";

/** Construction options for {@link WisperClient}. */
export interface WisperClientOptions {
  /** Base URL of the wisper-api (e.g. `http://localhost:8080`). */
  baseUrl: string;
  /** hostId targeted on the dev endpoints. */
  hostId: string;
  /**
   * Which surface to speak. `dev` (default) uses the unauthenticated
   * `/dev/leases` harness — byte-for-byte the historical behavior. `v1` uses the
   * authenticated `/v1/leases` consumer surface and sends a bearer token
   * resolved via {@link WisperClientOptions.resolveApiKey} on every request.
   */
  mode?: WisperMode;
  /**
   * Resolves the wisper API key (the {@link WISPER_API_KEY_SECRET_NAME} secret)
   * at CALL time — never at construction, never from `process.env`. Required in
   * v1 mode; a missing/empty result raises a terminal, key-naming error before
   * any request is sent. Ignored in dev mode. The returned value is used only to
   * build the `Authorization` header and is NEVER logged.
   */
  resolveApiKey?: () => string | undefined;
  /**
   * Resolver from a (host selector, image name) pair to catalog ids, used only in
   * `v1` mode to turn a playbook's host/image NAMES into `host_id`/`host_image_id`
   * before leasing. Defaults to a {@link WisperCatalog} over this client's
   * base URL and API key; tests inject a fake catalog. Ignored in dev mode.
   */
  catalog?: HostImageResolver;
  /**
   * Request timeout in ms. When set it overrides the per-operation defaults
   * ({@link DEFAULT_CREATE_LEASE_TIMEOUT_MS}, {@link DEFAULT_EXEC_TIMEOUT_MS})
   * for every call. When unset, each call falls back to its own default. A
   * per-call `timeoutMs` overrides both.
   */
  timeoutMs?: number;
  /** Logger; defaults to the shared process logger. */
  logger?: Logger;
}

/** A raw HTTP response body plus its status. */
interface RawResponse {
  status: number;
  body: string;
}

/**
 * Build a terminal, non-retryable {@link WisperApiError} for a client-side
 * `validation_error`: a request the client refuses to send because it would
 * be rejected by the server anyway (an oversize/malformed
 * {@link LeaseFileSpec} entry). The message describes the offense; the file
 * path is included when relevant but a file's CONTENT is never surfaced.
 */
function localValidationError(message: string): WisperApiError {
  return new WisperApiError({
    code: "validation_error",
    httpStatus: 0,
    message,
    requestId: "",
    retryable: false,
  });
}

/**
 * Validate a {@link CreateLeaseParams.files} array against the wisper contract
 * BEFORE any request is sent. Throws a terminal {@link WisperApiError} with
 * code `validation_error` on the first offense. Checks:
 *   - at most {@link MAX_FILES_PER_LEASE} entries;
 *   - each `path` is an absolute unix-style path (starts with `/`), has no
 *     `..` segment, no backslash, and at most {@link MAX_FILE_PATH_CHARS}
 *     chars;
 *   - `path` values are unique across the array;
 *   - `content_base64` is valid, canonical base64;
 *   - decoded sizes sum to at most {@link MAX_FILES_TOTAL_BYTES}.
 * File contents are never surfaced in the error message.
 */
export function validateLeaseFiles(files: readonly LeaseFileSpec[]): void {
  if (files.length > MAX_FILES_PER_LEASE) {
    throw localValidationError(
      `lease files: ${files.length} entries exceed the ${MAX_FILES_PER_LEASE}-file cap`
    );
  }
  const seen = new Set<string>();
  let totalDecodedBytes = 0;
  for (const file of files) {
    const path = file.path;
    if (typeof path !== "string" || path.length === 0) {
      throw localValidationError(
        "lease files: entry has a missing or empty path"
      );
    }
    if (path.length > MAX_FILE_PATH_CHARS) {
      throw localValidationError(
        `lease files: path exceeds ${MAX_FILE_PATH_CHARS} chars: ${path.slice(0, 32)}...`
      );
    }
    if (!path.startsWith("/")) {
      throw localValidationError(
        `lease files: path is not absolute unix-style (must start with "/"): ${path}`
      );
    }
    if (path.includes("\\")) {
      throw localValidationError(
        `lease files: path contains a backslash (unix-style paths only): ${path}`
      );
    }
    if (path.split("/").some((segment) => segment === "..")) {
      throw localValidationError(
        `lease files: path contains a ".." segment: ${path}`
      );
    }
    if (seen.has(path)) {
      throw localValidationError(
        `lease files: duplicate path in the same request: ${path}`
      );
    }
    seen.add(path);
    const b64 = file.content_base64;
    if (typeof b64 !== "string") {
      throw localValidationError(
        `lease files: content_base64 is not a string for path ${path}`
      );
    }
    // Node's Buffer.from(_, "base64") is permissive (it silently drops invalid
    // characters), so round-trip and compare canonical forms: a discrepancy
    // means the input was not valid, canonical base64.
    const decoded = Buffer.from(b64, "base64");
    if (decoded.toString("base64") !== b64) {
      throw localValidationError(
        `lease files: invalid base64 for path ${path}`
      );
    }
    totalDecodedBytes += decoded.length;
    if (totalDecodedBytes > MAX_FILES_TOTAL_BYTES) {
      throw localValidationError(
        `lease files: total decoded bytes ${totalDecodedBytes} exceed the ${MAX_FILES_TOTAL_BYTES}-byte cap`
      );
    }
  }
}

/**
 * Fallback error code when a non-2xx response has no usable envelope. The server
 * normally supplies `error.code`; these keep {@link WisperApiError.code} sane
 * when it does not.
 */
function fallbackCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "validation_error";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 502:
      return "lease_failed";
    case 504:
      return "upstream_timeout";
    default:
      return "wisper_error";
  }
}

/** Parse a non-2xx response into a typed {@link WisperApiError}. */
export function toApiError(status: number, body: string): WisperApiError {
  let code = "";
  let message = "";
  let requestId = "";

  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown; request_id?: unknown };
    };
    const envelope = parsed?.error;
    if (envelope && typeof envelope === "object") {
      if (typeof envelope.code === "string") code = envelope.code;
      if (typeof envelope.message === "string") message = envelope.message;
      if (typeof envelope.request_id === "string") requestId = envelope.request_id;
    }
  } catch {
    // Non-JSON error body: fall through to status-derived defaults. The raw body
    // is intentionally NOT surfaced — it could echo request data.
  }

  if (!code) code = fallbackCodeForStatus(status);
  if (!message) message = `wisper request failed with HTTP ${status}`;

  return new WisperApiError({
    code,
    httpStatus: status,
    message,
    requestId,
    retryable: RETRYABLE_CODES.has(code),
  });
}

/** Read the `error` envelope of a response body, tolerating malformed JSON. */
function parseErrorEnvelope(
  body: string
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const envelope = parsed?.error;
    return envelope && typeof envelope === "object"
      ? (envelope as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a v1 auth rejection (HTTP 401/403) to a terminal (never-retryable)
 * {@link WisperApiError}. The message names {@link WISPER_API_KEY_SECRET_NAME}
 * so an operator knows which secret to fix, and NEVER echoes the key value or
 * the raw server body (which could reflect the bearer token back). The envelope
 * `code` is kept when present so callers can still see e.g. `invalid_api_key`.
 */
export function toAuthError(status: number, body: string): WisperApiError {
  const envelope = parseErrorEnvelope(body);
  const code =
    typeof envelope?.code === "string" && envelope.code
      ? (envelope.code as string)
      : status === 403
        ? "forbidden"
        : "unauthorized";
  return new WisperApiError({
    code,
    httpStatus: status,
    message:
      `wisper rejected the ${WISPER_API_KEY_SECRET_NAME} secret (HTTP ${status}); ` +
      "check that the configured API key is valid and authorized.",
    requestId: typeof envelope?.request_id === "string" ? envelope.request_id : "",
    retryable: false,
  });
}

/** Read an integer cents field from an error envelope, or undefined. */
function centsField(envelope: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = envelope?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Map a v1 `insufficient_funds` rejection (HTTP 402) to a terminal
 * (never-retryable) {@link WisperApiError}, folding the required/available cents
 * from the error envelope into the message when the server supplies them.
 */
function toInsufficientFundsError(status: number, body: string): WisperApiError {
  const envelope = parseErrorEnvelope(body);
  const code =
    typeof envelope?.code === "string" && envelope.code
      ? (envelope.code as string)
      : "insufficient_funds";
  const required = centsField(envelope, "required_cents");
  const available = centsField(envelope, "available_cents");
  let message = "wisper reports insufficient funds to rent the lease";
  if (required !== undefined || available !== undefined) {
    const parts: string[] = [];
    if (required !== undefined) parts.push(`requires ${required} cents`);
    if (available !== undefined) parts.push(`${available} cents available`);
    message += ` (${parts.join(", ")})`;
  }
  return new WisperApiError({
    code,
    httpStatus: status,
    message,
    requestId: typeof envelope?.request_id === "string" ? envelope.request_id : "",
    retryable: false,
  });
}

/**
 * Normalize a response `os` field to a {@link LeaseOs} or null. Only the two
 * known strings are honored; anything else — absent, null (a v1 lease on an
 * offline host reports `os: null`), or an unknown value from an older/newer
 * server — becomes null, which callers treat as linux.
 */
function coerceOs(raw: unknown): LeaseOs | null {
  return raw === "linux" || raw === "windows" ? raw : null;
}

/**
 * Normalize a response `isolation` field to a {@link LeaseIsolation} or null.
 * Only the three known strings are honored; anything else — absent, null, or an
 * unknown value from a newer/older server — becomes null.
 */
function coerceIsolation(raw: unknown): LeaseIsolation | null {
  return raw === "shared" || raw === "sandboxed" || raw === "vm" ? raw : null;
}

/** Parse a dev `POST /dev/leases` 201 body into a {@link Lease}. */
function parseDevLease(body: string): Lease {
  const parsed = JSON.parse(body) as {
    leaseId?: unknown;
    wispContractId?: unknown;
    status?: unknown;
    os?: unknown;
    isolation?: unknown;
  };
  return {
    leaseId: typeof parsed.leaseId === "string" ? parsed.leaseId : "",
    wispContractId:
      typeof parsed.wispContractId === "string" ? parsed.wispContractId : "",
    status: typeof parsed.status === "string" ? parsed.status : "",
    os: coerceOs(parsed.os),
    isolation: coerceIsolation(parsed.isolation),
  };
}

/**
 * Parse a v1 `POST /v1/leases` 201 body (a LeaseView) into a {@link Lease}. The
 * consumer surface is snake_case: the lease id is `id` and the contract id is
 * `wisp_contract_id`. Both camelCase spellings are accepted as a fallback so a
 * server that mixes conventions still parses. `os` is null when the host is
 * offline (see {@link coerceOs}).
 */
function parseV1Lease(body: string): Lease {
  const parsed = JSON.parse(body) as {
    id?: unknown;
    leaseId?: unknown;
    wisp_contract_id?: unknown;
    wispContractId?: unknown;
    status?: unknown;
    os?: unknown;
    isolation?: unknown;
  };
  const leaseId =
    typeof parsed.id === "string"
      ? parsed.id
      : typeof parsed.leaseId === "string"
        ? parsed.leaseId
        : "";
  const wispContractId =
    typeof parsed.wisp_contract_id === "string"
      ? parsed.wisp_contract_id
      : typeof parsed.wispContractId === "string"
        ? parsed.wispContractId
        : "";
  return {
    leaseId,
    wispContractId,
    status: typeof parsed.status === "string" ? parsed.status : "",
    os: coerceOs(parsed.os),
    isolation: coerceIsolation(parsed.isolation),
  };
}

/**
 * A handle handed to a response consumer. `resolve`/`reject` settle the request
 * exactly once — whichever of the response, per-call timeout, abort, or
 * transport-error paths fires first wins. Settling always tears down the request
 * (and thus its response stream and socket), so a consumer can check `done`
 * before touching a half-destroyed response.
 */
interface SettleHandle<T> {
  readonly done: boolean;
  resolve(value: T): void;
  reject(err: Error): void;
}

/** A JSON request, independent of how its response body is consumed. */
interface RequestSpec {
  fullUrl: string;
  method: string;
  /** Accept header — `application/json` for buffered calls, SSE for streams. */
  accept: string;
  /** JSON body; omitted for bodyless methods such as DELETE. */
  jsonBody?: unknown;
  /**
   * Optional `Authorization` header value (e.g. `Bearer <key>`), sent only in
   * v1 mode. Assembled by the caller so this core never touches the secret
   * store; it is written to the request headers but NEVER logged.
   */
  authorization?: string;
  /** Per-call timeout in ms (applied as socket inactivity). */
  timeoutMs: number;
  /** Optional caller AbortSignal; aborting destroys the request promptly. */
  signal?: AbortSignal;
  /**
   * Additional headers merged into the request (e.g. `Idempotency-Key`, which
   * wisper REQUIRES on `POST /v1/leases`). Never carries secrets.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Typed error for a client-side timeout, with code {@link CLIENT_TIMEOUT_CODE}.
 * There is no HTTP response, so `httpStatus` is 0 and `requestId` is empty. The
 * message carries only the method/path, never the request body — so `env`
 * secrets cannot leak through a timeout rejection.
 */
function clientTimeoutError(
  method: string,
  pathname: string,
  timeoutMs: number
): WisperApiError {
  return new WisperApiError({
    code: CLIENT_TIMEOUT_CODE,
    httpStatus: 0,
    message: `wisper request to ${method} ${pathname} timed out after ${timeoutMs}ms`,
    requestId: "",
    retryable: RETRYABLE_CODES.has(CLIENT_TIMEOUT_CODE),
  });
}

/**
 * The rejection value for an aborted request: the signal's `reason` when it is
 * an Error, otherwise a generic `AbortError`. Never includes request data.
 */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error("wisper request aborted");
  err.name = "AbortError";
  return err;
}

/**
 * The single request core every client call flows through. It owns base-URL
 * parsing and transport selection, JSON body encoding, header assembly, the
 * per-call timeout, and AbortSignal wiring; the caller supplies only how to
 * consume the response (`onResponse`) and, optionally, how to classify a raw
 * transport error (`onError` — used by the stream path to map a post-headers
 * drop to `stream_closed`). Error paths never include the request body, so
 * secrets in `env` cannot leak through a rejection.
 */
function sendRequest<T>(
  spec: RequestSpec,
  onResponse: (res: http.IncomingMessage, settle: SettleHandle<T>) => void,
  onError?: (err: Error, settle: SettleHandle<T>) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(spec.fullUrl);
    const transport = url.protocol === "https:" ? https : http;
    const payload =
      spec.jsonBody === undefined
        ? undefined
        : Buffer.from(JSON.stringify(spec.jsonBody));

    const headers: Record<string, string> = { accept: spec.accept };
    if (spec.extraHeaders) {
      Object.assign(headers, spec.extraHeaders);
    }
    if (spec.authorization) {
      headers["authorization"] = spec.authorization;
    }
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }

    let done = false;
    const finalizers: Array<() => void> = [];
    const finish = (emit: () => void) => {
      if (done) return;
      done = true;
      for (const f of finalizers) f();
      req.destroy();
      emit();
    };
    const settle: SettleHandle<T> = {
      get done() {
        return done;
      },
      resolve: (value) => finish(() => resolve(value)),
      reject: (err) => finish(() => reject(err)),
    };

    const req = transport.request(
      url,
      { method: spec.method, headers, timeout: spec.timeoutMs },
      (res) => onResponse(res, settle)
    );

    req.on("timeout", () => {
      // Node emits 'timeout' without tearing down; settle.reject destroys the
      // request for us and produces the typed client-timeout error.
      settle.reject(clientTimeoutError(spec.method, url.pathname, spec.timeoutMs));
    });
    req.on("error", (err) => {
      if (done) return;
      if (onError) onError(err, settle);
      else settle.reject(err);
    });

    // AbortSignal: aborting destroys the request (and its response stream) and
    // rejects promptly with the signal's reason.
    const { signal } = spec;
    if (signal) {
      const onAbort = () => settle.reject(abortError(signal));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        finalizers.push(() => signal.removeEventListener("abort", onAbort));
      }
    }

    // A synchronously pre-aborted signal already settled and destroyed the req.
    if (!done) {
      if (payload) req.write(payload);
      req.end();
    }
  });
}

/**
 * Issue a single JSON request and buffer the full response. Resolves for ANY
 * HTTP status (status handling is the caller's job); rejects only on a client
 * timeout ({@link CLIENT_TIMEOUT_CODE}), an abort, or a transport failure.
 */
export function requestJson(
  fullUrl: string,
  method: string,
  jsonBody: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  authorization?: string,
  extraHeaders?: Record<string, string>
): Promise<RawResponse> {
  return sendRequest<RawResponse>(
    { fullUrl, method, accept: "application/json", jsonBody, authorization, timeoutMs, signal, extraHeaders },
    (res, settle) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        settle.resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
      res.on("error", (err) => settle.reject(err));
    }
  );
}

/** Join a base URL and an absolute path, tolerating a trailing slash on base. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** A parsed SSE frame: an event name and its (possibly multi-line) data payload. */
interface SseFrame {
  event: string;
  data: string;
}

/**
 * Strip an SSE field prefix (`event:` / `data:`) from a line, removing at most a
 * single leading space after the colon per the SSE spec.
 */
function stripSseField(line: string, field: string): string {
  const rest = line.slice(field.length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/**
 * Parse one raw frame (the text between two `\n\n` boundaries) into an
 * {@link SseFrame}. Multiple `data:` lines are joined with `\n` per the SSE
 * spec; comment/blank lines are ignored. Returns null for a frame with neither
 * an event nor any data (e.g. a stray keep-alive comment).
 */
function parseSseFrame(raw: string): SseFrame | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = stripSseField(line, "event:");
    } else if (line.startsWith("data:")) {
      dataLines.push(stripSseField(line, "data:"));
    }
  }
  if (event === "" && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Incremental SSE frame reassembler. Feed it arbitrary network chunks via
 * {@link SseFrameParser.push}; it buffers until whole frames (delimited by a
 * blank line, `\n\n`) are available and returns those completed by the chunk.
 * Frames split across any number of chunk boundaries are reassembled, so callers
 * see exactly the frames the server wrote, in order.
 */
class SseFrameParser {
  private buffer = "";

  push(text: string): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = parseSseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

/** Best-effort JSON parse of a frame's data payload; undefined when malformed. */
function parseFrameData(data: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the typed error for a terminal `error` frame or a mid-stream drop. The
 * `code` is the wire string verbatim (e.g. `host_offline`, `stream_closed`); it
 * feeds {@link WisperApiError.retryable} through the same {@link RETRYABLE_CODES}
 * set used for buffered responses.
 */
function toStreamError(code: string, httpStatus: number, message: string): WisperApiError {
  return new WisperApiError({
    code,
    httpStatus,
    message,
    requestId: "",
    retryable: RETRYABLE_CODES.has(code),
  });
}

/** Outcome of feeding one frame to the stream handler. */
interface FrameOutcome {
  /** True when this frame terminates the stream (exit or error). */
  terminal: boolean;
  exitCode?: number;
  error?: WisperApiError;
}

/**
 * Interpret a single parsed frame: deliver `chunk` output via `onChunk`, or
 * signal termination for `exit`/`error`. Unknown event names are ignored so a
 * future server addition never breaks an in-flight stream.
 */
function handleStreamFrame(
  frame: SseFrame,
  httpStatus: number,
  onChunk?: (chunk: StreamChunk) => void
): FrameOutcome {
  switch (frame.event) {
    case "chunk": {
      const data = parseFrameData(frame.data);
      const stream = data?.stream === "stderr" ? "stderr" : "stdout";
      const text = typeof data?.data === "string" ? data.data : "";
      if (onChunk) onChunk({ stream, data: text });
      return { terminal: false };
    }
    case "exit": {
      const data = parseFrameData(frame.data);
      const exitCode = typeof data?.exit_code === "number" ? data.exit_code : 0;
      return { terminal: true, exitCode };
    }
    case "error": {
      const data = parseFrameData(frame.data);
      const code = typeof data?.error === "string" ? data.error : "stream_error";
      return {
        terminal: true,
        error: toStreamError(code, httpStatus, `wisper stream reported error: ${code}`),
      };
    }
    default:
      return { terminal: false };
  }
}

/**
 * Open a streaming exec and drive its SSE frames to a terminal outcome. Resolves
 * with the exit code on an `exit` frame; rejects with a {@link WisperApiError} on
 * an `error` frame, a non-2xx response (using the buffered error envelope), or a
 * connection that closes before any terminal frame (code `stream_closed`). A
 * per-call timeout or a pre-response transport failure rejects with the raw error.
 */
function requestStream(
  fullUrl: string,
  jsonBody: unknown,
  timeoutMs: number,
  onChunk?: (chunk: StreamChunk) => void,
  signal?: AbortSignal,
  authorization?: string,
  mapError: (status: number, body: string) => WisperApiError = toApiError
): Promise<ExecStreamResult> {
  const parser = new SseFrameParser();
  let responseStatus = 0;

  return sendRequest<ExecStreamResult>(
    {
      fullUrl,
      method: "POST",
      accept: "text/event-stream",
      jsonBody,
      authorization,
      timeoutMs,
      signal,
    },
    (res, settle) => {
      responseStatus = res.statusCode ?? 0;

      if (responseStatus !== 200) {
        // Non-200: buffer the error envelope and map it like a JSON request.
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          settle.reject(mapError(responseStatus, Buffer.concat(chunks).toString("utf8")))
        );
        res.on("error", (err) => settle.reject(err));
        return;
      }

      // A 200 stream that ends or drops with no exit/error frame is a dropped
      // stream. A timeout or abort settles first (guarded by settle.done), so
      // this only fires for a genuine server-side close.
      const settleClosed = () =>
        settle.reject(
          toStreamError(
            "stream_closed",
            responseStatus,
            "wisper stream closed before an exit event"
          )
        );

      res.setEncoding("utf8");
      res.on("data", (text: string) => {
        if (settle.done) return;
        let frames: SseFrame[];
        try {
          frames = parser.push(text);
        } catch (err) {
          settle.reject(err as Error);
          return;
        }
        for (const frame of frames) {
          let outcome: FrameOutcome;
          try {
            outcome = handleStreamFrame(frame, responseStatus, onChunk);
          } catch (err) {
            // A throwing onChunk aborts the stream and surfaces its error.
            settle.reject(err as Error);
            return;
          }
          if (outcome.terminal) {
            if (outcome.error) settle.reject(outcome.error);
            else settle.resolve({ exitCode: outcome.exitCode ?? 0 });
            return;
          }
        }
      });

      res.on("end", settleClosed);
      res.on("aborted", settleClosed);
      res.on("error", settleClosed);
    },
    (err, settle) => {
      // A transport error after the 200 head is a dropped stream; anything
      // earlier is a raw transport failure. (Timeout and abort have already
      // settled and are guarded out by settle.done.)
      if (responseStatus === 200) {
        settle.reject(
          toStreamError(
            "stream_closed",
            responseStatus,
            "wisper stream closed before an exit event"
          )
        );
      } else {
        settle.reject(err);
      }
    }
  );
}

/**
 * Client for the wisper-api dev lease endpoints. Construct one per configured
 * host; it is stateless beyond its base URL, host id, and timeout.
 */
export class WisperClient {
  private readonly baseUrl: string;
  private readonly hostId: string;
  private readonly mode: WisperMode;
  private readonly resolveApiKey?: () => string | undefined;
  /**
   * Catalog resolver used in v1 mode to turn host/image NAMES into catalog ids
   * before leasing. Built from the client's own base URL and API key when not
   * injected; unused in dev mode.
   */
  private readonly catalog: HostImageResolver;
  /** Client-wide timeout override; when undefined each call uses its own default. */
  private readonly configuredTimeoutMs?: number;
  private readonly logger: Logger;

  constructor(options: WisperClientOptions) {
    this.baseUrl = options.baseUrl;
    this.hostId = options.hostId;
    this.mode = options.mode ?? "dev";
    this.resolveApiKey = options.resolveApiKey;
    this.configuredTimeoutMs = options.timeoutMs;
    this.logger = options.logger ?? log;
    // The catalog shares the client's base URL and call-time API-key resolution,
    // so a key rotated at runtime takes effect for catalog fetches too. Dev mode
    // never resolves against it.
    this.catalog =
      options.catalog ??
      new WisperCatalog({
        baseUrl: this.baseUrl,
        resolveApiKey: this.resolveApiKey,
        logger: this.logger,
      });
  }

  /**
   * Resolve the effective timeout for a call: an explicit per-call value wins,
   * then the client-wide override, then the operation's own default.
   */
  private resolveTimeout(perCall: number | undefined, opDefault: number): number {
    return perCall ?? this.configuredTimeoutMs ?? opDefault;
  }

  /**
   * Build the `Authorization` header value for a request. In dev mode there is
   * no auth (returns undefined). In v1 mode the API key is resolved from the
   * secret store at call time; a missing/empty key throws a terminal,
   * key-NAMING {@link WisperApiError} before any request is sent. The key value
   * is never logged and never placed in the error.
   */
  private authorization(): string | undefined {
    if (this.mode !== "v1") return undefined;
    return bearerAuthorization(this.resolveApiKey);
  }

  /**
   * Map a non-2xx response to a {@link WisperApiError}. In v1 mode auth (401/403)
   * and payment (402) statuses get terminal, purpose-built messages; every other
   * status — and all of dev mode — flows through {@link toApiError} unchanged.
   */
  private mapError(status: number, body: string): WisperApiError {
    if (this.mode === "v1") {
      if (status === 401 || status === 403) return toAuthError(status, body);
      if (status === 402) return toInsufficientFundsError(status, body);
    }
    return toApiError(status, body);
  }

  /**
   * Rent a lease: `POST {base}/dev/leases`.
   *
   * This call BLOCKS UNTIL LEASE READINESS BY DESIGN. The server does not reply
   * until the lease has been fully provisioned and is ready to accept execs
   * (a server-side await); a 201 therefore means the lease is ready — no polling
   * required. Because the client must wait out that readiness await, createLease
   * has the LONGEST default timeout of any operation
   * ({@link DEFAULT_CREATE_LEASE_TIMEOUT_MS}); the exec/release calls, which do
   * not block on provisioning, default to the shorter
   * {@link DEFAULT_EXEC_TIMEOUT_MS}.
   *
   * The request body mixes casing exactly as the API expects: `hostId` is
   * camelCase; every other field is snake_case. `env` is forwarded verbatim but
   * never logged.
   *
   * @throws {@link WisperApiError} on any non-2xx response, a client timeout, or
   *   an abort via `params.signal`.
   */
  async createLease(params: CreateLeaseParams): Promise<Lease> {
    const {
      image,
      network,
      resources,
      ttl_seconds,
      userdata,
      env,
      files,
      isolation,
      signal,
    } = params;
    const v1 = this.mode === "v1";

    // Validate the `files` array against the wisper contract BEFORE any
    // request is sent. A local violation throws a terminal validation error
    // (never retried) so an oversize or malformed entry fails the dispatch
    // just like a missing secret: the same loud, pre-lease semantics.
    if (files !== undefined) {
      validateLeaseFiles(files);
    }

    // Deliberately omit `env` and `files`: env values are secret, and file
    // contents may be sensitive (e.g. the fully rendered prompt). Only the
    // presence of each is logged, plus the file COUNT.
    this.logger.debug("wisper: creating lease", {
      mode: this.mode,
      image,
      network,
      ttl_seconds,
      isolation: isolation ?? null,
      hasEnv: env !== undefined && Object.keys(env).length > 0,
      fileCount: files?.length ?? 0,
    });

    // The effective host selector: an explicit per-playbook `host`, else the
    // client's configured host id (`WISPER_HOST_ID`).
    const hostSelector = params.host ?? this.hostId;
    // dev sends the historical body (camelCase `hostId` + `image`), with `host`
    // used verbatim as the dev host id. v1 resolves the (host selector, image
    // name) pair against the catalog to concrete ids BEFORE leasing — an unknown
    // host, an offline host, or an unoffered image throws here, so the dispatch
    // fails loudly before any lease exists. `env` is forwarded verbatim by both
    // and never logged.
    let body: Record<string, unknown>;
    if (v1) {
      // Passing `isolation` into resolve lets the catalog fail fast when the
      // chosen host does not advertise the requested level — before leasing.
      const resolved = await this.catalog.resolve(
        hostSelector,
        image,
        isolation,
        signal
      );
      // Resources are fixed by the selected offer server-side and MUST NOT be
      // sent on v1 — POST /v1/leases rejects any body carrying `resources` or a
      // top-level `gpus`. `CreateLeaseParams.resources` still parameterizes the
      // dev-mode body (kept below).
      body = {
        host_id: resolved.host_id,
        host_image_id: resolved.host_image_id,
        network,
        ttl_seconds,
        userdata,
        env,
        // Omit when unset so the server applies its own default ("shared").
        ...(isolation !== undefined ? { isolation } : {}),
        // Omit when unset so the request stays byte-for-byte identical for
        // callers that do not stage any files.
        ...(files !== undefined ? { files } : {}),
      };
    } else {
      body = {
        hostId: hostSelector,
        image,
        network,
        resources: {
          cpus: resources.cpus,
          memory_mb: resources.memory_mb,
          pids: resources.pids,
        },
        ttl_seconds,
        userdata,
        env,
        // Omit when unset so the server applies its own default ("shared").
        ...(isolation !== undefined ? { isolation } : {}),
        // Omit when unset so the dev-mode body stays byte-for-byte identical
        // for callers that do not stage any files.
        ...(files !== undefined ? { files } : {}),
      };
    }

    const res = await requestJson(
      joinUrl(this.baseUrl, v1 ? "/v1/leases" : "/dev/leases"),
      "POST",
      body,
      this.resolveTimeout(params.timeoutMs, DEFAULT_CREATE_LEASE_TIMEOUT_MS),
      signal,
      this.authorization(),
      // wisper REQUIRES an Idempotency-Key on POST /v1/leases; a fresh UUID per
      // call is correct (each create is a distinct provision — retries at the
      // dispatcher level intentionally provision anew).
      v1 ? { "idempotency-key": randomUUID() } : undefined
    );

    if (res.status !== 201) {
      throw this.mapError(res.status, res.body);
    }

    const lease = v1 ? parseV1Lease(res.body) : parseDevLease(res.body);
    this.logger.debug("wisper: lease created", {
      leaseId: lease.leaseId,
      status: lease.status,
      os: lease.os,
      isolation: lease.isolation,
    });
    return lease;
  }

  /**
   * Release a lease: `DELETE {base}/dev/leases/{leaseId}?hostId={hostId}`.
   * Success is HTTP 200 with an empty body.
   *
   * @throws {@link WisperApiError} on any non-2xx response, a client timeout, or
   *   an abort via `opts.signal`.
   */
  async releaseLease(
    leaseId: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    this.logger.debug("wisper: releasing lease", { leaseId });

    // v1 owns the lease by principal, so no `hostId` query param — ownership is
    // the bearer token. dev keeps its historical `?hostId=` selector.
    const path =
      this.mode === "v1"
        ? `/v1/leases/${encodeURIComponent(leaseId)}`
        : `/dev/leases/${encodeURIComponent(leaseId)}?hostId=${encodeURIComponent(
            this.hostId
          )}`;
    const res = await requestJson(
      joinUrl(this.baseUrl, path),
      "DELETE",
      undefined,
      this.resolveTimeout(opts.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS),
      opts.signal,
      this.authorization()
    );

    if (res.status !== 200) {
      throw this.mapError(res.status, res.body);
    }
    this.logger.debug("wisper: lease released", { leaseId });
  }

  /**
   * Download the raw bytes of a single file from a live lease:
   * `GET {base}/dev/leases/{leaseId}/files?path={path}` in dev mode, or
   * `GET {base}/v1/leases/{leaseId}/files?path={path}` in v1 mode. Success is
   * HTTP 200 with an `application/octet-stream` body; the returned {@link Buffer}
   * holds the file's bytes.
   *
   * The `path` MUST be an absolute unix-style path (starts with `/`, no `..`
   * segment, no backslash). A malformed shape is refused BEFORE any request is
   * sent, with a typed {@link WisperApiError} whose code is `validation_error`
   * (the same shape a server-side rejection would surface). Errors from the
   * server are surfaced as {@link WisperApiError}s: `not_found` (no such file,
   * or the path is a directory/symlink), `lease_not_ready` (409, the lease is
   * not active), `file_too_large` (413, the file exceeds the download cap),
   * `validation_error` (400), and the usual retryable
   * `host_offline`/`upstream_timeout` codes.
   *
   * @throws {@link WisperApiError} on any non-2xx response, a client timeout, or
   *   an abort via `opts.signal`.
   */
  async downloadLeaseFile(
    leaseId: string,
    path: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<Buffer> {
    if (typeof path !== "string" || path.length === 0) {
      throw localValidationError(
        "downloadLeaseFile: path is missing or empty"
      );
    }
    if (!path.startsWith("/")) {
      throw localValidationError(
        `downloadLeaseFile: path is not absolute unix-style (must start with "/"): ${path}`
      );
    }
    if (path.includes("\\")) {
      throw localValidationError(
        `downloadLeaseFile: path contains a backslash (unix-style paths only): ${path}`
      );
    }
    if (path.split("/").some((segment) => segment === "..")) {
      throw localValidationError(
        `downloadLeaseFile: path contains a ".." segment: ${path}`
      );
    }

    this.logger.debug("wisper: downloading lease file", { leaseId, path });

    const v1 = this.mode === "v1";
    const basePath = v1
      ? `/v1/leases/${encodeURIComponent(leaseId)}/files`
      : `/dev/leases/${encodeURIComponent(leaseId)}/files`;
    const url = `${basePath}?path=${encodeURIComponent(path)}`;
    const timeoutMs = this.resolveTimeout(opts.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);

    return sendRequest<Buffer>(
      {
        fullUrl: joinUrl(this.baseUrl, url),
        method: "GET",
        accept: "application/octet-stream",
        authorization: this.authorization(),
        timeoutMs,
        signal: opts.signal,
      },
      (res, settle) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if (status !== 200) {
            settle.reject(this.mapError(status, body.toString("utf8")));
            return;
          }
          settle.resolve(body);
        });
        res.on("error", (err) => settle.reject(err));
      }
    );
  }

  /**
   * Run a command synchronously inside a lease:
   * `POST {base}/dev/leases/{leaseId}/exec` with body `{hostId, command}`
   * (`hostId` is camelCase in the body; `leaseId` travels in the path). Success
   * is HTTP 200 with `{stdout, stderr, exit_code}` — note the snake_case
   * `exit_code`, mapped to {@link ExecResult.exitCode}.
   *
   * A non-zero exit code is NOT an error: the command ran and reported failure,
   * so it is returned like any other result and the caller decides its meaning.
   * Only a non-2xx response raises a {@link WisperApiError}, using the same error
   * envelope as {@link createLease}.
   *
   * @throws {@link WisperApiError} on any non-2xx response.
   */
  async execSync(
    leaseId: string,
    command: string,
    opts: ExecSyncOptions = {}
  ): Promise<ExecResult> {
    this.logger.debug("wisper: exec", { leaseId });

    const v1 = this.mode === "v1";
    // v1 identifies the lease by path + principal only; dev also carries the
    // camelCase `hostId` in the body.
    const path = v1
      ? `/v1/leases/${encodeURIComponent(leaseId)}/exec`
      : `/dev/leases/${encodeURIComponent(leaseId)}/exec`;
    const res = await requestJson(
      joinUrl(this.baseUrl, path),
      "POST",
      v1 ? { command } : { hostId: this.hostId, command },
      this.resolveTimeout(opts.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS),
      opts.signal,
      this.authorization()
    );

    if (res.status !== 200) {
      throw this.mapError(res.status, res.body);
    }

    const parsed = JSON.parse(res.body) as {
      stdout?: unknown;
      stderr?: unknown;
      exit_code?: unknown;
    };
    const result: ExecResult = {
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      exitCode: typeof parsed.exit_code === "number" ? parsed.exit_code : 0,
    };
    this.logger.debug("wisper: exec complete", {
      leaseId,
      exitCode: result.exitCode,
    });
    return result;
  }

  /**
   * Run a command inside a lease and stream its output:
   * `POST {base}/dev/leases/{leaseId}/exec?stream=1` with body `{hostId, command}`
   * and `Accept: text/event-stream`. Output arrives as LF-framed SSE `chunk`
   * events, delivered in order to {@link ExecStreamOptions.onChunk}; the stream
   * ends with either an `exit` event (resolve with its exit code) or an `error`
   * event (reject with a typed {@link WisperApiError}).
   *
   * As with {@link execSync}, a non-zero exit code is NOT an error. A non-2xx
   * response raises a {@link WisperApiError} from the buffered error envelope, and
   * a connection that closes before any terminal frame rejects with a
   * {@link WisperApiError} whose `code` is `stream_closed`.
   *
   * A client timeout ({@link ExecStreamOptions.timeoutMs}) or an abort via
   * {@link ExecStreamOptions.signal} destroys the response stream and rejects
   * promptly — the former with a typed `upstream_timeout_client` error.
   *
   * @throws {@link WisperApiError} on a non-2xx response, an `error` frame, a
   *   dropped stream, or a client timeout; the abort reason on an abort.
   */
  async execStream(
    leaseId: string,
    command: string,
    opts: ExecStreamOptions = {}
  ): Promise<ExecStreamResult> {
    this.logger.debug("wisper: exec stream", { leaseId });

    const v1 = this.mode === "v1";
    const path = v1
      ? `/v1/leases/${encodeURIComponent(leaseId)}/exec?stream=1`
      : `/dev/leases/${encodeURIComponent(leaseId)}/exec?stream=1`;
    const result = await requestStream(
      joinUrl(this.baseUrl, path),
      v1 ? { command } : { hostId: this.hostId, command },
      this.resolveTimeout(opts.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS),
      opts.onChunk,
      opts.signal,
      this.authorization(),
      (status, body) => this.mapError(status, body)
    );

    this.logger.debug("wisper: exec stream complete", {
      leaseId,
      exitCode: result.exitCode,
    });
    return result;
  }
}

/**
 * Build a {@link WisperClient} from the process config. Leasing requires
 * `WISPER_HOST_ID`; without it this throws {@link ConfigError} rather than
 * issuing a request that could never target a host.
 */
export function wisperClientFromConfig(cfg: Config = getConfig()): WisperClient {
  if (!cfg.isWisperConfigured() || cfg.wisperHostId === undefined) {
    throw new ConfigError(
      "WISPER_HOST_ID is not configured; cannot rent or release leases."
    );
  }
  return new WisperClient({
    baseUrl: cfg.wisperBaseUrl,
    hostId: cfg.wisperHostId,
    mode: cfg.wisperMode,
    // v1 mode resolves the API key from the secret store on every call — like
    // modules resolve their PATs server-side — so a key rotated at runtime takes
    // effect without a restart, and the value never touches process.env or a log.
    resolveApiKey: () => getSecret(WISPER_API_KEY_SECRET_NAME),
    // The client-wide timeout is the create-lease ceiling: createLease is the
    // only call left to the client's own default here, and it is the operation
    // that blocks on provisioning. Exec and release calls always pass their own
    // (WISPER_EXEC_TIMEOUT_MS) per-call timeout from the executor, so this
    // override never governs them.
    timeoutMs: cfg.wisperCreateLeaseTimeoutMs,
  });
}

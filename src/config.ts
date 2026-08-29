import os from "os";
import path from "path";

/**
 * Typed, validated configuration derived from the process environment.
 *
 * The orchestrator is a single-user desktop app; configuration is intentionally
 * small and read once at boot. Malformed values fail fast with a clear message
 * so a mistyped `PORT` never turns into a confusing runtime error. The wisper
 * host id is validated lazily — it is only required when a lease is actually
 * rented, so an unset `WISPER_HOST_ID` must NOT crash boot.
 */
export interface Config {
  /** API port; loopback only. Defaults to 3007. */
  port: number;
  /** SQLite database path override; undefined means use the OS default. */
  dbPath?: string;
  /** Base URL of the local wisper-api. Defaults to http://localhost:8080. */
  wisperBaseUrl: string;
  /**
   * Which wisper surface the client speaks to. `dev` (default) uses the
   * unauthenticated `/dev/leases` harness — the historical behavior. `v1` speaks
   * the authenticated consumer surface (`/v1/leases`), resolving the
   * `WISPER_API_KEY` secret at call time and sending it as a bearer token.
   */
  wisperMode: "dev" | "v1";
  /**
   * The DEFAULT host selector, used when a playbook sets no `host`. In `dev` mode
   * it is the hostId targeted on the `/dev/leases` endpoints; in `v1` mode it is
   * the default catalog host id OR name resolved against `GET /v1/catalog` at
   * dispatch time. Undefined when unset.
   */
  wisperHostId?: string;
  /**
   * Timeout in ms for the blocking create-lease call. Defaults to 150000. The
   * create-lease request blocks server-side until the lease is provisioned
   * (clone/build/host can take minutes for heavy images), so operators can raise
   * this ceiling via WISPER_CREATE_LEASE_TIMEOUT_MS without recompiling.
   */
  wisperCreateLeaseTimeoutMs: number;
  /**
   * Explicit operator override for the exec/release timeout (ms) and the
   * inter-chunk idle window for streaming execs (NOT a wall-clock cap on total
   * run time). When UNSET the executor derives a per-call default at dispatch
   * time from the lease's REMAINING TTL plus a small margin, capped at the
   * cap constant in the executor (about 6 hours), so a long-running step or
   * agent command is not killed by a fixed client timeout. Set
   * WISPER_EXEC_TIMEOUT_MS to override that computed default with a fixed
   * value across every exec.
   *
   * Precedence (widest wins first is the ONLY exception, otherwise most-
   * specific wins): a per-call `timeoutMs` on the wisper client > this
   * WISPER_EXEC_TIMEOUT_MS operator override > the executor's computed
   * `remaining_ttl + margin` (capped) default.
   */
  wisperExecTimeoutMs?: number;
  /**
   * Per-call timeout in ms for wisper lease-release requests. Release is a
   * quick control-plane DELETE and MUST NOT share the exec timeout's
   * multi-hour default: a hung socket would otherwise block boot's orphan
   * reconcile (which runs sequentially before the dispatcher starts) or the
   * whole release sweep for hours. Defaults to 60000 (60 s), overridable
   * via WISPER_RELEASE_TIMEOUT_MS.
   */
  wisperReleaseTimeoutMs: number;
  /** True once a wisper host id is configured; false leaves leasing disabled. */
  isWisperConfigured(): boolean;
}

/**
 * Default create-lease timeout in ms when WISPER_CREATE_LEASE_TIMEOUT_MS is
 * unset. Mirrors DEFAULT_CREATE_LEASE_TIMEOUT_MS in wisper/client.ts (kept as a
 * literal here to avoid a config↔client import cycle).
 */
const DEFAULT_CREATE_LEASE_TIMEOUT_MS = 150_000;

/**
 * Default lease-release timeout in ms when WISPER_RELEASE_TIMEOUT_MS is unset.
 * Mirrors DEFAULT_RELEASE_TIMEOUT_MS in executor/executor.ts (kept as a
 * literal here to avoid a config -> executor import cycle).
 */
const DEFAULT_RELEASE_TIMEOUT_MS = 60_000;

/** Thrown when an environment value is present but malformed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * The single directory orchestrator keeps its private state under: the SQLite
 * database file, the per-dispatch log directory, and the encrypted secret
 * store all resolve against it, so a launcher that sets ORCH_DATA_DIR keeps
 * every piece of state in one folder.
 *
 * Precedence: an explicit ORCH_DATA_DIR wins verbatim (used as-is, no
 * "orchestrator" suffix is appended); otherwise the OS user-data base is used
 * with an "orchestrator" subdirectory (%APPDATA%\orchestrator on Windows,
 * ~/Library/Application Support/orchestrator on macOS, $XDG_DATA_HOME (or
 * ~/.local/share)/orchestrator elsewhere). ORCH_DB_PATH still overrides just
 * the DB file path.
 */
export function userDataDir(): string {
  const override = process.env.ORCH_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  const home = os.homedir();
  let base: string;
  switch (process.platform) {
    case "win32":
      base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      break;
    case "darwin":
      base = path.join(home, "Library", "Application Support");
      break;
    default:
      base = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
      break;
  }
  return path.join(base, "orchestrator");
}

/** Parse an integer port in the valid TCP range, or throw ConfigError. */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 3007;
  }
  const value = raw.trim();
  // Reject anything that is not a plain base-10 integer (parseInt would happily
  // accept "80abc" → 80, which hides typos).
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(
      `Invalid PORT "${raw}": must be an integer between 1 and 65535.`
    );
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new ConfigError(
      `Invalid PORT "${raw}": must be an integer between 1 and 65535.`
    );
  }
  return port;
}

/**
 * Parse a positive-integer millisecond timeout. Unlike {@link parsePort}, an
 * unset OR malformed value falls back to `fallback` rather than throwing: these
 * are optional operator convenience knobs, so a typo must never block boot — it
 * simply reverts to the compiled-in default. The base-10 check mirrors
 * {@link parsePort} so a value like "60s" or "-1" is rejected as invalid.
 */
function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return fallback;
  }
  const ms = Number(value);
  return ms > 0 ? ms : fallback;
}

/**
 * Parse an OPTIONAL positive-integer millisecond timeout: an unset OR malformed
 * value returns `undefined`, and callers treat that as "no explicit override"
 * (the executor then derives its own default from the lease's remaining TTL).
 * A typo must never block boot, so validation is lenient like {@link parseTimeoutMs}.
 */
function parseOptionalTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const ms = Number(value);
  return ms > 0 ? ms : undefined;
}

/**
 * Parse the wisper client mode. Unset (or empty) defaults to `dev` — the
 * historical unauthenticated behavior. Any value other than `dev`/`v1` is a
 * misconfiguration and fails fast (like {@link parsePort}) rather than silently
 * picking a surface the operator did not intend.
 */
function parseWisperMode(raw: string | undefined): "dev" | "v1" {
  if (raw === undefined || raw.trim() === "") {
    return "dev";
  }
  const value = raw.trim();
  if (value !== "dev" && value !== "v1") {
    throw new ConfigError(
      `Invalid WISPER_MODE "${raw}": must be "dev" or "v1".`
    );
  }
  return value;
}

/** Loopback hosts for which plaintext http:// stays allowed. */
function isLoopbackHost(hostname: string): boolean {
  // URL.hostname keeps the brackets on IPv6 literals (e.g. "[::1]"); strip them.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Is the insecure-http escape hatch explicitly enabled? */
function allowInsecureHttp(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Validate that a base URL parses and uses http(s), or throw ConfigError.
 *
 * SECURITY: a plaintext `http://` base URL pointing at a non-loopback host is
 * REFUSED by default — the wck_ API key and every injected secret (Anthropic
 * OAuth token, git token) would otherwise travel unencrypted over the network.
 * The `WISPER_ALLOW_INSECURE_HTTP` escape hatch (`1`/`true`) downgrades the
 * refusal to a loud warning for users terminating TLS themselves.
 */
function parseBaseUrl(
  raw: string | undefined,
  allowInsecure: boolean
): string {
  if (raw === undefined || raw.trim() === "") {
    return "http://localhost:8080";
  }
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `Invalid WISPER_BASE_URL "${raw}": must be a valid http(s) URL.`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `Invalid WISPER_BASE_URL "${raw}": must be a valid http(s) URL.`
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    const message =
      `Refusing WISPER_BASE_URL "${raw}": a non-loopback Wisper endpoint must ` +
      `use https:// so the wck_ API key and injected secrets (Anthropic OAuth ` +
      `token, git token) are encrypted in transit. Use https://, or point at a ` +
      `loopback host (localhost, 127.0.0.1, ::1) for local dev. If you are ` +
      `terminating TLS yourself, set WISPER_ALLOW_INSECURE_HTTP=1 to override.`;
    if (allowInsecure) {
      console.warn(`WARNING: ${message}`);
    } else {
      throw new ConfigError(message);
    }
  }
  return value;
}

/**
 * Build the typed config from an environment map (defaults to `process.env`).
 * Throws {@link ConfigError} with a clear message on any malformed value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = parsePort(env.PORT);
  const wisperBaseUrl = parseBaseUrl(
    env.WISPER_BASE_URL,
    allowInsecureHttp(env.WISPER_ALLOW_INSECURE_HTTP)
  );
  const wisperMode = parseWisperMode(env.WISPER_MODE);

  const dbPathRaw = env.ORCH_DB_PATH?.trim();
  const dbPath = dbPathRaw ? dbPathRaw : undefined;

  const hostIdRaw = env.WISPER_HOST_ID?.trim();
  const wisperHostId = hostIdRaw ? hostIdRaw : undefined;

  const wisperCreateLeaseTimeoutMs = parseTimeoutMs(
    env.WISPER_CREATE_LEASE_TIMEOUT_MS,
    DEFAULT_CREATE_LEASE_TIMEOUT_MS
  );
  const wisperExecTimeoutMs = parseOptionalTimeoutMs(env.WISPER_EXEC_TIMEOUT_MS);
  const wisperReleaseTimeoutMs = parseTimeoutMs(
    env.WISPER_RELEASE_TIMEOUT_MS,
    DEFAULT_RELEASE_TIMEOUT_MS
  );

  return {
    port,
    dbPath,
    wisperBaseUrl,
    wisperMode,
    wisperHostId,
    wisperCreateLeaseTimeoutMs,
    wisperExecTimeoutMs,
    wisperReleaseTimeoutMs,
    isWisperConfigured() {
      return this.wisperHostId !== undefined;
    },
  };
}

let cached: Config | undefined;

/**
 * The process-wide config singleton, parsed lazily on first use so importing
 * this module never touches `process.env` at load time.
 */
export function getConfig(): Config {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

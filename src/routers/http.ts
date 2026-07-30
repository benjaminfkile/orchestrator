import type { Request, RequestHandler, Response } from "express";

/**
 * An error carrying an HTTP status code. Thrown by route handlers and their
 * validators; {@link handler} converts it into the uniform `{error}` JSON body
 * with the given status. Any other thrown error escapes to the app-level error
 * middleware and becomes a 500.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Wrap an async route handler so that a thrown {@link HttpError} is rendered as
 * a `{error}` JSON response with its status, and any other rejection is passed
 * to the next (error) middleware. Route handlers may therefore express failure
 * by throwing rather than plumbing responses through.
 */
export function handler(
  fn: (req: Request, res: Response) => Promise<unknown> | unknown
): RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

/** True for a non-null, non-array object value. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a route parameter that must be a positive integer id (`/^\d+$/`),
 * throwing a 400 {@link HttpError} otherwise.
 */
export function parseIdParam(raw: string, field = "id"): number {
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  return n;
}

/**
 * Parse an optional query-string integer in `[min, max]`, returning `undefined`
 * when absent and throwing a 400 {@link HttpError} when present but malformed.
 * Express types a repeated query key as an array; only a single scalar string
 * is accepted here.
 */
export function parseIntQuery(
  raw: unknown,
  field: string,
  min: number,
  max: number
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new HttpError(400, `${field} must be an integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  }
  return n;
}

/**
 * Parse an optional free-text search query param (`?q=`). Returns `undefined`
 * when absent, the string when present. Express types a repeated query key as an
 * array; only a single scalar string is accepted (else 400). Trimming and the
 * empty-string-means-no-filter rule live in the search helper, so an empty or
 * whitespace value is passed through untouched.
 */
export function parseSearchQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new HttpError(400, "q must be a string");
  }
  return raw;
}

/** Require `value` to be the request body as a plain JSON object, else 400. */
export function requireBody(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return value;
}

/** Require a non-empty string field, throwing 400 with the field name otherwise. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return value;
}

/** Validate an optional string field (may be absent), else 400. */
export function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string`);
  }
}

/** Validate an optional boolean field (may be absent), else 400. */
export function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new HttpError(400, `${field} must be a boolean`);
  }
}

/**
 * Validate an optional array of strings (may be absent). When `nullable` is set,
 * an explicit `null` is also accepted. Throws 400 otherwise.
 */
export function optionalStringArray(
  value: unknown,
  field: string,
  nullable = false
): void {
  if (value === undefined) return;
  if (value === null) {
    if (nullable) return;
    throw new HttpError(400, `${field} must be an array of strings`);
  }
  if (!Array.isArray(value) || value.some((el) => typeof el !== "string")) {
    throw new HttpError(400, `${field} must be an array of strings`);
  }
}

/**
 * Require an integer field in `[min, max]`. Throws 400 (with the field name)
 * when absent, non-integer, or out of range.
 */
export function requireInt(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HttpError(400, `${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Reject any key on `obj` that is not in `allowed`, throwing 400. Used to keep
 * request bodies tight against the DB shape rather than silently ignoring typos.
 */
export function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new HttpError(400, `unknown ${where} field: ${key}`);
    }
  }
}

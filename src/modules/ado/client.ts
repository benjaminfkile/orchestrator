/**
 * Azure DevOps REST client — READ-ONLY BY CONSTRUCTION.
 *
 * This client offers exactly four read operations against the Azure DevOps
 * REST API (v7.0):
 *
 *   - {@link ADOClient.runWiql}         — run a WIQL query, return work-item ids.
 *   - {@link ADOClient.getWorkItems}    — batch-fetch work items by id.
 *   - {@link ADOClient.getWorkItemComments} — read one item's comment thread.
 *   - {@link ADOClient.resolveMeIdentity} — resolve the authenticated identity.
 *   - {@link ADOClient.listPullRequests} — list active pull requests.
 *   - {@link ADOClient.getRepository}   — resolve one git repository's clone URL.
 *
 * There is NO method here that PATCHes or POSTs work-item state, and no code path
 * that could mutate the external system. The one POST it issues (`_apis/wit/wiql`)
 * is a read query: it submits a WIQL string and receives matching ids back. Per
 * the ARCHITECTURE PRINCIPLE and the READ-ONLY convention (see CLAUDE.md),
 * external-service integrations are read-only by construction; all output is
 * consumed locally.
 *
 * SECURITY: authentication is a Personal Access Token (PAT) sent as HTTP Basic
 * auth (base64 of `":" + pat`). The `pat`, `org`, and `project` are supplied by
 * the caller from module config / the secret store — this module NEVER reads
 * `process.env` directly. The PAT is never written to a log line or embedded in
 * a thrown error.
 */

/** Azure DevOps REST API version pinned by this client. */
export const ADO_API_VERSION = "7.0";

/**
 * API version for the work-item comments endpoint, which Azure DevOps still
 * gates behind a `-preview` flag at v7.0.
 */
export const ADO_COMMENTS_API_VERSION = "7.0-preview";

/** Default base URL for the Azure DevOps REST API host. */
export const ADO_DEFAULT_BASE_URL = "https://dev.azure.com";

/**
 * The maximum number of work-item ids the `workitems` batch endpoint accepts in
 * a single request. {@link ADOClient.getWorkItems} splits larger id lists into
 * batches of this size and concatenates the results in order.
 */
export const ADO_WORKITEM_BATCH_SIZE = 200;

/**
 * An Azure DevOps identity reference, as embedded in identity-typed fields
 * (e.g. `System.AssignedTo`) when a work item is expanded. All fields are
 * optional because the API omits them for unassigned items.
 */
export interface ADOIdentityRef {
  displayName?: string;
  uniqueName?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * The subset of work-item fields this client names explicitly. The index
 * signature preserves every other field returned by `$expand=all` so callers
 * that need more can read it without a type cast — but the domain meaning of any
 * value lives in the data, never in a code branch here.
 */
export interface ADOWorkItemFields {
  "System.Title"?: string;
  "System.State"?: string;
  "System.WorkItemType"?: string;
  "System.AssignedTo"?: ADOIdentityRef | string;
  "System.AreaPath"?: string;
  "System.IterationPath"?: string;
  "System.Tags"?: string;
  "System.ChangedDate"?: string;
  [field: string]: unknown;
}

/**
 * A single link on a work item, as returned under `relations` by `$expand=all`.
 * `rel` is the link type key (e.g. `System.LinkTypes.Hierarchy-Reverse`,
 * `System.LinkTypes.Hierarchy-Forward`, `System.LinkTypes.Related`, or
 * `AttachedFile`); `url` points at the linked work item or attachment resource;
 * `attributes` carries per-link metadata (an attachment's `name`/`resourceSize`,
 * a link's display `name`, …). The domain meaning of any `rel` value lives in the
 * data — callers match link-type strings, never branch on what a link *means*.
 */
export interface ADOWorkItemRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

/** A single work item as returned by the `workitems` endpoint. */
export interface ADOWorkItem {
  id: number;
  fields: ADOWorkItemFields;
  /** The API URL of the work item (from the response, not synthesized). */
  url: string;
  /**
   * The item's links (parents, children, related items, attachments), present
   * only under `$expand=all`. Absent/empty when the item has no links.
   */
  relations?: ADOWorkItemRelation[];
}

/**
 * A single work-item comment as returned by the `comments` endpoint. `text` is
 * the raw comment body (HTML, as ADO stores it); `createdBy` is an identity ref
 * (or bare string) and `createdDate` an ISO-8601 timestamp. All are optional on
 * the wire, so missing values normalize to "".
 */
export interface ADOComment {
  id: number;
  text: string;
  createdBy: ADOIdentityRef | string;
  createdDate: string;
}

/**
 * The authenticated identity resolved from `connectionData`, used to support
 * `@Me` expansion in WIQL. Fields are optional to mirror the API surface.
 */
export interface ADOAuthenticatedIdentity {
  uniqueName?: string;
  displayName?: string;
}

/**
 * A git repository reference, as embedded in a pull request's `repository` field
 * and returned by the repositories endpoint. `remoteUrl` is the HTTPS clone URL —
 * the value a playbook needs to clone the repo. All fields are optional because
 * the pull-requests list may omit some; the index signature preserves the rest.
 */
export interface ADORepositoryRef {
  id?: string;
  name?: string;
  /** The HTTPS clone URL for the repo (what a playbook clones). */
  remoteUrl?: string;
  /** The browser URL for the repo. */
  webUrl?: string;
  /** The API URL of the repository resource. */
  url?: string;
  [key: string]: unknown;
}

/**
 * A single pull request as returned by the `git/pullrequests` endpoint. Only the
 * fields this module reads are named; the domain meaning of any value lives in
 * the data, never in a code branch here. `sourceRefName`/`targetRefName` are the
 * full ref names (`refs/heads/...`); callers normalize them to branch names.
 */
export interface ADOPullRequest {
  pullRequestId: number;
  title: string;
  status: string;
  sourceRefName: string;
  targetRefName: string;
  createdBy: ADOIdentityRef | string;
  repository: ADORepositoryRef;
  /** The API URL of the pull request (from the response, not synthesized). */
  url: string;
}

/** Fields carried by an {@link ADOApiError}. */
export interface ADOApiErrorFields {
  /** HTTP status of the failing response. */
  httpStatus: number;
  /** Human-readable message from the ADO error envelope, or a status default. */
  message: string;
  /** Machine-readable `typeKey` from the envelope when present, else "". */
  typeKey: string;
}

/**
 * A typed error raised for any non-2xx Azure DevOps response. The `message` and
 * `typeKey` come from the ADO error envelope when present. The request body is
 * never included, so the PAT cannot leak through a rejection.
 */
export class ADOApiError extends Error implements ADOApiErrorFields {
  readonly httpStatus: number;
  readonly typeKey: string;

  constructor(fields: ADOApiErrorFields) {
    super(fields.message);
    this.name = "ADOApiError";
    this.httpStatus = fields.httpStatus;
    this.typeKey = fields.typeKey;
  }
}

/** The `fetch` surface this client depends on; injectable for tests. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Construction options for {@link ADOClient}. */
export interface ADOClientOptions {
  /** Azure DevOps organization; supplied by the caller from module config. */
  org: string;
  /** Azure DevOps project; supplied by the caller from module config. */
  project: string;
  /**
   * Personal Access Token, supplied by the caller from the secret store. NEVER
   * read from `process.env` here and never logged or echoed into an error.
   */
  pat: string;
  /**
   * Base URL of the Azure DevOps REST host. Defaults to
   * {@link ADO_DEFAULT_BASE_URL}; overridable so tests can target a mock server.
   */
  baseUrl?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Per-call options common to every read operation. */
export interface ADORequestOptions {
  /** Optional caller {@link AbortSignal}; aborting rejects the returned promise. */
  signal?: AbortSignal;
}

/** Percent-encode a single path segment (org/project may contain spaces). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** Parse a non-2xx ADO response body into a typed {@link ADOApiError}. */
function toAdoError(status: number, body: string): ADOApiError {
  let message = "";
  let typeKey = "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown; typeKey?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
    if (typeof parsed.typeKey === "string") typeKey = parsed.typeKey;
  } catch {
    // Non-JSON error body (e.g. an HTML sign-in page for a bad PAT): fall through
    // to a status-derived default. The raw body is intentionally not surfaced.
  }
  if (!message) message = `Azure DevOps request failed with HTTP ${status}`;
  return new ADOApiError({ httpStatus: status, message, typeKey });
}

/** Split `items` into contiguous chunks of at most `size` (which must be > 0). */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Build the HTTP Basic authorization header from a PAT: base64 of `":" + pat`
 * with an empty username, exactly as Azure DevOps expects. Shared by
 * {@link ADOClient} and the discovery reads so every request authenticates the
 * same way. The PAT travels only in this header, never in a URL, body, or log.
 */
export function buildAuthHeader(pat: string): string {
  const token = Buffer.from(`:${pat}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

/**
 * Issue one JSON request against Azure DevOps and parse its body. Resolves the
 * parsed JSON on a 2xx; throws {@link ADOApiError} on any non-2xx. The PAT is
 * carried only in the authorization header (via {@link buildAuthHeader}) and
 * never appears in a thrown error. Shared by {@link ADOClient} and the
 * discovery reads so they share auth, error typing, and PAT hygiene.
 */
export async function requestJson<T>(
  fetchImpl: FetchLike,
  pat: string,
  url: string,
  method: "GET" | "POST",
  jsonBody: unknown,
  signal?: AbortSignal
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: buildAuthHeader(pat),
    accept: "application/json",
  };
  let body: string | undefined;
  if (jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(jsonBody);
  }

  const res = await fetchImpl(url, { method, headers, body, signal });
  const text = await res.text();
  if (!res.ok) {
    throw toAdoError(res.status, text);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * READ-ONLY Azure DevOps REST client. Construct one per configured
 * org/project/PAT triple; it is stateless beyond those and its base URL.
 */
export class ADOClient {
  private readonly org: string;
  private readonly project: string;
  private readonly pat: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ADOClientOptions) {
    this.org = options.org;
    this.project = options.project;
    this.pat = options.pat;
    this.baseUrl = (options.baseUrl ?? ADO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    // The global fetch is used unless a test injects its own.
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * Build the HTTP Basic authorization header from the PAT. Delegates to the
   * shared {@link buildAuthHeader} so the client and discovery reads authenticate
   * identically.
   */
  private authHeader(): string {
    return buildAuthHeader(this.pat);
  }

  /**
   * Issue one JSON request and parse its body. Delegates to the shared
   * {@link requestJson} helper: resolves the parsed JSON on a 2xx, throws
   * {@link ADOApiError} on any non-2xx, and keeps the PAT out of the request URL,
   * body, and any thrown error.
   */
  private async requestJson<T>(
    url: string,
    method: "GET" | "POST",
    jsonBody: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    return requestJson<T>(this.fetchImpl, this.pat, url, method, jsonBody, signal);
  }

  /**
   * Run a WIQL query and return the matching work-item ids.
   * `POST {base}/{org}/{project}/_apis/wit/wiql?api-version=7.0` with body
   * `{ query }`. The response's `workItems[].id` array is returned in order; an
   * absent/empty result yields `[]`.
   *
   * This is a read query — it submits WIQL and receives ids; it never mutates a
   * work item.
   */
  async runWiql(query: string, opts: ADORequestOptions = {}): Promise<number[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(this.org)}/${encodeSegment(this.project)}` +
      `/_apis/wit/wiql?api-version=${ADO_API_VERSION}`;
    const result = await this.requestJson<{
      workItems?: Array<{ id?: unknown }>;
    }>(url, "POST", { query }, opts.signal);

    const items = Array.isArray(result.workItems) ? result.workItems : [];
    return items
      .map((item) => item?.id)
      .filter((id): id is number => typeof id === "number");
  }

  /**
   * Batch-fetch work items by id.
   * `GET {base}/{org}/{project}/_apis/wit/workitems?ids=...&$expand=all&api-version=7.0`.
   *
   * The `ids` list is split into batches of at most
   * {@link ADO_WORKITEM_BATCH_SIZE}; each batch is one GET and the results are
   * concatenated in request order. An empty `ids` list issues no request and
   * returns `[]`.
   */
  async getWorkItems(
    ids: number[],
    opts: ADORequestOptions = {}
  ): Promise<ADOWorkItem[]> {
    if (ids.length === 0) return [];

    const out: ADOWorkItem[] = [];
    for (const batch of chunk(ids, ADO_WORKITEM_BATCH_SIZE)) {
      const url =
        `${this.baseUrl}/${encodeSegment(this.org)}/${encodeSegment(this.project)}` +
        `/_apis/wit/workitems?ids=${batch.join(",")}&$expand=all` +
        `&api-version=${ADO_API_VERSION}`;
      const result = await this.requestJson<{ value?: unknown[] }>(
        url,
        "GET",
        undefined,
        opts.signal
      );
      const value = Array.isArray(result.value) ? result.value : [];
      for (const raw of value) {
        out.push(normalizeWorkItem(raw));
      }
    }
    return out;
  }

  /**
   * Read one work item's comment thread.
   * `GET {base}/{org}/{project}/_apis/wit/workItems/{id}/comments?api-version=7.0-preview`.
   *
   * Returns every comment the endpoint reports, normalized and in the API's own
   * order; callers decide how many to keep and how to order them. A response
   * with no `comments` array yields `[]`. This is a read — it never posts a
   * comment or mutates the item.
   */
  async getWorkItemComments(
    id: number,
    opts: ADORequestOptions = {}
  ): Promise<ADOComment[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(this.org)}/${encodeSegment(this.project)}` +
      `/_apis/wit/workItems/${id}/comments` +
      `?api-version=${ADO_COMMENTS_API_VERSION}`;
    const result = await this.requestJson<{ comments?: unknown[] }>(
      url,
      "GET",
      undefined,
      opts.signal
    );
    const value = Array.isArray(result.comments) ? result.comments : [];
    return value.map(normalizeComment);
  }

  /**
   * Resolve the authenticated identity behind the PAT, for `@Me` support in WIQL.
   * `GET {base}/{org}/_apis/connectionData` → `authenticatedUser`
   * (`uniqueName` / `displayName`). Note this endpoint is org-scoped, not
   * project-scoped.
   */
  async resolveMeIdentity(
    opts: ADORequestOptions = {}
  ): Promise<ADOAuthenticatedIdentity> {
    const url = `${this.baseUrl}/${encodeSegment(this.org)}/_apis/connectionData`;
    const result = await this.requestJson<{
      authenticatedUser?: { uniqueName?: unknown; displayName?: unknown };
    }>(url, "GET", undefined, opts.signal);

    const user = result.authenticatedUser ?? {};
    return {
      uniqueName: typeof user.uniqueName === "string" ? user.uniqueName : undefined,
      displayName:
        typeof user.displayName === "string" ? user.displayName : undefined,
    };
  }

  /**
   * List active pull requests for the configured project.
   * `GET {base}/{org}/{project}/_apis/git/pullrequests?searchCriteria.status=active&api-version=7.0`.
   *
   * Returns every PR the endpoint reports, normalized and in the API's own order;
   * callers filter (e.g. to watched creators) and diff. A response with no `value`
   * array yields `[]`. This is a read — it never opens, updates, or votes on a PR.
   */
  async listPullRequests(
    opts: ADORequestOptions = {}
  ): Promise<ADOPullRequest[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(this.org)}/${encodeSegment(this.project)}` +
      `/_apis/git/pullrequests?searchCriteria.status=active` +
      `&api-version=${ADO_API_VERSION}`;
    const result = await this.requestJson<{ value?: unknown[] }>(
      url,
      "GET",
      undefined,
      opts.signal
    );
    const value = Array.isArray(result.value) ? result.value : [];
    return value.map(normalizePullRequest);
  }

  /**
   * Resolve one git repository by id, for its HTTPS clone URL.
   * `GET {base}/{org}/{project}/_apis/git/repositories/{id}?api-version=7.0`.
   *
   * Used to fill in a pull request's `remoteUrl` when the list endpoint's
   * embedded repository object omits it. This is a read — it never mutates the
   * repository.
   */
  async getRepository(
    repositoryId: string,
    opts: ADORequestOptions = {}
  ): Promise<ADORepositoryRef> {
    const url =
      `${this.baseUrl}/${encodeSegment(this.org)}/${encodeSegment(this.project)}` +
      `/_apis/git/repositories/${encodeSegment(repositoryId)}` +
      `?api-version=${ADO_API_VERSION}`;
    const result = await this.requestJson<unknown>(
      url,
      "GET",
      undefined,
      opts.signal
    );
    return normalizeRepository(result);
  }
}

/** Coerce a raw work-item object from the API into a typed {@link ADOWorkItem}. */
function normalizeWorkItem(raw: unknown): ADOWorkItem {
  const obj = (raw ?? {}) as {
    id?: unknown;
    fields?: unknown;
    url?: unknown;
    relations?: unknown;
  };
  return {
    id: typeof obj.id === "number" ? obj.id : 0,
    fields:
      obj.fields && typeof obj.fields === "object"
        ? (obj.fields as ADOWorkItemFields)
        : {},
    url: typeof obj.url === "string" ? obj.url : "",
    relations: normalizeRelations(obj.relations),
  };
}

/** Coerce a raw `relations` array into typed {@link ADOWorkItemRelation}s. */
function normalizeRelations(raw: unknown): ADOWorkItemRelation[] {
  if (!Array.isArray(raw)) return [];
  const out: ADOWorkItemRelation[] = [];
  for (const entry of raw) {
    const rel = (entry ?? {}) as {
      rel?: unknown;
      url?: unknown;
      attributes?: unknown;
    };
    if (typeof rel.rel !== "string" || typeof rel.url !== "string") continue;
    out.push({
      rel: rel.rel,
      url: rel.url,
      attributes:
        rel.attributes && typeof rel.attributes === "object"
          ? (rel.attributes as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

/** Coerce a raw comment object from the API into a typed {@link ADOComment}. */
function normalizeComment(raw: unknown): ADOComment {
  const obj = (raw ?? {}) as {
    id?: unknown;
    text?: unknown;
    createdBy?: unknown;
    createdDate?: unknown;
  };
  let createdBy: ADOIdentityRef | string = "";
  if (typeof obj.createdBy === "string") {
    createdBy = obj.createdBy;
  } else if (obj.createdBy && typeof obj.createdBy === "object") {
    createdBy = obj.createdBy as ADOIdentityRef;
  }
  return {
    id: typeof obj.id === "number" ? obj.id : 0,
    text: typeof obj.text === "string" ? obj.text : "",
    createdBy,
    createdDate: typeof obj.createdDate === "string" ? obj.createdDate : "",
  };
}

/** Coerce a raw repository object from the API into a typed {@link ADORepositoryRef}. */
function normalizeRepository(raw: unknown): ADORepositoryRef {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const ref: ADORepositoryRef = { ...obj };
  ref.id = typeof obj.id === "string" ? obj.id : undefined;
  ref.name = typeof obj.name === "string" ? obj.name : undefined;
  ref.remoteUrl = typeof obj.remoteUrl === "string" ? obj.remoteUrl : undefined;
  ref.webUrl = typeof obj.webUrl === "string" ? obj.webUrl : undefined;
  ref.url = typeof obj.url === "string" ? obj.url : undefined;
  return ref;
}

/** Coerce a raw pull-request object from the API into a typed {@link ADOPullRequest}. */
function normalizePullRequest(raw: unknown): ADOPullRequest {
  const obj = (raw ?? {}) as {
    pullRequestId?: unknown;
    title?: unknown;
    status?: unknown;
    sourceRefName?: unknown;
    targetRefName?: unknown;
    createdBy?: unknown;
    repository?: unknown;
    url?: unknown;
  };
  let createdBy: ADOIdentityRef | string = "";
  if (typeof obj.createdBy === "string") {
    createdBy = obj.createdBy;
  } else if (obj.createdBy && typeof obj.createdBy === "object") {
    createdBy = obj.createdBy as ADOIdentityRef;
  }
  return {
    pullRequestId:
      typeof obj.pullRequestId === "number" ? obj.pullRequestId : 0,
    title: typeof obj.title === "string" ? obj.title : "",
    status: typeof obj.status === "string" ? obj.status : "",
    sourceRefName:
      typeof obj.sourceRefName === "string" ? obj.sourceRefName : "",
    targetRefName:
      typeof obj.targetRefName === "string" ? obj.targetRefName : "",
    createdBy,
    repository: normalizeRepository(obj.repository),
    url: typeof obj.url === "string" ? obj.url : "",
  };
}

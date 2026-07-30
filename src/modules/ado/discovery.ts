/**
 * Azure DevOps discovery reads — READ-ONLY BY CONSTRUCTION.
 *
 * These are metadata GETs used to populate the UI's configuration pickers
 * (which organization? which project?). They mutate nothing in Azure DevOps and
 * issue no PATCH/POST/PUT/DELETE; every method here is a plain GET.
 *
 *   - {@link ADODiscoveryClient.listOrganizations} — the orgs the PAT can reach.
 *   - {@link ADODiscoveryClient.listProjects}       — the projects in one org.
 *   - {@link ADODiscoveryClient.listWorkItemTypes}  — a project's work-item types.
 *   - {@link ADODiscoveryClient.listStates}         — the states of one type.
 *   - {@link ADODiscoveryClient.listAreaPaths}      — a project's area-path tree.
 *   - {@link ADODiscoveryClient.listIterations}     — a project's iteration tree.
 *   - {@link ADODiscoveryClient.listIdentities}     — users matching a query.
 *
 * Unlike {@link ADOClient} — which is constructed per org/project/PAT triple —
 * discovery runs *before* an org/project is chosen, so each method takes the PAT
 * (and, for project listing, the org) as an argument. The PAT is resolved by the
 * caller from the secret store; this module NEVER reads `process.env`, and the
 * PAT is never written to a log line or embedded in a thrown error. Auth and
 * request handling reuse {@link buildAuthHeader}/{@link requestJson} from the
 * client, so discovery authenticates and types errors exactly like the client.
 */

import {
  ADO_API_VERSION,
  ADO_DEFAULT_BASE_URL,
  ADOApiError,
  requestJson,
  type FetchLike,
} from "./client";

/**
 * Base URL of the Visual Studio Profile/Accounts (vssps) host. Organization
 * discovery is served here, not from {@link ADO_DEFAULT_BASE_URL}, because the
 * "which accounts can this identity reach?" query is not org-scoped.
 */
export const ADO_VSSPS_BASE_URL = "https://app.vssps.visualstudio.com";

/** One organization the authenticated identity can reach. */
export interface ADOAccount {
  /** The org's account name (the `{org}` segment of a dev.azure.com URL). */
  accountName: string;
}

/** One project within an organization. */
export interface ADOProject {
  /** The project's display name (the `{project}` segment of a REST URL). */
  name: string;
}

/** One work-item type defined in a project (e.g. its user-chosen name). */
export interface ADOWorkItemType {
  /** The type's name, used verbatim in WIQL and states lookups. */
  name: string;
}

/** One workflow state available for a work-item type. */
export interface ADOWorkItemState {
  /** The state's name (e.g. the value of `System.State`). */
  name: string;
}

/** One identity (user) matched by an identity search. */
export interface ADOIdentity {
  /** The identity's human-readable display name. */
  displayName: string;
  /** The identity's unique name (typically an email / UPN). */
  uniqueName: string;
}

/** Construction options for {@link ADODiscoveryClient}. */
export interface ADODiscoveryClientOptions {
  /**
   * Base URL of the org-scoped Azure DevOps REST host (project discovery).
   * Defaults to {@link ADO_DEFAULT_BASE_URL}; overridable so tests can target a
   * mock server.
   */
  baseUrl?: string;
  /**
   * Base URL of the vssps host (identity + organization discovery). Defaults to
   * {@link ADO_VSSPS_BASE_URL}; overridable so tests can target a mock server.
   */
  vsspsBaseUrl?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Per-call options common to every discovery read. */
export interface ADODiscoveryRequestOptions {
  /** Optional caller {@link AbortSignal}; aborting rejects the returned promise. */
  signal?: AbortSignal;
}

/** Percent-encode a single path segment (org names may contain spaces). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * READ-ONLY Azure DevOps discovery client. Holds no PAT and no org/project — it
 * only wires up base URLs and a `fetch`; every read takes the PAT (and org where
 * needed) as an argument, so one instance serves discovery for any identity.
 */
export class ADODiscoveryClient {
  private readonly baseUrl: string;
  private readonly vsspsBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ADODiscoveryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ADO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.vsspsBaseUrl = (options.vsspsBaseUrl ?? ADO_VSSPS_BASE_URL).replace(
      /\/+$/,
      ""
    );
    // The global fetch is used unless a test injects its own.
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * List the organizations the PAT's identity can reach.
   *
   * First resolves the identity's member id via `connectionData` (the same
   * `authenticatedUser` path the client uses for `@Me`), then
   * `GET {vssps}/_apis/accounts?memberId={id}&api-version=7.0` → `value[]`,
   * returning each `accountName`. Both requests are GETs; nothing is mutated.
   */
  async listOrganizations(
    pat: string,
    opts: ADODiscoveryRequestOptions = {}
  ): Promise<ADOAccount[]> {
    const memberId = await this.resolveMemberId(pat, opts.signal);
    const url =
      `${this.vsspsBaseUrl}/_apis/accounts` +
      `?memberId=${encodeURIComponent(memberId)}&api-version=${ADO_API_VERSION}`;
    const result = await requestJson<{ value?: unknown[] }>(
      this.fetchImpl,
      pat,
      url,
      "GET",
      undefined,
      opts.signal
    );
    const value = Array.isArray(result.value) ? result.value : [];
    return value.map(normalizeAccount);
  }

  /**
   * List the projects within `org`.
   * `GET {base}/{org}/_apis/projects?api-version=7.0` → `value[]`, returning
   * each project `name`. This is a GET; nothing is mutated.
   */
  async listProjects(
    org: string,
    pat: string,
    opts: ADODiscoveryRequestOptions = {}
  ): Promise<ADOProject[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(org)}/_apis/projects` +
      `?api-version=${ADO_API_VERSION}`;
    const result = await requestJson<{ value?: unknown[] }>(
      this.fetchImpl,
      pat,
      url,
      "GET",
      undefined,
      opts.signal
    );
    const value = Array.isArray(result.value) ? result.value : [];
    return value.map(normalizeProject);
  }

  /**
   * List the work-item type names defined in `project`.
   * `GET {base}/{org}/{project}/_apis/wit/workitemtypes?api-version=7.0` →
   * `value[]`, returning each `name`. This is a GET; nothing is mutated.
   */
  async listWorkItemTypes(
    org: string,
    project: string,
    pat: string,
    opts: ADODiscoveryRequestOptions = {}
  ): Promise<ADOWorkItemType[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(org)}/${encodeSegment(project)}` +
      `/_apis/wit/workitemtypes?api-version=${ADO_API_VERSION}`;
    const result = await requestJson<{ value?: unknown[] }>(
      this.fetchImpl,
      pat,
      url,
      "GET",
      undefined,
      opts.signal
    );
    const value = Array.isArray(result.value) ? result.value : [];
    return value.map(normalizeWorkItemType);
  }

  /**
   * List the state names available for `type` within `project`.
   * `GET {base}/{org}/{project}/_apis/wit/workitemtypes/{type}/states?api-version=7.0`
   * → `value[]`, returning each `name`.
   *
   * When the `states` sub-resource is unavailable (some processes answer 404 for
   * it), this falls back to reading the full work-item-type list and projecting
   * the matching type's embedded `states`. Both paths are GETs; nothing is
   * mutated.
   */
  async listStates(
    org: string,
    project: string,
    type: string,
    pat: string,
    opts: ADODiscoveryRequestOptions = {}
  ): Promise<ADOWorkItemState[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(org)}/${encodeSegment(project)}` +
      `/_apis/wit/workitemtypes/${encodeSegment(type)}/states` +
      `?api-version=${ADO_API_VERSION}`;
    try {
      const result = await requestJson<{ value?: unknown[] }>(
        this.fetchImpl,
        pat,
        url,
        "GET",
        undefined,
        opts.signal
      );
      const value = Array.isArray(result.value) ? result.value : [];
      return value.map(normalizeState);
    } catch (err) {
      // The states sub-resource is unavailable on some processes; derive the
      // states from the work-item-type list instead. Any other error (auth,
      // network) is a real failure and propagates unchanged.
      if (err instanceof ADOApiError && err.httpStatus === 404) {
        return this.resolveStatesFallback(org, project, type, pat, opts.signal);
      }
      throw err;
    }
  }

  /**
   * List the flattened area paths of `project`.
   * `GET {base}/{org}/{project}/_apis/wit/classificationnodes/areas?$depth=10&api-version=7.0`
   * returns the area-node tree, which is flattened into backslash-joined path
   * strings (`Project\Area\Sub`), root first, each node before its children.
   * This is a GET; nothing is mutated.
   */
  async listAreaPaths(
    org: string,
    project: string,
    pat: string,
    opts: ADODiscoveryRequestOptions = {}
  ): Promise<string[]> {
    return this.resolveClassificationPaths(
      org,
      project,
      "areas",
      pat,
      opts.signal
    );
  }

  /**
   * List the flattened iteration paths of `project`.
   * `GET {base}/{org}/{project}/_apis/wit/classificationnodes/iterations?$depth=10&api-version=7.0`
   * returns the iteration-node tree, flattened into backslash-joined path strings
   * the same way {@link listAreaPaths} handles areas. This is a GET; nothing is
   * mutated.
   */
  async listIterations(
    org: string,
    project: string,
    pat: string,
    opts: ADODiscoveryRequestOptions = {}
  ): Promise<string[]> {
    return this.resolveClassificationPaths(
      org,
      project,
      "iterations",
      pat,
      opts.signal
    );
  }

  /**
   * List the identities (users) of `project` whose display or unique name
   * contains `query` (case-insensitive; an empty `query` matches everyone).
   *
   * Reads the project's teams
   * (`GET {base}/{org}/_apis/projects/{project}/teams?api-version=7.0`) then each
   * team's members
   * (`GET .../teams/{teamId}/members?api-version=7.0`), de-duplicating by unique
   * name. Every request is a GET; nothing is mutated.
   */
  async listIdentities(
    org: string,
    project: string,
    pat: string,
    query: string,
    opts: ADODiscoveryRequestOptions = {}
  ): Promise<ADOIdentity[]> {
    const teamIds = await fetchProjectTeams(
      this.fetchImpl,
      this.baseUrl,
      org,
      project,
      pat,
      opts.signal
    );
    const needle = query.trim().toLowerCase();
    const seen = new Set<string>();
    const out: ADOIdentity[] = [];
    for (const teamId of teamIds) {
      const members = await fetchTeamMembers(
        this.fetchImpl,
        this.baseUrl,
        org,
        project,
        teamId,
        pat,
        opts.signal
      );
      for (const member of members) {
        const key = member.uniqueName || member.displayName;
        if (!key || seen.has(key)) continue;
        if (
          needle &&
          !`${member.displayName}\n${member.uniqueName}`
            .toLowerCase()
            .includes(needle)
        ) {
          continue;
        }
        seen.add(key);
        out.push(member);
      }
    }
    return out;
  }

  /**
   * Fetch one classification-node group (`areas` or `iterations`) at full depth
   * and flatten it into backslash-joined path strings. Shared by
   * {@link listAreaPaths} and {@link listIterations}.
   */
  private async resolveClassificationPaths(
    org: string,
    project: string,
    group: "areas" | "iterations",
    pat: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(org)}/${encodeSegment(project)}` +
      `/_apis/wit/classificationnodes/${group}` +
      `?$depth=10&api-version=${ADO_API_VERSION}`;
    const result = await requestJson<unknown>(
      this.fetchImpl,
      pat,
      url,
      "GET",
      undefined,
      signal
    );
    return flattenClassificationPaths(result);
  }

  /**
   * Derive the states of `type` from the work-item-type list when the dedicated
   * states sub-resource is unavailable. Reads
   * `GET {base}/{org}/{project}/_apis/wit/workitemtypes?api-version=7.0`, finds
   * the entry whose `name` equals `type`, and projects its embedded `states`.
   */
  private async resolveStatesFallback(
    org: string,
    project: string,
    type: string,
    pat: string,
    signal?: AbortSignal
  ): Promise<ADOWorkItemState[]> {
    const url =
      `${this.baseUrl}/${encodeSegment(org)}/${encodeSegment(project)}` +
      `/_apis/wit/workitemtypes?api-version=${ADO_API_VERSION}`;
    const result = await requestJson<{ value?: unknown[] }>(
      this.fetchImpl,
      pat,
      url,
      "GET",
      undefined,
      signal
    );
    const value = Array.isArray(result.value) ? result.value : [];
    for (const raw of value) {
      const obj = (raw ?? {}) as { name?: unknown; states?: unknown };
      if (typeof obj.name === "string" && obj.name === type) {
        const states = Array.isArray(obj.states) ? obj.states : [];
        return states.map(normalizeState);
      }
    }
    return [];
  }

  /**
   * Resolve the authenticated identity's member id from the vssps
   * `connectionData` endpoint (`authenticatedUser.id`). This id is what the
   * accounts endpoint expects as `memberId`. An absent id yields "".
   */
  private async resolveMemberId(
    pat: string,
    signal?: AbortSignal
  ): Promise<string> {
    const url = `${this.vsspsBaseUrl}/_apis/connectionData`;
    const result = await requestJson<{
      authenticatedUser?: { id?: unknown };
    }>(this.fetchImpl, pat, url, "GET", undefined, signal);
    const id = result.authenticatedUser?.id;
    return typeof id === "string" ? id : "";
  }
}

/** Coerce a raw accounts-endpoint row into a typed {@link ADOAccount}. */
function normalizeAccount(raw: unknown): ADOAccount {
  const obj = (raw ?? {}) as { accountName?: unknown };
  return {
    accountName: typeof obj.accountName === "string" ? obj.accountName : "",
  };
}

/** Coerce a raw projects-endpoint row into a typed {@link ADOProject}. */
function normalizeProject(raw: unknown): ADOProject {
  const obj = (raw ?? {}) as { name?: unknown };
  return {
    name: typeof obj.name === "string" ? obj.name : "",
  };
}

/** Coerce a raw work-item-type row into a typed {@link ADOWorkItemType}. */
function normalizeWorkItemType(raw: unknown): ADOWorkItemType {
  const obj = (raw ?? {}) as { name?: unknown };
  return {
    name: typeof obj.name === "string" ? obj.name : "",
  };
}

/** Coerce a raw state row into a typed {@link ADOWorkItemState}. */
function normalizeState(raw: unknown): ADOWorkItemState {
  const obj = (raw ?? {}) as { name?: unknown };
  return {
    name: typeof obj.name === "string" ? obj.name : "",
  };
}

/** Coerce a raw team-member row (`{ identity }`) into a typed {@link ADOIdentity}. */
function normalizeMember(raw: unknown): ADOIdentity {
  const obj = (raw ?? {}) as { identity?: unknown };
  const identity = (obj.identity ?? {}) as {
    displayName?: unknown;
    uniqueName?: unknown;
  };
  return {
    displayName:
      typeof identity.displayName === "string" ? identity.displayName : "",
    uniqueName:
      typeof identity.uniqueName === "string" ? identity.uniqueName : "",
  };
}

/**
 * Flatten a classification-node tree (as returned by
 * `_apis/wit/classificationnodes/{areas|iterations}`) into backslash-joined path
 * strings — the root first, then each node before its children (`Project`,
 * `Project\Area`, `Project\Area\Sub`, …). An empty/absent root yields `[]`.
 */
function flattenClassificationPaths(root: unknown): string[] {
  const paths: string[] = [];
  const walk = (node: unknown, prefix: string[]): void => {
    const obj = (node ?? {}) as { name?: unknown; children?: unknown };
    const name = typeof obj.name === "string" ? obj.name : "";
    // A name-less node (e.g. an empty `{}` root) contributes no path of its own
    // and does not extend the prefix, so its children stay at the current depth.
    const trail = name ? [...prefix, name] : prefix;
    if (name) paths.push(trail.join("\\"));
    const children = Array.isArray(obj.children) ? obj.children : [];
    for (const child of children) walk(child, trail);
  };
  walk(root, []);
  return paths;
}

/**
 * Read the ids of a project's teams.
 * `GET {base}/{org}/_apis/projects/{project}/teams?api-version=7.0` → `value[]`,
 * returning each string `id` (blank ids are dropped). A GET; nothing is mutated.
 */
async function fetchProjectTeams(
  fetchImpl: FetchLike,
  baseUrl: string,
  org: string,
  project: string,
  pat: string,
  signal?: AbortSignal
): Promise<string[]> {
  const url =
    `${baseUrl}/${encodeSegment(org)}/_apis/projects/${encodeSegment(project)}` +
    `/teams?api-version=${ADO_API_VERSION}`;
  const result = await requestJson<{ value?: unknown[] }>(
    fetchImpl,
    pat,
    url,
    "GET",
    undefined,
    signal
  );
  const value = Array.isArray(result.value) ? result.value : [];
  return value
    .map((raw) => {
      const obj = (raw ?? {}) as { id?: unknown };
      return typeof obj.id === "string" ? obj.id : "";
    })
    .filter((id) => id !== "");
}

/**
 * Read one team's members.
 * `GET {base}/{org}/_apis/projects/{project}/teams/{teamId}/members?api-version=7.0`
 * → `value[]`, each normalized to an {@link ADOIdentity}. A GET; nothing is
 * mutated.
 */
async function fetchTeamMembers(
  fetchImpl: FetchLike,
  baseUrl: string,
  org: string,
  project: string,
  teamId: string,
  pat: string,
  signal?: AbortSignal
): Promise<ADOIdentity[]> {
  const url =
    `${baseUrl}/${encodeSegment(org)}/_apis/projects/${encodeSegment(project)}` +
    `/teams/${encodeSegment(teamId)}/members?api-version=${ADO_API_VERSION}`;
  const result = await requestJson<{ value?: unknown[] }>(
    fetchImpl,
    pat,
    url,
    "GET",
    undefined,
    signal
  );
  const value = Array.isArray(result.value) ? result.value : [];
  return value.map(normalizeMember);
}

import express from "express";
import type { Request } from "express";

import { getModuleConfig } from "../db/moduleConfig";
import {
  ADOApiError,
  ADOClient,
  type ADOAuthenticatedIdentity,
  type ADOWorkItem,
} from "../modules/ado/client";
import {
  ADODiscoveryClient,
  type ADOAccount,
  type ADOIdentity,
  type ADOProject,
  type ADOWorkItemState,
  type ADOWorkItemType,
} from "../modules/ado/discovery";
import { buildManualEvent } from "../modules/ado/materialize";
import { ADO_MODULE_ID, type AdoModuleConfig } from "../modules/ado/poller";
import { searchWorkItems } from "../modules/ado/search";
import { getRuntime } from "../runtime";
import { getSecret } from "../secrets";
import { emitEvent } from "../services/eventIntake";

import { handler, HttpError, parseIdParam } from "./http";

/**
 * `/api/modules/ado` — surface the ADO module's READ-ONLY discovery reads and
 * the authenticated identity to the SPA, so the Modules/Settings pages can offer
 * cascading pickers (which org? project? work-item type? …) and prefill the
 * `identity_me` value.
 *
 *   GET /discovery/orgs
 *   GET /discovery/projects?org=
 *   GET /discovery/work-item-types?org=&project=
 *   GET /discovery/states?org=&project=&type=
 *   GET /discovery/area-paths?org=&project=
 *   GET /discovery/iterations?org=&project=
 *   GET /discovery/identities?org=&project=&q=
 *   GET /discovery/workitems?q=
 *   POST /workitems/:id/materialize
 *   GET /identity/me
 *
 * SECURITY: the PAT never crosses the wire to the client. Every endpoint reads
 * it server-side from the module's configured `pat_secret_ref` via the secret
 * store; a missing/unset secret is a 400 with a clear message. Errors raised by
 * Azure DevOps are passed through as a 502 with a short message.
 */

/** The discovery surface this router depends on; {@link ADODiscoveryClient} satisfies it. */
export interface AdoDiscoveryLike {
  listOrganizations(pat: string): Promise<ADOAccount[]>;
  listProjects(org: string, pat: string): Promise<ADOProject[]>;
  listWorkItemTypes(
    org: string,
    project: string,
    pat: string
  ): Promise<ADOWorkItemType[]>;
  listStates(
    org: string,
    project: string,
    type: string,
    pat: string
  ): Promise<ADOWorkItemState[]>;
  listAreaPaths(org: string, project: string, pat: string): Promise<string[]>;
  listIterations(org: string, project: string, pat: string): Promise<string[]>;
  listIdentities(
    org: string,
    project: string,
    pat: string,
    query: string
  ): Promise<ADOIdentity[]>;
}

/**
 * The per-connection read surface this router depends on; {@link ADOClient}
 * satisfies it. Beyond resolving the authenticated identity for `/identity/me`,
 * it exposes the two reads work-item search and materialize need
 * (`runWiql` + `getWorkItems`) — every method is a plain ADO read.
 */
export interface AdoMeClientLike {
  resolveMeIdentity(): Promise<ADOAuthenticatedIdentity>;
  runWiql(query: string): Promise<number[]>;
  getWorkItems(ids: number[]): Promise<ADOWorkItem[]>;
}

/** Connection options a {@link AdoMeClientLike} is built from. */
export interface AdoMeClientOptions {
  org: string;
  project: string;
  pat: string;
  baseUrl?: string;
}

/**
 * Injectable overrides for this router's upstream clients, wired through the
 * {@link import("../runtime").Runtime}. Production leaves both unset — the router
 * then constructs real read-only clients from the module config — while tests
 * supply mocks so no real Azure DevOps HTTP is issued.
 */
export interface AdoRouterDeps {
  /** The discovery client; defaults to a real {@link ADODiscoveryClient}. */
  discovery?: AdoDiscoveryLike;
  /** Builds a per-connection identity client; defaults to a real {@link ADOClient}. */
  makeClient?: (opts: AdoMeClientOptions) => AdoMeClientLike;
}

const adoDiscoveryRouter = express.Router();

/**
 * Load the ADO module config and resolve its PAT server-side. Throws a 400 with
 * a clear message when the module has no `pat_secret_ref` or the referenced
 * secret is missing/unset; the PAT value itself never appears in any message.
 */
async function resolveAdoPat(): Promise<{ config: AdoModuleConfig; pat: string }> {
  const raw = await getModuleConfig(ADO_MODULE_ID);
  const config = ((raw ?? {}) as AdoModuleConfig) ?? {};
  const ref = config.pat_secret_ref;
  if (typeof ref !== "string" || ref.length === 0) {
    throw new HttpError(
      400,
      "ADO PAT is not configured: set the module's pat_secret_ref"
    );
  }
  const pat = getSecret(ref);
  if (pat === undefined || pat === "") {
    throw new HttpError(400, `ADO PAT secret "${ref}" is missing or unset`);
  }
  return { config, pat };
}

/** The discovery client to use — an injected mock, else a real read-only client. */
function getDiscovery(config: AdoModuleConfig): AdoDiscoveryLike {
  return (
    getRuntime().ado?.discovery ??
    new ADODiscoveryClient({ baseUrl: config.base_url })
  );
}

/** The identity client to use — an injected mock, else a real read-only client. */
function getMeClient(config: AdoModuleConfig, pat: string): AdoMeClientLike {
  const opts: AdoMeClientOptions = {
    org: config.org ?? "",
    project: config.project ?? "",
    pat,
    baseUrl: config.base_url,
  };
  const make = getRuntime().ado?.makeClient;
  return make ? make(opts) : new ADOClient(opts);
}

/**
 * Require the module to be enabled AND have org + project set, returning them.
 * The on-demand work-item endpoints read against the configured connection (not
 * query-param org/project like the discovery cascades), so a disabled or
 * under-configured module is a 400 — the same "not configured" behavior the
 * discovery routes give when their inputs are missing.
 */
function requireEnabledConnection(config: AdoModuleConfig): {
  org: string;
  project: string;
} {
  const org = config.org ?? "";
  const project = config.project ?? "";
  if (config.enabled !== true || org.length === 0 || project.length === 0) {
    throw new HttpError(
      400,
      "ADO module is not enabled and configured: set enabled, org, and project"
    );
  }
  return { org, project };
}

/** Require a non-empty string query parameter, else 400. */
function requireQuery(req: Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `${name} query parameter is required`);
  }
  return value;
}

/** Read an optional string query parameter, defaulting to "" when absent. */
function optionalQuery(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === "string" ? value : "";
}

/**
 * Run an upstream ADO read, translating a typed {@link ADOApiError} into a 502
 * with a short message. Non-ADO failures escape to the app error middleware.
 */
/** Response header carrying the "PAT restricted" reason on a degraded 200. */
export const RESTRICTED_HEADER = "X-Ado-Restricted";

/** The plain-language reason shown when a lookup is denied for lack of scope.
 * ASCII-only: this string is sent as an HTTP header value, which must be
 * latin1 — an em-dash or other non-ASCII character makes res.set() throw. */
function restrictedReason(status: number): string {
  return (
    `Azure DevOps denied this lookup (HTTP ${status}). Your PAT is likely ` +
    `restricted - it may be scoped to a single organization or missing a ` +
    `required scope. You can still type the value in manually.`
  );
}

/**
 * True for a permission/scope failure that should degrade gracefully rather
 * than read as a server error: a PAT scoped to one org can't enumerate
 * accounts, and a PAT missing a scope 401/403s a lookup it isn't entitled to.
 */
function isRestricted(err: unknown): err is ADOApiError {
  return (
    err instanceof ADOApiError &&
    (err.httpStatus === 401 || err.httpStatus === 403)
  );
}

/**
 * Run an upstream ADO read, translating a typed {@link ADOApiError} into a 502
 * with a short message. Non-ADO failures escape to the app error middleware.
 * Used for the single-object `/identity/me`; list endpoints use
 * {@link discoverList}, which degrades permission failures to a 200.
 */
async function passThroughAdo<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ADOApiError) {
      throw new HttpError(
        502,
        err.message || `Azure DevOps request failed (${err.httpStatus})`
      );
    }
    throw err;
  }
}

/**
 * Send a discovery list result. A permission failure (401/403) is an EXPECTED
 * outcome — not a bad gateway — so it degrades to a 200 with an empty list and
 * the {@link RESTRICTED_HEADER} reason, keeping the browser's network log clean
 * while the client still shows why. Genuine upstream failures stay a 502.
 */
async function discoverList(
  res: express.Response,
  fn: () => Promise<unknown[]>
): Promise<void> {
  try {
    res.status(200).json(await fn());
  } catch (err) {
    if (isRestricted(err)) {
      res
        .status(200)
        .set(RESTRICTED_HEADER, restrictedReason(err.httpStatus))
        .json([]);
      return;
    }
    if (err instanceof ADOApiError) {
      throw new HttpError(
        502,
        err.message || `Azure DevOps request failed (${err.httpStatus})`
      );
    }
    throw err;
  }
}

adoDiscoveryRouter.get(
  "/discovery/orgs",
  handler(async (_req, res) => {
    const { config, pat } = await resolveAdoPat();
    await discoverList(res, () => getDiscovery(config).listOrganizations(pat));
  })
);

adoDiscoveryRouter.get(
  "/discovery/projects",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    const org = requireQuery(req, "org");
    await discoverList(res, () => getDiscovery(config).listProjects(org, pat));
  })
);

adoDiscoveryRouter.get(
  "/discovery/work-item-types",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    const org = requireQuery(req, "org");
    const project = requireQuery(req, "project");
    await discoverList(res, () =>
      getDiscovery(config).listWorkItemTypes(org, project, pat)
    );
  })
);

adoDiscoveryRouter.get(
  "/discovery/states",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    const org = requireQuery(req, "org");
    const project = requireQuery(req, "project");
    const type = requireQuery(req, "type");
    await discoverList(res, () =>
      getDiscovery(config).listStates(org, project, type, pat)
    );
  })
);

adoDiscoveryRouter.get(
  "/discovery/area-paths",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    const org = requireQuery(req, "org");
    const project = requireQuery(req, "project");
    await discoverList(res, () =>
      getDiscovery(config).listAreaPaths(org, project, pat)
    );
  })
);

adoDiscoveryRouter.get(
  "/discovery/iterations",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    const org = requireQuery(req, "org");
    const project = requireQuery(req, "project");
    await discoverList(res, () =>
      getDiscovery(config).listIterations(org, project, pat)
    );
  })
);

adoDiscoveryRouter.get(
  "/discovery/identities",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    const org = requireQuery(req, "org");
    const project = requireQuery(req, "project");
    // `q` is an optional filter; an empty query matches every identity.
    const query = optionalQuery(req, "q");
    await discoverList(res, () =>
      getDiscovery(config).listIdentities(org, project, pat, query)
    );
  })
);

adoDiscoveryRouter.get(
  "/discovery/workitems",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    const { project } = requireEnabledConnection(config);
    const q = requireQuery(req, "q");
    // Same degrade-on-permission behavior as the other discovery lists: a
    // 401/403 becomes a 200 empty list with the restricted header, a genuine
    // upstream failure a 502.
    await discoverList(res, () =>
      searchWorkItems(getMeClient(config, pat), project, q)
    );
  })
);

adoDiscoveryRouter.post(
  "/workitems/:id/materialize",
  handler(async (req, res) => {
    const { config, pat } = await resolveAdoPat();
    requireEnabledConnection(config);
    const id = parseIdParam(req.params.id);

    // Fetch exactly this one item; a non-existent id is a 404, not a 502.
    let items: ADOWorkItem[];
    try {
      items = await getMeClient(config, pat).getWorkItems([id]);
    } catch (err) {
      if (err instanceof ADOApiError && err.httpStatus === 404) {
        throw new HttpError(404, `work item ${id} not found in Azure DevOps`);
      }
      if (err instanceof ADOApiError) {
        throw new HttpError(
          502,
          err.message || `Azure DevOps request failed (${err.httpStatus})`
        );
      }
      throw err;
    }
    const item = items.find((candidate) => candidate.id === id);
    if (!item) {
      throw new HttpError(404, `work item ${id} not found in Azure DevOps`);
    }

    // Record ONE event through the normal intake with rule matching skipped, so
    // no dispatch is created here (a manual dispatch is a separate step). No
    // dedupe_key: a manual materialize must always insert.
    const result = await emitEvent(buildManualEvent(item), undefined, undefined, {
      skipRuleMatching: true,
    });
    // Unreachable: a dedupe-key-less event is never suppressed. Guard for types.
    if (result.suppressed) {
      throw new HttpError(500, "materialized event was unexpectedly suppressed");
    }
    res.status(201).json(result.event);
  })
);

adoDiscoveryRouter.get(
  "/identity/me",
  handler(async (_req, res) => {
    const { config, pat } = await resolveAdoPat();
    if (typeof config.org !== "string" || config.org.length === 0) {
      throw new HttpError(
        400,
        "ADO org is not configured: set the module's org"
      );
    }
    const identity = await passThroughAdo(() =>
      getMeClient(config, pat).resolveMeIdentity()
    );
    res.status(200).json(identity);
  })
);

export default adoDiscoveryRouter;

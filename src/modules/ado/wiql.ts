/**
 * Watched-query WIQL builder — a PURE function that turns a data-only config
 * object into an Azure DevOps WIQL query string.
 *
 * This file contains NO knowledge of what the resulting query is "for": it does
 * not name intents (PR, bug, review, work item, …) in code. It merely composes
 * the generic filter clauses the user configured — assignee, states, area paths,
 * iteration — into a single ORDER-BY-recency query over `WorkItems`. Per the
 * ARCHITECTURE PRINCIPLE (see CLAUDE.md), behavior is defined entirely by the
 * config data passed in, never by branches named around a domain concept.
 *
 * The builder is deterministic and side-effect free: same config in, same string
 * out. It performs no I/O and never touches `process.env`. All user-supplied
 * string values are embedded as single-quoted WIQL literals with embedded single
 * quotes doubled, per WIQL string-literal escaping.
 */

/** How the assignee clause is derived. */
export type WatchedAssigneeMode = "me" | "people" | "any";

/**
 * How the {@link WatchedWiqlConfig.states} list is applied. `include` (the
 * default) keeps the OR-of-equality membership test; `exclude` emits a single
 * `[System.State] NOT IN (…)` clause so a config can express a board's canonical
 * "open" set as everything but the terminal states.
 */
export type WatchedStateMode = "include" | "exclude";

/**
 * Team-scoped current-iteration selector. A plain `@CurrentIteration` resolves
 * against no particular team; passing `current_for_team` renders
 * `@CurrentIteration('[<Project>]\<Team>')` so a specific team's sprint resolves
 * correctly. `current_for_team` is a raw `<Project>\<Team>` string.
 */
export interface WatchedTeamIteration {
  current_for_team: string;
}

/**
 * Explicit-iteration-path selector. Renders `[System.IterationPath] UNDER
 * '<path>'` so a watch can bound itself to one named iteration (and its
 * children) — e.g. a backlog parking-lot iteration — instead of resolving the
 * team's *current* sprint. `path` is a raw `<Project>\<Iteration>` string.
 */
export interface WatchedExplicitIteration {
  path: string;
}

/**
 * Data-only description of a watched query. Every field is generic: the builder
 * assigns no meaning beyond the WIQL clause it maps to.
 */
export interface WatchedWiqlConfig {
  /**
   * `me` → `[System.AssignedTo] = @Me`; `people` → an OR of equality over
   * {@link WatchedWiqlConfig.people}; `any` → no assignee clause at all.
   */
  assignee_mode: WatchedAssigneeMode;
  /** Identities OR-ed on `[System.AssignedTo]` when `assignee_mode` is `people`. */
  people?: string[];
  /** Values OR-ed on `[System.WorkItemType]`. */
  work_item_types?: string[];
  /** Values OR-ed on `[System.State]`. */
  states?: string[];
  /**
   * Whether {@link WatchedWiqlConfig.states} is an allow-list (`include`,
   * default) or a deny-list (`exclude` → `[System.State] NOT IN (…)`). Ignored
   * when `states` is absent or empty.
   */
  state_mode?: WatchedStateMode;
  /** Roots OR-ed on `[System.AreaPath] UNDER`. */
  area_paths?: string[];
  /**
   * `current` → `[System.IterationPath] = @CurrentIteration`; a
   * {@link WatchedTeamIteration} → the team-scoped `@CurrentIteration('[…]\…')`
   * form; a {@link WatchedExplicitIteration} → `[System.IterationPath] UNDER
   * '<path>'`; `null` → omitted.
   */
  iteration?: "current" | WatchedTeamIteration | WatchedExplicitIteration | null;
  /** Tags AND-ed as `[System.Tags] CONTAINS '<tag>'`, one clause each. */
  tags?: string[];
}

/**
 * Options controlling how {@link buildWatchedWiql} scopes the query. Kept
 * separate from the data-only filter config because a project is a connection
 * fact (which org/project the query runs against), not a watched-filter facet.
 */
export interface WatchedWiqlOptions {
  /**
   * When set to a non-empty project name, the query is bounded to that project
   * with a leading `[System.TeamProject] = '<project>'` clause. This is
   * belt-and-braces alongside the project-scoped WIQL route: even if a query
   * were ever run against an org-scoped endpoint, a work item from another
   * project in the same organization can never match. Omit (or pass "") to
   * leave the query project-agnostic, exactly as before.
   */
  project?: string;
}

/** The leading clause shared by every watched query. */
const WIQL_SELECT = "SELECT [System.Id] FROM WorkItems";

/** The trailing clause shared by every watched query. */
const WIQL_ORDER_BY = "ORDER BY [System.ChangedDate] DESC";

/**
 * Escape a raw string for use as a single-quoted WIQL string literal. WIQL
 * escapes an embedded single quote by doubling it; no other character needs
 * escaping. The returned value INCLUDES the surrounding quotes.
 */
function quote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Wrap a list of already-rendered comparison fragments in a single parenthesised
 * OR group, e.g. `([System.State] = 'a' OR [System.State] = 'b')`. A single
 * fragment is still parenthesised so clause combination stays uniform.
 */
function orGroup(fragments: string[]): string {
  return "(" + fragments.join(" OR ") + ")";
}

/**
 * Render the team-scoped `<Project>\<Team>` string into the bracketed form
 * `@CurrentIteration` expects: the leading project segment is wrapped in square
 * brackets, the remainder (including its leading backslash) is preserved. A
 * value with no backslash is treated as a bare project and bracketed whole.
 */
function bracketTeamPath(raw: string): string {
  const slash = raw.indexOf("\\");
  return slash === -1
    ? `[${raw}]`
    : `[${raw.slice(0, slash)}]${raw.slice(slash)}`;
}

/**
 * Build the WIQL query string for a watched query.
 *
 * The result always begins with {@link WIQL_SELECT} and ends with
 * {@link WIQL_ORDER_BY}. Between them, each configured filter contributes one
 * AND-ed clause. When {@link WatchedWiqlOptions.project} is supplied it is the
 * FIRST clause (`[System.TeamProject] = '<project>'`), so the query is bounded
 * to that project regardless of which endpoint runs it; the remaining filters
 * follow in this fixed order: assignee, work-item types, states, area paths,
 * iteration, tags. A clause is omitted entirely when its config is absent
 * or empty (an empty `people`/`work_item_types`/`states`/`area_paths`/`tags`
 * array produces no clause, exactly as if the field were undefined). When no
 * filter applies (and no project is given), the query is
 * `SELECT … FROM WorkItems ORDER BY …` with no `WHERE`.
 */
export function buildWatchedWiql(
  config: WatchedWiqlConfig,
  options: WatchedWiqlOptions = {},
): string {
  const clauses: string[] = [];

  if (options.project) {
    clauses.push(`[System.TeamProject] = ${quote(options.project)}`);
  }

  if (config.assignee_mode === "me") {
    clauses.push("[System.AssignedTo] = @Me");
  } else if (config.assignee_mode === "people" && config.people?.length) {
    clauses.push(
      orGroup(config.people.map((p) => `[System.AssignedTo] = ${quote(p)}`)),
    );
  }

  if (config.work_item_types?.length) {
    clauses.push(
      orGroup(
        config.work_item_types.map(
          (t) => `[System.WorkItemType] = ${quote(t)}`,
        ),
      ),
    );
  }

  if (config.states?.length) {
    if (config.state_mode === "exclude") {
      clauses.push(
        `[System.State] NOT IN (${config.states.map(quote).join(", ")})`,
      );
    } else {
      clauses.push(
        orGroup(config.states.map((s) => `[System.State] = ${quote(s)}`)),
      );
    }
  }

  if (config.area_paths?.length) {
    clauses.push(
      orGroup(config.area_paths.map((a) => `[System.AreaPath] UNDER ${quote(a)}`)),
    );
  }

  if (config.iteration === "current") {
    clauses.push("[System.IterationPath] = @CurrentIteration");
  } else if (config.iteration && typeof config.iteration === "object") {
    if ("path" in config.iteration) {
      clauses.push(
        `[System.IterationPath] UNDER ${quote(config.iteration.path)}`,
      );
    } else {
      clauses.push(
        `[System.IterationPath] = @CurrentIteration(${quote(
          bracketTeamPath(config.iteration.current_for_team),
        )})`,
      );
    }
  }

  if (config.tags?.length) {
    for (const tag of config.tags) {
      clauses.push(`[System.Tags] CONTAINS ${quote(tag)}`);
    }
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return `${WIQL_SELECT}${where} ${WIQL_ORDER_BY}`;
}

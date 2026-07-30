/**
 * On-demand Azure DevOps work-item search — READ-ONLY BY CONSTRUCTION.
 *
 * Backs the SPA's work-item picker: given a free-text query it runs a WIQL title
 * search (and, when the query is a bare id, an exact id lookup), then flattens
 * each matching work item into a row shaped like the poller's event payload so
 * the UI sees consistent field naming. Every read goes through the same
 * {@link AdoSearchClient} the poller uses ({@link ADOClient} satisfies it):
 * `runWiql` + `getWorkItems`, both plain reads. Nothing here writes to ADO.
 *
 * Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md) the query composed here names no
 * intent: it filters `System.Title` and `System.TeamProject`, nothing domain.
 */

import { ADOApiError, type ADOWorkItem } from "./client";
import {
  buildWorkItemPayload,
  toWorkItemView,
  type WorkItemView,
} from "./workItemPayload";

/** The maximum number of rows a single search returns. */
export const ADO_WORKITEM_SEARCH_LIMIT = 25;

/** The read-only ADO surface a search needs; {@link ADOClient} satisfies it. */
export interface AdoSearchClient {
  runWiql(query: string): Promise<number[]>;
  getWorkItems(ids: number[]): Promise<ADOWorkItem[]>;
}

/**
 * One search result row. These are exactly the poller payload's identity/display
 * fields (see {@link buildWorkItemPayload}), so the UI and users see consistent
 * naming across the picker and the events a materialize produces.
 */
export interface WorkItemSearchRow {
  id: number;
  title: string;
  work_item_type: string;
  state: string;
  area_path: string;
  iteration_path: string;
  assignee: string;
  url: string;
}

/**
 * Escape a raw string for use as a single-quoted WIQL string literal: WIQL
 * doubles an embedded single quote. The returned value INCLUDES the surrounding
 * quotes. (Mirrors the escaping in {@link import("./wiql")}, kept local so the
 * search query stays self-contained.)
 */
function quote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Build the title-search WIQL: every work item in `project` whose `System.Title`
 * contains the words of `q`, newest change first. Project-scoped by an explicit
 * `[System.TeamProject]` clause (belt-and-braces alongside the project-scoped
 * WIQL route). No cap in the query — WIQL flat queries take none — so the caller
 * slices the returned ids.
 */
export function buildTitleSearchWiql(project: string, q: string): string {
  return (
    "SELECT [System.Id] FROM WorkItems WHERE " +
    `[System.TeamProject] = ${quote(project)} AND ` +
    `[System.Title] CONTAINS WORDS ${quote(q)} ` +
    "ORDER BY [System.ChangedDate] DESC"
  );
}

/** Project a fetched work item into a {@link WorkItemSearchRow}. */
function toRow(view: WorkItemView): WorkItemSearchRow {
  const payload = buildWorkItemPayload(view);
  return {
    id: payload.id as number,
    title: payload.title as string,
    work_item_type: payload.work_item_type as string,
    state: payload.state as string,
    area_path: payload.area_path as string,
    iteration_path: payload.iteration_path as string,
    assignee: payload.assignee as string,
    url: payload.url as string,
  };
}

/**
 * Parse `q` as a positive integer work-item id, or `null` when it is not a bare
 * positive integer. Used to decide whether to ALSO do an exact id lookup.
 */
function parseWorkItemId(q: string): number | null {
  if (!/^\d+$/.test(q.trim())) return null;
  const n = Number(q.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Search the configured project's work items for the picker.
 *
 * Always runs a title search (`System.Title CONTAINS WORDS q`). When `q` is a
 * bare positive integer, ALSO looks that exact id up and lists it first; a typed
 * id that does not exist in ADO is silently ignored (a 404 on the exact lookup
 * is not an error for a search). Results are de-duplicated by id and capped at
 * {@link ADO_WORKITEM_SEARCH_LIMIT}. Read-only: only `runWiql`/`getWorkItems`.
 */
export async function searchWorkItems(
  client: AdoSearchClient,
  project: string,
  q: string
): Promise<WorkItemSearchRow[]> {
  const rows: WorkItemSearchRow[] = [];
  const seen = new Set<number>();

  const exactId = parseWorkItemId(q);
  if (exactId !== null) {
    try {
      const items = await client.getWorkItems([exactId]);
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        rows.push(toRow(toWorkItemView(item)));
      }
    } catch (err) {
      // A typed id that doesn't exist in ADO 404s the batch fetch; that is not a
      // search failure — fall through to the title results. Any other ADO error
      // (auth, server) propagates so the caller can surface it.
      if (!(err instanceof ADOApiError) || err.httpStatus !== 404) throw err;
    }
  }

  const ids = await client.runWiql(buildTitleSearchWiql(project, q));
  const capped = ids
    .filter((id) => !seen.has(id))
    .slice(0, ADO_WORKITEM_SEARCH_LIMIT - rows.length);
  if (capped.length > 0) {
    const items = await client.getWorkItems(capped);
    for (const item of items) {
      if (seen.has(item.id) || rows.length >= ADO_WORKITEM_SEARCH_LIMIT) continue;
      seen.add(item.id);
      rows.push(toRow(toWorkItemView(item)));
    }
  }

  return rows;
}

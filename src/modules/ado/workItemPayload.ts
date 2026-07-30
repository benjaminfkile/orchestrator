/**
 * The shared flatten-and-payload code for one Azure DevOps work item.
 *
 * Extracted from the poller so that any on-demand read (e.g. materializing a
 * single work item as an event) produces the EXACT SAME event payload a poll
 * tick does — there is one place a raw {@link ADOWorkItem} becomes the
 * domain-neutral fields the core stores, and one place those fields become the
 * event payload. Per the ARCHITECTURE PRINCIPLE (see CLAUDE.md), nothing here
 * learns what the item *means*: it only flattens opaque fields and maps the API
 * url to its web-UI url via {@link toWorkItemWebUrl}.
 */

import type { ADOIdentityRef, ADOWorkItem } from "./client";
import { toWorkItemWebUrl } from "./workItemUrl";

/** Read a string-typed field, defaulting to "" when absent or non-string. */
export function strField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Reduce an `AssignedTo` value to a single stable identity string. The API sends
 * an identity ref when a work item is expanded (else a bare string); an
 * unassigned item yields "".
 */
export function extractAssignee(
  raw: ADOIdentityRef | string | undefined
): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return raw.uniqueName ?? raw.displayName ?? raw.id ?? "";
}

/** Split the `System.Tags` field ("a; b; c") into a trimmed, non-empty array. */
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** A flattened, domain-neutral view of one fetched work item. */
export interface WorkItemView {
  id: number;
  title: string;
  state: string;
  work_item_type: string;
  assignee: string;
  area_path: string;
  iteration_path: string;
  tags: string[];
  url: string;
  changed: string;
}

/** Flatten a raw {@link ADOWorkItem} into the fields the poller reads. */
export function toWorkItemView(item: ADOWorkItem): WorkItemView {
  const f = item.fields;
  return {
    id: item.id,
    title: strField(f["System.Title"]),
    state: strField(f["System.State"]),
    work_item_type: strField(f["System.WorkItemType"]),
    assignee: extractAssignee(f["System.AssignedTo"]),
    area_path: strField(f["System.AreaPath"]),
    iteration_path: strField(f["System.IterationPath"]),
    tags: parseTags(f["System.Tags"]),
    url: item.url,
    changed: strField(f["System.ChangedDate"]),
  };
}

/**
 * The shared event payload carried by every event type for a given item. `url`
 * is the human web-UI url (so a click opens the work item, not raw JSON); the
 * originating REST API url is preserved as `api_url` in case a capability wants
 * it. Deriving the web url from the API url is ADO-specific knowledge and lives
 * in {@link toWorkItemWebUrl}, never in the core.
 */
export function buildWorkItemPayload(v: WorkItemView): Record<string, unknown> {
  return {
    id: v.id,
    title: v.title,
    state: v.state,
    work_item_type: v.work_item_type,
    assignee: v.assignee,
    area_path: v.area_path,
    iteration_path: v.iteration_path,
    tags: v.tags,
    url: toWorkItemWebUrl(v.url),
    api_url: v.url,
  };
}

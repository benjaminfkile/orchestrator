/**
 * ADO-specific knowledge, kept in the ADO module by design (see the ARCHITECTURE
 * PRINCIPLE in CLAUDE.md): the mapping between a work item's REST API url and its
 * browsable web-UI url.
 *
 * ADO returns a work item's `url` as the REST API url, which renders raw JSON in
 * a browser:
 *   https://{host}/{org-or-collection}/{project}/_apis/wit/workItems/{id}
 * (`dev.azure.com`, an on-prem collection host, and `{org}.visualstudio.com` all
 * share the same `_apis/wit/workItems/{id}` tail). The human web url for the same
 * item replaces that tail with `_workitems/edit/{id}`, matching the `_links.html`
 * href ADO itself returns. Only that documented segment is rewritten — the
 * host/org/project prefix is preserved verbatim, and the id is carried through.
 */

/**
 * Matches the `_apis/wit/workItems/{id}` REST tail, case-insensitively (ADO
 * capitalizes `workItems`), anchored so the id is captured whole and any trailing
 * `/`, `?query`, or `#fragment` is left intact. Scoped strictly to this shape so
 * an opaque url of any other shape never matches.
 */
const WORK_ITEM_API_TAIL = /\/_apis\/wit\/workitems\/(\d+)(?=$|[/?#])/i;

/** True when `url` is an ADO work-item REST API url of the documented shape. */
export function isWorkItemApiUrl(url: string): boolean {
  return WORK_ITEM_API_TAIL.test(url);
}

/**
 * Rewrite an ADO work-item REST API url to its human web-UI url
 * (`_apis/wit/workItems/{id}` → `_workitems/edit/{id}`), preserving the
 * host/org/project prefix. A url that does not match the pattern is returned
 * unchanged, so a non-work-item or already-web url is never corrupted.
 */
export function toWorkItemWebUrl(apiUrl: string): string {
  return apiUrl.replace(WORK_ITEM_API_TAIL, "/_workitems/edit/$1");
}

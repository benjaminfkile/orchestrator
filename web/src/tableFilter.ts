/**
 * Shared client-side table filtering for the small, fully-loaded config tables
 * (Playbooks, Rules, Notifiers). Mirrors the backend SQL search's semantics so
 * the two feel identical to a user: the query is split on whitespace into terms,
 * every term must match SOMEWHERE in the row (terms are ANDed), and matching is a
 * case-insensitive substring test. An empty/whitespace query keeps every row.
 *
 * Unlike the backend — which searches a fixed set of text columns — a config
 * table filter searches EVERY rendered column's text, including non-string cells
 * (numbers, booleans, and JSON blobs like a rule's `match`/`criteria` or a
 * playbook's `runner_config`) via {@link cellText}. So a user can find a rule by
 * a criteria fragment or a playbook by its image name, matching what they see.
 */

/**
 * Split a raw query into lowercased, whitespace-separated terms. Trims first;
 * empty/whitespace-only input yields `[]` (meaning "no filter").
 */
export function filterTerms(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed.toLowerCase().split(/\s+/);
}

/**
 * Stringify a single cell value for text matching. Strings pass through;
 * numbers/booleans stringify; null/undefined become empty; everything else
 * (objects, arrays) serializes to JSON so a nested fragment is still findable.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Filter `rows` by `query` using multi-term AND, case-insensitive substring
 * matching over each row's rendered columns. `columns` yields, per row, the list
 * of cell values that back that row's rendered columns (any type — they are
 * stringified via {@link cellText}). Returns `rows` unchanged for an empty query,
 * so the default (unfiltered) state is preserved exactly.
 */
export function filterRows<Row>(
  rows: Row[],
  query: string,
  columns: (row: Row) => readonly unknown[],
): Row[] {
  const terms = filterTerms(query);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = columns(row).map(cellText).join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

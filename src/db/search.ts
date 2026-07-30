import type { Knex } from "knex";

/**
 * Case-insensitive substring search over text columns, built on SQLite `LIKE`.
 *
 * History in this app is bounded (see `run_retention_max`), so a plain `LIKE`
 * scan is the right tool — no FTS index is needed. `LIKE` is already
 * case-insensitive for ASCII in SQLite, which is what "find an ADO item number
 * anywhere in history" wants.
 *
 * A raw user string is split on whitespace into terms. Every term must match
 * SOMEWHERE in the searched columns (terms are ANDed); within a single term the
 * columns are ORed. So `"1234 failed"` finds rows mentioning both `1234` and
 * `failed`, in any column, in any order.
 */

/**
 * The `LIKE` escape character. `%` and `_` are wildcards in a `LIKE` pattern; a
 * user searching for a literal `%` must not match every row. We escape those two
 * plus the escape char itself and pass `ESCAPE '\'` so SQLite treats the escaped
 * forms literally.
 */
const LIKE_ESCAPE = "\\";

/** The trailing `ESCAPE '\'` clause appended to every generated `LIKE`. */
const ESCAPE_CLAUSE = `ESCAPE '${LIKE_ESCAPE}'`;

/**
 * Escape the `LIKE` metacharacters (`%`, `_`) and the escape char itself in a
 * user term, so the term matches literally rather than as a wildcard pattern.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => LIKE_ESCAPE + c);
}

/**
 * Split a raw user search string into terms. Trims first; empty/whitespace-only
 * input yields `[]` (meaning "no filter"). Terms are separated by any run of
 * whitespace.
 */
export function searchTerms(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/);
}

/** Wrap an escaped term in `%…%` to make a substring `LIKE` pattern. */
export function likePattern(term: string): string {
  return `%${escapeLike(term)}%`;
}

/**
 * A raw SQL `LIKE` predicate over one column expression, e.g.
 * `` "events.type LIKE ? ESCAPE '\\'" ``. `expr` is a TRUSTED, hard-coded column
 * or expression (never user input) — the user's value flows only through the
 * bound `?` pattern, so this stays injection-safe. `expr` may be any SQL scalar
 * expression, including `json_extract(...)`.
 */
export function likeExprSql(expr: string): string {
  return `${expr} LIKE ? ${ESCAPE_CLAUSE}`;
}

/**
 * AND a text-search filter onto `query`: for each whitespace-separated term in
 * `raw`, require that term to appear (as an escaped substring, case-insensitive)
 * in at least one of `columns`. `columns` are trusted SQL column expressions.
 * An empty/whitespace `raw` leaves the query untouched.
 *
 * Multi-column-per-row searches that would need a join (and so risk row
 * duplication) should instead build their own `EXISTS` subquery per term using
 * {@link searchTerms}/{@link likePattern}/{@link likeExprSql}; this helper is
 * for the flat single-table (or already-joined, one-row-per-result) case.
 */
export function applySearchFilter<TRecord extends {}, TResult>(
  query: Knex.QueryBuilder<TRecord, TResult>,
  raw: unknown,
  columns: readonly string[]
): Knex.QueryBuilder<TRecord, TResult> {
  const terms = searchTerms(raw);
  if (terms.length === 0) return query;
  let out = query;
  for (const term of terms) {
    const pattern = likePattern(term);
    out = out.where((b) => {
      for (const expr of columns) b.orWhereRaw(likeExprSql(expr), [pattern]);
    });
  }
  return out;
}

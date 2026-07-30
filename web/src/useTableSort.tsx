import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  TableHeaderCell,
  type TableHeaderCellProps,
} from "@fluentui/react-components";

/**
 * Shared client-side table sorting used by every list page.
 *
 * A page describes its columns as {@link SortColumn} value-extractors, seeds a
 * {@link SortState} default (the backend's newest-first column, descending, so
 * the UI and API agree before any click), and renders {@link SortableHeaderCell}
 * for each sortable header. Clicking a header selects that column ascending;
 * re-clicking the active column toggles the direction. Sorting is entirely over
 * the rows already loaded — it issues no new requests, so it composes with
 * client-side filters and cursor "load more" pagers untouched.
 */

export type SortDirection = "ascending" | "descending";

/** The primitive kinds a sortable cell can yield (timestamps arrive as numbers). */
export type SortValue = number | string | boolean | null | undefined;

/** A column the table can sort by: a stable id plus a value extractor. */
export interface SortColumn<Row> {
  columnId: string;
  /** Pull this column's sortable primitive out of a row. */
  value: (row: Row) => SortValue;
}

/** The active sort: which column and which direction. */
export interface SortState {
  columnId: string;
  direction: SortDirection;
}

/**
 * A default that leaves rows in their loaded (server) order until the user
 * clicks a header. For tables whose backend order is already the desired
 * newest-first default AND that render no time/id column to hang an indicator
 * on, this keeps the UI and API in agreement without an initial reorder — its
 * empty `columnId` matches no column, so the rows pass through untouched. The
 * first header click then activates a real column.
 */
export const LOADED_ORDER_SORT: SortState = {
  columnId: "",
  direction: "descending",
};

/**
 * Compare two present (non-null) cell values. Numbers — including timestamps,
 * which reach here as epoch-millis numbers — compare numerically; booleans by
 * false < true; everything else as a case-insensitive string. Mixed types fall
 * back to a string comparison so the sort never throws.
 */
function compareDefined(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") {
    // A NaN would otherwise poison every comparison; treat it as equal.
    if (Number.isNaN(a) || Number.isNaN(b)) return 0;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

/**
 * Compare two cell values honoring the sort direction, with null/undefined
 * ALWAYS ordered last — in BOTH directions, so an empty cell never floats to
 * the top when the sort is flipped.
 */
export function compareSortValues(
  a: SortValue,
  b: SortValue,
  direction: SortDirection,
): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // a is empty → after b
  if (bEmpty) return -1; // b is empty → after a
  const base = compareDefined(a, b);
  return direction === "descending" ? -base : base;
}

/**
 * The next sort state when a header is clicked: a newly-selected column starts
 * ascending; re-clicking the active column toggles its direction.
 */
export function nextSortState(current: SortState, columnId: string): SortState {
  if (current.columnId === columnId) {
    return {
      columnId,
      direction: current.direction === "ascending" ? "descending" : "ascending",
    };
  }
  return { columnId, direction: "ascending" };
}

/** What {@link useTableSort} hands back to a page. */
export interface UseTableSort<Row> {
  /** The rows sorted by the active column (a fresh array; `rows` is untouched). */
  sorted: Row[];
  /** The active sort column + direction. */
  sortState: SortState;
  /** Select/toggle the sort column (a new column starts ascending). */
  toggleSort: (columnId: string) => void;
}

/**
 * Sort a stable copy of `rows` by the active column's extracted value. The sort
 * state starts at `defaultSort` and updates via the returned `toggleSort`. When
 * the active column id has no matching definition (e.g. an implicit id column
 * with no rendered header), the rows pass through in their loaded order.
 */
export function useTableSort<Row>(
  rows: Row[],
  columns: SortColumn<Row>[],
  defaultSort: SortState,
): UseTableSort<Row> {
  const [sortState, setSortState] = useState<SortState>(defaultSort);

  const columnMap = useMemo(() => {
    const map = new Map<string, SortColumn<Row>>();
    for (const column of columns) map.set(column.columnId, column);
    return map;
  }, [columns]);

  const sorted = useMemo(() => {
    const column = columnMap.get(sortState.columnId);
    if (!column) return rows;
    // Decorate-sort-undecorate: extract each value once and carry the original
    // index so equal values keep their loaded order (a stable sort everywhere).
    return rows
      .map((row, index) => ({ row, index, value: column.value(row) }))
      .sort((a, b) => {
        const cmp = compareSortValues(a.value, b.value, sortState.direction);
        return cmp !== 0 ? cmp : a.index - b.index;
      })
      .map((decorated) => decorated.row);
  }, [rows, columnMap, sortState]);

  const toggleSort = useCallback((columnId: string) => {
    setSortState((prev) => nextSortState(prev, columnId));
  }, []);

  return { sorted, sortState, toggleSort };
}

/** Props for {@link SortableHeaderCell}. */
export interface SortableHeaderCellProps
  extends Omit<TableHeaderCellProps, "sortDirection" | "onClick"> {
  /** The column id this header sorts by; must match a {@link SortColumn}. */
  columnId: string;
  /** The table's current sort state. */
  sortState: SortState;
  /** Called with this column's id when the header is activated. */
  onSort: (columnId: string) => void;
  children: ReactNode;
}

/**
 * A {@link TableHeaderCell} wired for click-to-sort: it renders Fluent's built-in
 * sort affordance (an arrow + `aria-sort`) on the active column and calls
 * `onSort` with its column id when clicked or activated by keyboard.
 */
export function SortableHeaderCell({
  columnId,
  sortState,
  onSort,
  children,
  ...rest
}: SortableHeaderCellProps) {
  const active = sortState.columnId === columnId;
  return (
    <TableHeaderCell
      {...rest}
      sortable
      sortDirection={active ? sortState.direction : undefined}
      onClick={() => onSort(columnId)}
    >
      {children}
    </TableHeaderCell>
  );
}

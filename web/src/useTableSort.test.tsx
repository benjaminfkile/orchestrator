import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  compareSortValues,
  nextSortState,
  useTableSort,
  type SortColumn,
  type SortState,
} from "./useTableSort";

describe("compareSortValues", () => {
  it("orders numbers numerically, not lexically", () => {
    expect(compareSortValues(2, 10, "ascending")).toBeLessThan(0);
    expect(compareSortValues(10, 2, "ascending")).toBeGreaterThan(0);
    // Descending flips the sign.
    expect(compareSortValues(2, 10, "descending")).toBeGreaterThan(0);
  });

  it("treats timestamps (epoch millis) as numbers", () => {
    const older = 1_700_000_000_000;
    const newer = 1_700_000_005_000;
    expect(compareSortValues(newer, older, "descending")).toBeLessThan(0);
    expect(compareSortValues(older, newer, "descending")).toBeGreaterThan(0);
  });

  it("compares strings case-insensitively", () => {
    expect(compareSortValues("apple", "Banana", "ascending")).toBeLessThan(0);
    expect(compareSortValues("Banana", "apple", "ascending")).toBeGreaterThan(0);
    expect(compareSortValues("Apple", "apple", "ascending")).toBe(0);
  });

  it("orders booleans false before true", () => {
    expect(compareSortValues(false, true, "ascending")).toBeLessThan(0);
    expect(compareSortValues(true, false, "ascending")).toBeGreaterThan(0);
  });

  it("sorts null/undefined LAST in both directions", () => {
    // Ascending: the empty value comes after the present one.
    expect(compareSortValues(null, 5, "ascending")).toBeGreaterThan(0);
    expect(compareSortValues(5, null, "ascending")).toBeLessThan(0);
    // Descending: still after — an empty cell never floats to the top.
    expect(compareSortValues(null, 5, "descending")).toBeGreaterThan(0);
    expect(compareSortValues(5, null, "descending")).toBeLessThan(0);
    expect(compareSortValues(undefined, "x", "descending")).toBeGreaterThan(0);
    // Two empties tie.
    expect(compareSortValues(null, undefined, "ascending")).toBe(0);
  });
});

describe("nextSortState", () => {
  const start: SortState = { columnId: "created", direction: "descending" };

  it("selects a newly-clicked column ascending", () => {
    expect(nextSortState(start, "name")).toEqual({
      columnId: "name",
      direction: "ascending",
    });
  });

  it("toggles direction when the active column is re-clicked", () => {
    const asc = nextSortState(start, "created");
    expect(asc).toEqual({ columnId: "created", direction: "ascending" });
    expect(nextSortState(asc, "created")).toEqual({
      columnId: "created",
      direction: "descending",
    });
  });
});

interface Row {
  id: number;
  name: string;
  score: number | null;
}

const ROWS: Row[] = [
  { id: 1, name: "beta", score: 30 },
  { id: 2, name: "Alpha", score: null },
  { id: 3, name: "gamma", score: 10 },
];

const COLUMNS: SortColumn<Row>[] = [
  { columnId: "id", value: (r) => r.id },
  { columnId: "name", value: (r) => r.name },
  { columnId: "score", value: (r) => r.score },
];

describe("useTableSort", () => {
  it("applies the default sort on first render", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, COLUMNS, { columnId: "id", direction: "descending" }),
    );
    expect(result.current.sorted.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("toggles the active column between ascending and descending", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, COLUMNS, { columnId: "id", direction: "descending" }),
    );

    act(() => result.current.toggleSort("name"));
    // A new column starts ascending, case-insensitive: Alpha, beta, gamma.
    expect(result.current.sorted.map((r) => r.name)).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);

    act(() => result.current.toggleSort("name"));
    expect(result.current.sorted.map((r) => r.name)).toEqual([
      "gamma",
      "beta",
      "Alpha",
    ]);
  });

  it("keeps null scores last regardless of direction", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, COLUMNS, { columnId: "id", direction: "descending" }),
    );

    act(() => result.current.toggleSort("score")); // ascending
    let ids = result.current.sorted.map((r) => r.id);
    expect(ids[ids.length - 1]).toBe(2); // null score sinks to the bottom

    act(() => result.current.toggleSort("score")); // descending
    ids = result.current.sorted.map((r) => r.id);
    expect(ids[ids.length - 1]).toBe(2); // still last
  });

  it("passes rows through untouched when the sort column is unknown", () => {
    const { result } = renderHook(() =>
      useTableSort(ROWS, COLUMNS, { columnId: "missing", direction: "ascending" }),
    );
    expect(result.current.sorted).toEqual(ROWS);
  });
});

import { describe, expect, it } from "vitest";
import { cellText, filterRows, filterTerms } from "./tableFilter";

describe("filterTerms", () => {
  it("lowercases and splits on any run of whitespace", () => {
    expect(filterTerms("  Foo   BAR ")).toEqual(["foo", "bar"]);
  });

  it("treats an empty or whitespace-only query as no filter", () => {
    expect(filterTerms("")).toEqual([]);
    expect(filterTerms("   ")).toEqual([]);
  });
});

describe("cellText", () => {
  it("passes strings through and stringifies numbers/booleans", () => {
    expect(cellText("hello")).toBe("hello");
    expect(cellText(42)).toBe("42");
    expect(cellText(true)).toBe("true");
  });

  it("renders null/undefined as empty and objects as JSON", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText({ image: "ghcr.io/acme/runner" })).toBe(
      '{"image":"ghcr.io/acme/runner"}',
    );
  });
});

interface Row {
  name: string;
  count: number;
  config: Record<string, unknown>;
}

const ROWS: Row[] = [
  { name: "Alpha", count: 3, config: { image: "ghcr.io/acme/runner", tier: "gold" } },
  { name: "Beta", count: 10, config: { image: "docker.io/lib/node", tier: "silver" } },
];

const columns = (r: Row): readonly unknown[] => [r.name, r.count, r.config];

describe("filterRows", () => {
  it("returns every row unchanged for an empty query", () => {
    expect(filterRows(ROWS, "  ", columns)).toBe(ROWS);
  });

  it("matches across columns, including stringified JSON, case-insensitively", () => {
    // Found via the JSON config blob's image, not the rendered name.
    expect(filterRows(ROWS, "ACME", columns)).toEqual([ROWS[0]]);
    // Found via a numeric cell.
    expect(filterRows(ROWS, "10", columns)).toEqual([ROWS[1]]);
  });

  it("ANDs multiple terms across different columns", () => {
    // "gold" is in the config, "alpha" in the name — both must match one row.
    expect(filterRows(ROWS, "gold alpha", columns)).toEqual([ROWS[0]]);
    // No single row has both terms.
    expect(filterRows(ROWS, "gold beta", columns)).toEqual([]);
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableSearch } from "./TableSearch";

afterEach(() => {
  vi.useRealTimers();
});

describe("TableSearch", () => {
  it("debounces keystrokes before committing the query", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<TableSearch onSearch={onSearch} label="Search runs" debounceMs={300} />);

    const box = screen.getByRole("searchbox", { name: "Search runs" });
    fireEvent.change(box, { target: { value: "fo" } });
    fireEvent.change(box, { target: { value: "foo" } });

    // Nothing committed until the debounce window elapses.
    expect(onSearch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onSearch).not.toHaveBeenCalled();

    // Only the final value commits, once, after the window.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("foo");
  });

  it("commits an empty query immediately when cleared", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<TableSearch onSearch={onSearch} label="Search runs" debounceMs={300} />);

    const box = screen.getByRole("searchbox", { name: "Search runs" });
    fireEvent.change(box, { target: { value: "foo" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onSearch).toHaveBeenLastCalledWith("foo");

    // Clearing bypasses the debounce and restores the unfiltered list at once.
    act(() => {
      fireEvent.change(box, { target: { value: "" } });
    });
    expect(onSearch).toHaveBeenLastCalledWith("");
    // No stray timer fires afterward.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onSearch).toHaveBeenCalledTimes(2);
  });

  it("shows a results-count hint only while a query is active", () => {
    vi.useFakeTimers();
    render(
      <TableSearch onSearch={() => {}} label="Search runs" resultCount={3} />,
    );

    // No hint before anything is typed.
    expect(screen.queryByText("3 results")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search runs" }), {
      target: { value: "foo" },
    });
    // The committed-query state update fires from the debounce timer; flush it.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText("3 results")).toBeTruthy();
  });
});

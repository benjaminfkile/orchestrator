import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncCombobox } from "./AsyncCombobox";

afterEach(() => {
  vi.clearAllMocks();
});

describe("AsyncCombobox", () => {
  it("loads options via the injected loader and renders them", async () => {
    const load = vi
      .fn()
      .mockResolvedValue([{ value: "a", label: "Alpha" }, { value: "b" }]);
    render(<AsyncCombobox aria-label="Thing" load={load} />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    // Open the listbox, then the loaded options appear (label falls back to value).
    fireEvent.click(screen.getByRole("combobox", { name: "Thing" }));
    expect(await screen.findByRole("option", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "b" })).toBeTruthy();
  });

  it("surfaces a load error in place", async () => {
    const load = vi.fn().mockRejectedValue(new Error("boom"));
    render(<AsyncCombobox aria-label="Thing" load={load} />);

    expect(
      await screen.findByText(/Couldn't load options: boom/),
    ).toBeTruthy();
  });

  it("re-runs the loader when the refresh affordance is pressed", async () => {
    const load = vi.fn().mockResolvedValue([{ value: "a" }]);
    render(<AsyncCombobox aria-label="Thing" load={load} />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh options" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("accepts a freeform value that is not in the list (single-select)", async () => {
    const load = vi.fn().mockResolvedValue([{ value: "a", label: "Alpha" }]);
    const onChange = vi.fn();
    render(
      <AsyncCombobox aria-label="Thing" load={load} onChange={onChange} />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    const input = screen.getByRole("combobox", { name: "Thing" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "not-in-list" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith("not-in-list");
  });

  it("commits a selected option's value (single-select)", async () => {
    const load = vi.fn().mockResolvedValue([{ value: "id-1", label: "Alpha" }]);
    const onChange = vi.fn();
    render(
      <AsyncCombobox aria-label="Thing" load={load} onChange={onChange} />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("combobox", { name: "Thing" }));
    fireEvent.click(await screen.findByRole("option", { name: "Alpha" }));

    expect(onChange).toHaveBeenCalledWith("id-1");
  });

  it("adds a freeform value as a tag on Enter (multi-select)", async () => {
    const load = vi.fn().mockResolvedValue([{ value: "a", label: "Alpha" }]);
    const onChange = vi.fn();
    render(
      <AsyncCombobox
        aria-label="Things"
        multiselect
        value={[]}
        load={load}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    const input = screen.getByRole("combobox", { name: "Things" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "custom" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(["custom"]);
  });

  it("renders committed multi-select values as dismissible tags", async () => {
    const load = vi.fn().mockResolvedValue([]);
    const onChange = vi.fn();
    render(
      <AsyncCombobox
        aria-label="Things"
        multiselect
        value={["one", "two"]}
        load={load}
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Remove one"));
    expect(onChange).toHaveBeenCalledWith(["two"]);
  });

  it("calls onLoaded with the freshly-loaded options", async () => {
    const load = vi
      .fn()
      .mockResolvedValue([{ value: "a", label: "Alpha" }, { value: "b" }]);
    const onLoaded = vi.fn();
    render(
      <AsyncCombobox aria-label="Thing" load={load} onLoaded={onLoaded} />,
    );

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(onLoaded).toHaveBeenCalledWith([
      { value: "a", label: "Alpha" },
      { value: "b" },
    ]);
  });

  it("does not call onLoaded when the load fails", async () => {
    const load = vi.fn().mockRejectedValue(new Error("boom"));
    const onLoaded = vi.fn();
    render(
      <AsyncCombobox aria-label="Thing" load={load} onLoaded={onLoaded} />,
    );

    await screen.findByText(/Couldn't load options: boom/);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("does not auto-load when autoLoad is false", () => {
    const load = vi.fn().mockResolvedValue([]);
    render(<AsyncCombobox aria-label="Thing" load={load} autoLoad={false} />);
    expect(load).not.toHaveBeenCalled();
  });
});

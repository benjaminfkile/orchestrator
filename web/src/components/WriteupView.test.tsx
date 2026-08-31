import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteupView } from "./WriteupView";

const SAMPLE = [
  "# Heading one",
  "",
  "A paragraph with `inline code` and **bold**.",
  "",
  "## Section",
  "",
  "| Col A | Col B |",
  "| ----- | ----- |",
  "| cell1 | cell2 |",
  "",
  "```",
  "console.log('hello');",
  "```",
  "",
  "- [x] done task",
  "- [ ] open task",
].join("\n");

/** Grab an object with mockable clipboard helpers, restoring afterEach. */
function withClipboard(writeText: ReturnType<typeof vi.fn>) {
  const original = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return () => {
    if (original) {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: original,
      });
    } else {
      // Clear the property; the next test can install a fresh mock.
      Reflect.deleteProperty(navigator as unknown as object, "clipboard");
    }
  };
}

let restoreClipboard: (() => void) | null = null;

afterEach(() => {
  if (restoreClipboard) {
    restoreClipboard();
    restoreClipboard = null;
  }
  vi.restoreAllMocks();
});

describe("WriteupView", () => {
  it("renders markdown headings, tables, code, and task lists in the rendered view", () => {
    render(<WriteupView text={SAMPLE} />);

    const pane = screen.getByLabelText("Writeup");
    // Heading levels come out as native h1/h2 elements.
    expect(
      within(pane).getByRole("heading", { level: 1, name: "Heading one" }),
    ).toBeTruthy();
    expect(
      within(pane).getByRole("heading", { level: 2, name: "Section" }),
    ).toBeTruthy();
    // GFM tables produce a real <table>.
    const table = within(pane).getByRole("table");
    expect(within(table).getByText("Col A")).toBeTruthy();
    expect(within(table).getByText("cell1")).toBeTruthy();
    // Fenced code block renders inside <pre><code>.
    const preBlock = pane.querySelector("pre code");
    expect(preBlock?.textContent).toContain("console.log('hello');");
    // GFM task-list checkboxes render as real checkbox inputs.
    const boxes = within(pane).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("escapes raw HTML: no <script> tag reaches the DOM", () => {
    const evil = "Hello <script>window.__pwned = 1</script> world";
    render(<WriteupView text={evil} />);
    const pane = screen.getByLabelText("Writeup");
    expect(pane.querySelector("script")).toBeNull();
    // The literal source is still shown as text (react-markdown escapes it).
    expect(pane.textContent).toContain("Hello");
    expect(pane.textContent).toContain("world");
  });

  it("shows the exact original text when Raw is toggled on", () => {
    render(<WriteupView text={SAMPLE} />);
    // Rendered by default.
    expect(screen.queryByLabelText("Writeup raw")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    const raw = screen.getByLabelText("Writeup raw");
    // The RAW markdown (pipes, hashes, fences) is preserved verbatim.
    expect(raw.textContent).toBe(SAMPLE);
    // The rendered view is gone.
    expect(screen.queryByRole("table")).toBeNull();

    // Flip back to rendered: raw pane disappears, table reappears.
    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));
    expect(screen.queryByLabelText("Writeup raw")).toBeNull();
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("writes the raw markdown to the clipboard and shows a confirmation", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    restoreClipboard = withClipboard(writeText);

    render(<WriteupView text={SAMPLE} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // The clipboard receives the RAW markdown source, unchanged.
    expect(writeText).toHaveBeenCalledWith(SAMPLE);

    // The visible confirmation appears; a later assertion below exercises the
    // execCommand fallback branch, so we do not also spin the wall clock here.
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("copies the raw text even when the rendered view is showing", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    restoreClipboard = withClipboard(writeText);

    render(<WriteupView text={"# Heading\n\nBody"} />);
    // In rendered mode, the heading is DOM-level; the toolbar copy button still
    // sends the RAW markdown source.
    expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Heading\n\nBody"));
  });

  it("falls back to execCommand when the async clipboard API is unavailable", async () => {
    // Simulate an insecure context: no navigator.clipboard at all.
    restoreClipboard = withClipboard(undefined as never);
    Reflect.deleteProperty(navigator as unknown as object, "clipboard");

    const exec = vi.fn(() => true);
    const originalExec = document.execCommand;
    document.execCommand = exec as unknown as typeof document.execCommand;

    render(<WriteupView text={"raw source"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));

    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    expect(await screen.findByText("Copied")).toBeTruthy();

    document.execCommand = originalExec;
  });

  it("renders the empty placeholder when text is empty or null", () => {
    const { rerender } = render(<WriteupView text="" />);
    expect(screen.getByText("No result text.")).toBeTruthy();
    // No toolbar (no toggle, no copy button) when there is nothing to show.
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy markdown" })).toBeNull();

    rerender(<WriteupView text={null} />);
    expect(screen.getByText("No result text.")).toBeTruthy();
  });

  it("honors a custom empty message", () => {
    render(<WriteupView text="" emptyText="Nothing to show." />);
    expect(screen.getByText("Nothing to show.")).toBeTruthy();
  });
});

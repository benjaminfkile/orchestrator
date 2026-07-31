import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listEvents, type EventRecord } from "../events";
import { getEventSources, getEventTypes } from "../discovery";
import { EventsPage } from "./EventsPage";

// Mock the data layer wholesale; the page's only input is `listEvents`.
vi.mock("../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../events")>()),
  listEvents: vi.fn(),
}));

// The Source/Type filters are facet-fed comboboxes; stub the discovery loaders.
vi.mock("../discovery", () => ({
  getEventSources: vi.fn(),
  getEventTypes: vi.fn(),
}));
// The page registers a live-refetch subscription that requires a ChangesProvider
// in the tree. These unit tests render the page bare, so stub the hook to a
// no-op; the live-stream wiring is covered by useLiveRefetch.test.tsx.
vi.mock("../components/useLiveRefetch", () => ({
  useLiveRefetch: vi.fn(),
}));

const mockListEvents = vi.mocked(listEvents);
const mockGetEventSources = vi.mocked(getEventSources);
const mockGetEventTypes = vi.mocked(getEventTypes);

/** Commit a freeform value into a filter combobox (typing only applies on blur). */
function setFilter(name: string, value: string) {
  const input = screen.getByRole("combobox", { name });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function event(overrides: Partial<EventRecord> & Pick<EventRecord, "id">): EventRecord {
  return {
    source: "ado",
    type: "work_item.updated",
    subject_kind: "work_item",
    subject_ref: "42",
    payload: null,
    dedupe_key: null,
    ts: 1_700_000_000_000,
    last_dispatched_at: null,
    cleared_at: null,
    ...overrides,
  };
}

const EVENTS: EventRecord[] = [
  event({
    id: 3,
    source: "ado",
    type: "work_item.updated",
    subject_ref: "300",
    payload: { title: "gamma", state: "Active" },
    dedupe_key: "ado:300",
    last_dispatched_at: 1_700_000_500_000,
  }),
  event({ id: 2, source: "github", type: "pull_request.opened", subject_ref: "200" }),
  event({
    id: 1,
    source: "ado",
    type: "work_item.created",
    subject_ref: "100",
    cleared_at: 1_700_000_900_000,
  }),
];

beforeEach(() => {
  mockListEvents.mockResolvedValue(EVENTS);
  mockGetEventSources.mockResolvedValue(["ado", "github"]);
  mockGetEventTypes.mockResolvedValue([
    "pull_request.opened",
    "work_item.created",
    "work_item.updated",
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("EventsPage", () => {
  it("renders a row per event newest-first with source, type, subject, and ts", async () => {
    render(<EventsPage />);
    const table = await screen.findByRole("table", { name: "Events" });

    const rows = within(table).getAllByRole("row");
    // First row is the header; data rows follow in load order (newest-first).
    const first = within(rows[1]).getAllByRole("cell");
    expect(first[1].textContent).toBe("ado");
    expect(first[2].textContent).toBe("work_item.updated");
    expect(first[3].textContent).toBe("300");

    expect(within(table).getByText("pull_request.opened")).toBeTruthy();
    expect(within(table).getByText("work_item.created")).toBeTruthy();
  });

  it("wraps the table in a horizontally scrollable container", async () => {
    render(<EventsPage />);
    const table = await screen.findByRole("table", { name: "Events" });
    const wrap = table.parentElement as HTMLElement;
    expect(getComputedStyle(wrap).overflowX).toBe("auto");
  });

  it("expands a row to reveal pretty-printed payload and lifecycle indicators", async () => {
    render(<EventsPage />);
    await screen.findByRole("table", { name: "Events" });

    // No detail before expanding.
    expect(screen.queryByLabelText("Payload")).toBeNull();

    fireEvent.click(screen.getByText("pull_request.opened"));
    // The github event (id 2) has no dedupe key, is not cleared, never dispatched.
    expect(screen.getByLabelText("Payload").textContent).toBe("null");
    expect(screen.getByText("no dedupe key")).toBeTruthy();
    expect(screen.getByText("not cleared")).toBeTruthy();
    expect(screen.getByText("never dispatched")).toBeTruthy();
  });

  it("pretty-prints object payloads and surfaces dedupe/dispatch indicators", async () => {
    render(<EventsPage />);
    await screen.findByRole("table", { name: "Events" });

    fireEvent.click(screen.getByText("work_item.updated"));
    const payload = screen.getByLabelText("Payload");
    expect(payload.textContent).toContain('"title": "gamma"');
    expect(payload.textContent).toContain('"state": "Active"');
    expect(screen.getByText("dedupe: ado:300")).toBeTruthy();
    expect(screen.getByText(/last dispatched/)).toBeTruthy();
  });

  it("collapses an expanded row when toggled again", async () => {
    render(<EventsPage />);
    await screen.findByRole("table", { name: "Events" });

    fireEvent.click(screen.getByText("pull_request.opened"));
    expect(screen.getByLabelText("Payload")).toBeTruthy();

    fireEvent.click(screen.getByText("pull_request.opened"));
    expect(screen.queryByLabelText("Payload")).toBeNull();
  });

  it("filters by source (case-insensitive substring), freeform preserved", async () => {
    render(<EventsPage />);
    const table = await screen.findByRole("table", { name: "Events" });

    setFilter("Source", "GIT");

    expect(within(table).getByText("pull_request.opened")).toBeTruthy();
    expect(within(table).queryByText("work_item.updated")).toBeNull();
    expect(within(table).queryByText("work_item.created")).toBeNull();
  });

  it("suggests known sources from the facets endpoint", async () => {
    render(<EventsPage />);
    await screen.findByRole("table", { name: "Events" });
    await waitFor(() => expect(mockGetEventSources).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("combobox", { name: "Source" }));
    expect(await screen.findByRole("option", { name: "github" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "ado" })).toBeTruthy();
  });

  it("filters by type prefix", async () => {
    render(<EventsPage />);
    const table = await screen.findByRole("table", { name: "Events" });

    setFilter("Type prefix", "work_item.");
    expect(within(table).getByText("work_item.updated")).toBeTruthy();
    expect(within(table).getByText("work_item.created")).toBeTruthy();
    expect(within(table).queryByText("pull_request.opened")).toBeNull();

    // A more specific prefix narrows further.
    setFilter("Type prefix", "work_item.created");
    expect(within(table).getByText("work_item.created")).toBeTruthy();
    expect(within(table).queryByText("work_item.updated")).toBeNull();
  });

  it("shows an empty state when filters match nothing", async () => {
    render(<EventsPage />);
    await screen.findByRole("table", { name: "Events" });

    setFilter("Source", "nope");
    expect(screen.queryByRole("table", { name: "Events" })).toBeNull();
    expect(screen.getByText("No events to show.")).toBeTruthy();
  });

  it("loads the next page from the cursor and appends it", async () => {
    // A full first page enables Load more; the second page returns the tail.
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      event({ id: 100 - i, type: `page1.${i}`, subject_ref: String(100 - i) }),
    );
    mockListEvents.mockReset();
    mockListEvents.mockResolvedValueOnce(firstPage);
    mockListEvents.mockResolvedValueOnce([
      event({ id: 50, type: "page2.older", subject_ref: "50" }),
    ]);

    render(<EventsPage />);
    await screen.findByRole("table", { name: "Events" });
    expect(mockListEvents).toHaveBeenCalledWith({ limit: 50, q: "" });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    // The oldest loaded id (51) becomes the cursor for the next page.
    await waitFor(() =>
      expect(mockListEvents).toHaveBeenCalledWith({
        limit: 50,
        before: 51,
        q: "",
      }),
    );
    await screen.findByText("page2.older");

    // The short second page hides Load more (no further pages).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull(),
    );
  });

  it("does not show Load more when the first page is short", async () => {
    render(<EventsPage />);
    await screen.findByRole("table", { name: "Events" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("surfaces a load error", async () => {
    mockListEvents.mockReset();
    mockListEvents.mockRejectedValueOnce(new Error("boom"));

    render(<EventsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});

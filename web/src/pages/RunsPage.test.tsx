import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDispatch,
  listPlaybooks,
  listRuns,
  rerunDispatch,
  retryDispatch,
  type Dispatch,
  type DispatchDetail,
  type RunHistoryEntry,
} from "../dispatches";
import { RunsPage } from "./RunsPage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../dispatches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dispatches")>()),
  listRuns: vi.fn(),
  listPlaybooks: vi.fn(),
  rerunDispatch: vi.fn(),
  retryDispatch: vi.fn(),
  getDispatch: vi.fn(),
}));

const mockListRuns = vi.mocked(listRuns);
const mockListPlaybooks = vi.mocked(listPlaybooks);
const mockRerunDispatch = vi.mocked(rerunDispatch);
const mockRetryDispatch = vi.mocked(retryDispatch);
const mockGetDispatch = vi.mocked(getDispatch);

function run(
  overrides: Partial<RunHistoryEntry> & Pick<RunHistoryEntry, "dispatch_id">,
): RunHistoryEntry {
  return {
    playbook_id: 0,
    status: "done",
    created_at: 1_700_000_000_000,
    ended_at: 1_700_000_005_000,
    duration_ms: 5000,
    exit_code: 0,
    total_tokens: 1234,
    findings_count: 0,
    error: null,
    subject_kind: null,
    subject_ref: null,
    event_type: null,
    subject_title: null,
    subject_url: null,
    subject_type: null,
    ...overrides,
  };
}

const RUNS: RunHistoryEntry[] = [
  run({
    dispatch_id: 3,
    playbook_id: 100,
    status: "done",
    findings_count: 2,
    subject_kind: "workitem",
    subject_ref: "42",
    event_type: "workitem.updated",
    subject_title: "Fix the widget",
    subject_url: "https://example.test/wi/42",
  }),
  run({
    dispatch_id: 2,
    playbook_id: 101,
    status: "failed",
    exit_code: 1,
    total_tokens: null,
    duration_ms: null,
    error: "lease timed out waiting for capacity",
    // No title/url in the payload: falls back to "<kind> <ref>".
    subject_kind: "workitem",
    subject_ref: "7",
  }),
  run({ dispatch_id: 1, playbook_id: 100, status: "running" }),
];

const PLAYBOOKS = [
  { id: 100, name: "Researcher" },
  { id: 101, name: "Reviewer" },
];

/** Surfaces the `/runs/:id` route param so navigation is observable in tests. */
function RunsMarker() {
  const { id } = useParams();
  return <div>runs-detail:{id}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/runs"]}>
      <Routes>
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunsMarker />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockListRuns.mockResolvedValue(RUNS);
  mockListPlaybooks.mockResolvedValue(PLAYBOOKS);
  mockRerunDispatch.mockResolvedValue({ id: 99, status: "queued" } as Dispatch);
  mockRetryDispatch.mockResolvedValue({ id: 2, status: "queued" } as Dispatch);
  mockGetDispatch.mockResolvedValue({
    id: 3,
    event_id: 55,
    playbook_id: 100,
    runs: [],
  } as unknown as DispatchDetail);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("RunsPage", () => {
  it("renders a row per run with the joined playbook name and outcome", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    // The failed row shows the truncated error text as its outcome.
    const failed = within(table).getByText("Reviewer").closest("tr")!;
    const cells = within(failed).getAllByRole("cell");
    expect(cells[0].textContent).toBe("Reviewer"); // playbook name
    expect(cells[1].textContent).toBe("workitem 7"); // subject fallback
    expect(within(cells[2]).getByText("failed")).toBeTruthy(); // status badge
    expect(cells[5].textContent).toBe(""); // tokens blank when null
    expect(cells[7].textContent).toContain("lease timed out"); // error outcome

    // A successful row joins its name and shows exit code + token total.
    const done = within(table).getAllByText("Researcher")[0].closest("tr")!;
    const doneCells = within(done).getAllByRole("cell");
    expect(doneCells[5].textContent).toBe("1,234"); // tokens
    expect(doneCells[6].textContent).toBe("2"); // findings count
    expect(doneCells[7].textContent).toBe("exit 0"); // outcome
  });

  it("shows the subject title as an external link when a url is present", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    const link = within(table).getByRole("link", { name: "Fix the widget" });
    expect(link.getAttribute("href")).toBe("https://example.test/wi/42");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("falls back to '<kind> <ref>' with no link when the payload has no title", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    const fallback = within(table).getByText("workitem 7");
    expect(fallback.closest("a")).toBeNull();
  });

  it("clicking the subject link does not navigate to the detail route", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    fireEvent.click(within(table).getByRole("link", { name: "Fix the widget" }));
    expect(screen.queryByText("runs-detail:3")).toBeNull();
  });

  it("wraps the table in a horizontally scrollable container", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });
    const wrap = table.parentElement as HTMLElement;
    expect(getComputedStyle(wrap).overflowX).toBe("auto");
  });

  it("filters by status through the query", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Run history" });
    expect(mockListRuns).toHaveBeenLastCalledWith({ status: undefined, q: "" });

    mockListRuns.mockResolvedValueOnce([RUNS[1]]);
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "failed" },
    });

    await waitFor(() =>
      expect(mockListRuns).toHaveBeenLastCalledWith({ status: "failed", q: "" }),
    );
    const table = screen.getByRole("table", { name: "Run history" });
    await waitFor(() =>
      expect(within(table).queryByText("Researcher")).toBeNull(),
    );
    expect(within(table).getByText("Reviewer")).toBeTruthy();
  });

  it("navigates to the runs detail route when a row is clicked", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    fireEvent.click(within(table).getByText("Reviewer"));
    expect(screen.getByText("runs-detail:2")).toBeTruthy();
  });

  it("re-runs a history row without navigating away", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    // The failed "Reviewer" row is dispatch 2.
    const row = within(table).getByText("Reviewer").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Re-run" }));

    await waitFor(() => expect(mockRerunDispatch).toHaveBeenCalledWith(2));
    expect(screen.queryByText(/^runs-detail:/)).toBeNull();
    expect(await screen.findByText(/Dispatch #99 created/)).toBeTruthy();
  });

  it("offers Retry only on failed rows and requeues the same dispatch", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    // Exactly one failed row (dispatch 2), so exactly one Retry button.
    const retry = within(table).getAllByRole("button", { name: "Retry" });
    expect(retry).toHaveLength(1);

    const failed = within(table).getByText("Reviewer").closest("tr")!;
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(mockRetryDispatch).toHaveBeenCalledWith(2));
    expect(screen.queryByText(/^runs-detail:/)).toBeNull();
    expect(await screen.findByText(/Dispatch #2 requeued/)).toBeTruthy();
  });

  it("resolves a row's event, then opens the manual-run dialog", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    const row = within(table).getByText("Reviewer").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Run playbook" }));

    // The event id is resolved from the dispatch record before the dialog opens.
    await waitFor(() => expect(mockGetDispatch).toHaveBeenCalledWith(2));
    expect(await screen.findByText("Dispatch playbook")).toBeTruthy();
    expect(screen.queryByText(/^runs-detail:/)).toBeNull();
  });

  it("sorts rows by a clicked column and toggles direction, with an aria-sort indicator", async () => {
    mockListRuns.mockResolvedValue([
      run({ dispatch_id: 1, playbook_id: 100, findings_count: 5 }),
      run({ dispatch_id: 2, playbook_id: 101, findings_count: 1 }),
      run({ dispatch_id: 3, playbook_id: 100, findings_count: 9 }),
    ]);
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    // Findings is the 7th column (index 6). Read it out of every body row.
    const findingsOrder = () =>
      within(table)
        .getAllByRole("row")
        .slice(1) // drop the header row
        .map((row) => within(row).getAllByRole("cell")[6].textContent);

    const header = within(table).getByRole("columnheader", { name: /Findings/ });

    // First click → ascending, and the header advertises the active direction.
    fireEvent.click(header);
    await waitFor(() => expect(findingsOrder()).toEqual(["1", "5", "9"]));
    expect(header.getAttribute("aria-sort")).toBe("ascending");

    // Re-click the same column → descending.
    fireEvent.click(header);
    await waitFor(() => expect(findingsOrder()).toEqual(["9", "5", "1"]));
    expect(header.getAttribute("aria-sort")).toBe("descending");
  });

  it("defaults to the backend's newest-first ordering before any click", async () => {
    // Distinct start times so the default Started-descending sort is observable.
    mockListRuns.mockResolvedValue([
      run({ dispatch_id: 7, playbook_id: 100, created_at: 3000 }),
      run({ dispatch_id: 8, playbook_id: 101, created_at: 1000 }),
      run({ dispatch_id: 9, playbook_id: 100, created_at: 2000 }),
    ]);
    renderPage();
    const table = await screen.findByRole("table", { name: "Run history" });

    // Started is the 4th column (index 3); newest first means 3000, 2000, 1000.
    const startedCells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[3].textContent);
    expect(startedCells).toEqual([
      new Date(3000).toLocaleString(),
      new Date(2000).toLocaleString(),
      new Date(1000).toLocaleString(),
    ]);
  });

  it("shows the empty state when there are no runs", async () => {
    mockListRuns.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("No runs yet.")).toBeTruthy();
  });

  it("passes the search query to the data layer and clearing restores the list", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Run history" });
    expect(mockListRuns).toHaveBeenLastCalledWith({ status: undefined, q: "" });

    // Typing a query commits (debounced) and re-queries with q.
    mockListRuns.mockResolvedValueOnce([RUNS[1]]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search runs" }), {
      target: { value: "lease" },
    });
    await waitFor(() =>
      expect(mockListRuns).toHaveBeenLastCalledWith({
        status: undefined,
        q: "lease",
      }),
    );

    // Clearing the box restores the unfiltered list immediately.
    mockListRuns.mockResolvedValueOnce(RUNS);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search runs" }), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(mockListRuns).toHaveBeenLastCalledWith({ status: undefined, q: "" }),
    );
  });

  it("auto-refreshes every 5s and stops when paused", async () => {
    vi.useFakeTimers();
    renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockListRuns).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockListRuns).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("switch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mockListRuns).toHaveBeenCalledTimes(2);
  });
});

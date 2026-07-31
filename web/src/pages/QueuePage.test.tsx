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
import { ApiError } from "../api";
import {
  createDispatch,
  listDispatches,
  listEvents,
  listPlaybooks,
  type Dispatch,
} from "../dispatches";
import { QueuePage } from "./QueuePage";

// Mock the data layer wholesale; the page's only inputs are these calls.
vi.mock("../dispatches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dispatches")>()),
  listDispatches: vi.fn(),
  listEvents: vi.fn(),
  listPlaybooks: vi.fn(),
  createDispatch: vi.fn(),
}));
// The page registers a live-refetch subscription that requires a ChangesProvider
// in the tree. These unit tests render the page bare, so stub the hook to a
// no-op; the live-stream wiring is covered by useLiveRefetch.test.tsx.
vi.mock("../components/useLiveRefetch", () => ({
  useLiveRefetch: vi.fn(),
}));

const mockListDispatches = vi.mocked(listDispatches);
const mockListEvents = vi.mocked(listEvents);
const mockListPlaybooks = vi.mocked(listPlaybooks);
const mockCreateDispatch = vi.mocked(createDispatch);

function dispatch(overrides: Partial<Dispatch> & Pick<Dispatch, "id">): Dispatch {
  return {
    event_id: 0,
    rule_id: null,
    playbook_id: 0,
    status: "queued",
    lease_id: null,
    wisp_contract_id: null,
    attempts: 0,
    error: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

// The Queue fetches `active=1`, so its data is only ever non-terminal work; the
// fixture mirrors that (no done/failed rows — those live on the Runs page).
const DISPATCHES: Dispatch[] = [
  dispatch({
    id: 1,
    event_id: 10,
    playbook_id: 100,
    status: "running",
    attempts: 1,
    subject_kind: "workitem",
    subject_ref: "42",
    subject_title: "Fix the widget",
    subject_url: "https://example.test/wi/42",
  }),
  dispatch({
    id: 2,
    event_id: 11,
    playbook_id: 101,
    status: "leasing",
    attempts: 2,
    // No title/url: falls back to "<kind> <ref>".
    subject_kind: "workitem",
    subject_ref: "7",
  }),
  dispatch({ id: 3, event_id: 12, playbook_id: 100, status: "queued", attempts: 1 }),
];

const EVENTS = [
  { id: 10, type: "alpha" },
  { id: 11, type: "beta" },
  { id: 12, type: "gamma" },
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
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<QueuePage />} />
        <Route path="/runs/:id" element={<RunsMarker />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockListDispatches.mockResolvedValue(DISPATCHES);
  mockListEvents.mockResolvedValue(EVENTS);
  mockListPlaybooks.mockResolvedValue(PLAYBOOKS);
  mockCreateDispatch.mockResolvedValue(
    dispatch({ id: 99, event_id: 10, playbook_id: 100, status: "queued" }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("QueuePage", () => {
  it("renders a row per dispatch with resolved event type and playbook name", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Dispatch queue" });

    const row = within(table).getByText("beta").closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[0].textContent).toBe("2"); // id
    expect(cells[1].textContent).toBe("beta"); // event type
    expect(cells[2].textContent).toBe("workitem 7"); // subject fallback
    expect(cells[3].textContent).toBe("Reviewer"); // playbook name
    expect(within(cells[4]).getByText("leasing")).toBeTruthy(); // status badge
    expect(cells[5].textContent).toBe("2"); // attempts

    // The other rows resolve their labels too.
    expect(within(table).getByText("alpha")).toBeTruthy();
    expect(within(table).getByText("gamma")).toBeTruthy();
  });

  it("shows the subject as an external link when the payload carried a url", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Dispatch queue" });

    const link = within(table).getByRole("link", { name: "Fix the widget" });
    expect(link.getAttribute("href")).toBe("https://example.test/wi/42");
    expect(link.getAttribute("target")).toBe("_blank");

    // A dispatch whose payload lacked a title/url still renders identifiably.
    expect(within(table).getByText("workitem 7")).toBeTruthy();
  });

  it("wraps the table in a horizontally scrollable container", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Dispatch queue" });
    const wrap = table.parentElement as HTMLElement;
    expect(getComputedStyle(wrap).overflowX).toBe("auto");
  });

  it("fetches only active dispatches (the queue is not a history)", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Dispatch queue" });
    expect(mockListDispatches).toHaveBeenCalledWith({ active: true, q: "" });
  });

  it("shows counts-by-status tiles over the non-terminal states only", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Dispatch queue" });

    const tiles = screen.getByRole("group", { name: "Status counts" });
    expect(within(within(tiles).getByLabelText("running count")).getByText("1")).toBeTruthy();
    expect(within(within(tiles).getByLabelText("leasing count")).getByText("1")).toBeTruthy();
    expect(within(within(tiles).getByLabelText("queued count")).getByText("1")).toBeTruthy();
    expect(within(within(tiles).getByLabelText("collecting count")).getByText("0")).toBeTruthy();
    // Terminal states have no tile — they belong to the Runs page.
    expect(within(tiles).queryByLabelText("done count")).toBeNull();
    expect(within(tiles).queryByLabelText("failed count")).toBeNull();
  });

  it("filters the table by status", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Dispatch queue" });
    expect(within(table).getByText("alpha")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "leasing" },
    });

    expect(within(table).queryByText("alpha")).toBeNull(); // running row hidden
    expect(within(table).getByText("beta")).toBeTruthy(); // leasing row kept
    expect(within(table).queryByText("gamma")).toBeNull(); // queued row hidden
  });

  it("shows the queue-empty copy pointing to the Runs page when empty", async () => {
    mockListDispatches.mockResolvedValue([]);
    renderPage();
    // The table never appears; the empty state does.
    expect(await screen.findByText(/The queue is empty/)).toBeTruthy();
    expect(screen.getByText(/Runs page/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Dispatch queue" })).toBeNull();
  });

  it("offers no Retry action (failed work is retried from the Runs page)", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Dispatch queue" });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("re-runs a dispatch from a row action against the same event + playbook", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Dispatch queue" });

    // The running row (event 10 / playbook 100) re-runs with those same ids.
    const row = within(table).getByText("alpha").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Re-run" }));

    await waitFor(() =>
      expect(mockCreateDispatch).toHaveBeenCalledWith(10, 100),
    );
    // Re-running does not navigate away from the queue.
    expect(screen.queryByText(/^runs-detail:/)).toBeNull();
    expect(await screen.findByText(/Dispatch #99 created/)).toBeTruthy();
  });

  it("opens the manual-run dialog against a row's existing event", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Dispatch queue" });

    const row = within(table).getByText("alpha").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Run playbook" }));

    // The event-mode dialog opens (its title differs from the search-mode one)
    // and never materializes a work item — it dispatches against event 10.
    expect(await screen.findByText("Dispatch playbook")).toBeTruthy();
    expect(screen.queryByText(/^runs-detail:/)).toBeNull();
  });

  it("surfaces a re-run failure without leaving the page", async () => {
    mockCreateDispatch.mockRejectedValueOnce(new ApiError("boom", 500));
    renderPage();
    const table = await screen.findByRole("table", { name: "Dispatch queue" });

    const row = within(table).getByText("alpha").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Re-run" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(screen.queryByText(/^runs-detail:/)).toBeNull();
  });

  it("navigates to the runs detail route when a row is clicked", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Dispatch queue" });

    fireEvent.click(screen.getByText("alpha"));
    expect(screen.getByText("runs-detail:1")).toBeTruthy();
  });

  it("auto-refreshes every 5s and stops when paused", async () => {
    vi.useFakeTimers();
    renderPage();
    // Flush the initial (non-timer) load.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockListDispatches).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockListDispatches).toHaveBeenCalledTimes(2);

    // Pause: no further polling.
    fireEvent.click(screen.getByRole("switch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mockListDispatches).toHaveBeenCalledTimes(2);
  });
});

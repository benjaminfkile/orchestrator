import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import {
  getDispatch,
  getEvent,
  getPlaybook,
  streamDispatchLog,
  type DispatchDetail,
  type DispatchStatus,
  type Run,
} from "../dispatches";
import { RunDetailPage } from "./RunDetailPage";

// Mock the data layer wholesale; the page's only inputs are these four calls.
vi.mock("../dispatches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dispatches")>()),
  getDispatch: vi.fn(),
  getEvent: vi.fn(),
  getPlaybook: vi.fn(),
  streamDispatchLog: vi.fn(),
}));

const mockGetDispatch = vi.mocked(getDispatch);
const mockGetEvent = vi.mocked(getEvent);
const mockGetPlaybook = vi.mocked(getPlaybook);
const mockStream = vi.mocked(streamDispatchLog);

/** The latest `onChunk` handed to the mocked stream, so tests can push log data. */
let logSink: ((text: string) => void) | null = null;

function run(overrides: Partial<Run> & Pick<Run, "id">): Run {
  return {
    dispatch_id: 1,
    exit_code: null,
    result_text: null,
    usage: null,
    collected: null,
    log_path: null,
    started_at: 1_700_000_100_000,
    ended_at: null,
    findings: [],
    ...overrides,
  };
}

function dispatch(
  status: DispatchStatus,
  runs: Run[] = [],
  subject: Partial<DispatchDetail> = {},
): DispatchDetail {
  return {
    id: 1,
    event_id: 10,
    rule_id: 5,
    playbook_id: 100,
    status,
    lease_id: null,
    wisp_contract_id: null,
    attempts: 1,
    error: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_200_000,
    subject_kind: "workitem",
    subject_ref: "42",
    event_type: "workitem.updated",
    subject_title: "Fix the widget",
    subject_url: "https://example.test/wi/42",
    runs,
    ...subject,
  };
}

const EVENT = {
  id: 10,
  source: "ado",
  type: "workitem.updated",
  subject_kind: "workitem",
  subject_ref: "42",
  payload: { foo: "bar" },
  ts: 1_699_999_000_000,
};

const PLAYBOOK = {
  id: 100,
  name: "Researcher",
  image: "ghcr.io/acme/researcher:latest",
  runner: "claude-code",
  output_kind: "findings",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/runs/1"]}>
      <Routes>
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/events" element={<div>events-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Give the log pane deterministic scroll geometry for auto-scroll assertions. */
function stubGeometry(pane: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(pane, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(pane, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

beforeEach(() => {
  logSink = null;
  mockGetEvent.mockResolvedValue(EVENT);
  mockGetPlaybook.mockResolvedValue(PLAYBOOK);
  // Default: an open stream that stays live so tests can push chunks at will.
  mockStream.mockImplementation((_id, opts) => {
    logSink = opts.onChunk;
    return new Promise<void>(() => {});
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RunDetailPage", () => {
  it("renders the status timeline with the current stage active", async () => {
    mockGetDispatch.mockResolvedValue(
      dispatch("running", [run({ id: 1 })]),
    );
    renderPage();

    const timeline = await screen.findByRole("list", { name: "Status timeline" });
    const items = within(timeline).getAllByRole("listitem");
    // queued, leasing, running, collecting, completed
    expect(items).toHaveLength(5);

    const running = items[2];
    expect(within(running).getByText("running")).toBeTruthy();
    expect(within(running).getByText("active")).toBeTruthy();
    // Earlier stages are done, later ones pending.
    expect(within(items[0]).getByText("done")).toBeTruthy();
    expect(within(items[1]).getByText("done")).toBeTruthy();
    expect(within(items[3]).getByText("pending")).toBeTruthy();
  });

  it("marks the terminal row failed when the dispatch failed", async () => {
    mockGetDispatch.mockResolvedValue(
      dispatch("failed", [run({ id: 1, ended_at: 1_700_000_300_000 })]),
    );
    renderPage();

    const timeline = await screen.findByRole("list", { name: "Status timeline" });
    const items = within(timeline).getAllByRole("listitem");
    const terminal = items[items.length - 1];
    // Both the stage label and its state badge read "failed".
    expect(within(terminal).getAllByText("failed")).toHaveLength(2);
  });

  it("shows the playbook and triggering-event summary cards", async () => {
    mockGetDispatch.mockResolvedValue(dispatch("running", [run({ id: 1 })]));
    renderPage();

    expect(await screen.findByText("Researcher")).toBeTruthy();
    expect(await screen.findByText("workitem.updated")).toBeTruthy();
    expect(screen.getByText("ado")).toBeTruthy();
    // The event card links to the Events page.
    const link = screen.getByRole("link", { name: "View events" });
    expect(link.getAttribute("href")).toBe("/events");
  });

  it("shows the triggering subject as an external link on the detail card", async () => {
    mockGetDispatch.mockResolvedValue(dispatch("running", [run({ id: 1 })]));
    renderPage();

    const subject = await screen.findByRole("link", { name: "Fix the widget" });
    expect(subject.getAttribute("href")).toBe("https://example.test/wi/42");
    expect(subject.getAttribute("target")).toBe("_blank");
  });

  it("falls back to '<kind> <ref>' on the detail card when the payload had no title", async () => {
    mockGetDispatch.mockResolvedValue(
      dispatch("running", [run({ id: 1 })], {
        subject_title: null,
        subject_url: null,
      }),
    );
    renderPage();

    // The linked title is gone; the generic fallback identifies the subject.
    expect(await screen.findByText("workitem 42")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Fix the widget" })).toBeNull();
  });

  it("streams log chunks into the pane and auto-scrolls to the bottom", async () => {
    mockGetDispatch.mockResolvedValue(dispatch("running", [run({ id: 1 })]));
    renderPage();

    const pane = await screen.findByLabelText("Log output");
    stubGeometry(pane, 1000, 200);

    act(() => logSink?.("first line\n"));
    act(() => logSink?.("second line\n"));

    expect(pane.textContent).toContain("first line");
    expect(pane.textContent).toContain("second line");
    // Auto-scroll pinned the pane to the bottom.
    expect(pane.scrollTop).toBe(1000);
    expect(screen.getByText("Auto-scrolling")).toBeTruthy();
  });

  it("pauses auto-scroll when the user scrolls up and resumes at the bottom", async () => {
    mockGetDispatch.mockResolvedValue(dispatch("running", [run({ id: 1 })]));
    renderPage();

    const pane = await screen.findByLabelText("Log output");
    stubGeometry(pane, 1000, 200);

    act(() => logSink?.("line one\n"));
    expect(pane.scrollTop).toBe(1000);

    // User scrolls up: distance from bottom exceeds the threshold → pause.
    pane.scrollTop = 100;
    fireEvent.scroll(pane);
    expect(screen.getByText("Scroll paused")).toBeTruthy();

    // A new chunk must NOT yank the view back to the bottom while paused.
    act(() => logSink?.("line two\n"));
    expect(pane.scrollTop).toBe(100);

    // Scrolling back near the bottom re-engages auto-scroll.
    pane.scrollTop = 795;
    fireEvent.scroll(pane);
    expect(screen.getByText("Auto-scrolling")).toBeTruthy();
    expect(pane.scrollTop).toBe(1000);
  });

  it("renders result, findings, and token usage once the run completes", async () => {
    mockGetDispatch.mockResolvedValue(
      dispatch("done", [
        run({
          id: 7,
          exit_code: 0,
          result_text: "All checks passed.",
          ended_at: 1_700_000_300_000,
          usage: {
            input_tokens: 1200,
            output_tokens: 340,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 512,
          },
          findings: [
            {
              id: 1,
              run_id: 7,
              content: "Something noteworthy",
              tags: ["security", "high"],
              visibility: "all",
            },
          ],
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByLabelText("Result text")).toHaveProperty(
      "textContent",
      "All checks passed.",
    );

    const findings = screen.getByLabelText("Findings");
    expect(within(findings).getByText("Something noteworthy")).toBeTruthy();
    expect(within(findings).getByText("security")).toBeTruthy();
    expect(within(findings).getByText("high")).toBeTruthy();
    expect(within(findings).getByText("all")).toBeTruthy();

    const usage = screen.getByRole("table", { name: "Token usage" });
    const rows = within(usage).getAllByRole("row");
    // Header + four counter rows.
    expect(rows).toHaveLength(5);
    expect(within(usage).getByText("1,200")).toBeTruthy();
    expect(within(usage).getByText("340")).toBeTruthy();
    expect(within(usage).getByText("512")).toBeTruthy();

    // The usage table scrolls within its own container, not the page.
    const wrap = usage.parentElement as HTMLElement;
    expect(getComputedStyle(wrap).overflowX).toBe("auto");
  });

  it("does not render completed panels while the run is in flight", async () => {
    mockGetDispatch.mockResolvedValue(dispatch("running", [run({ id: 1 })]));
    renderPage();

    await screen.findByRole("list", { name: "Status timeline" });
    expect(screen.queryByRole("table", { name: "Token usage" })).toBeNull();
    expect(screen.queryByLabelText("Result text")).toBeNull();
  });

  it("shows a not-found message when the dispatch is missing", async () => {
    mockGetDispatch.mockRejectedValue(new ApiError("dispatch not found", 404));
    renderPage();

    expect(await screen.findByText("Dispatch not found.")).toBeTruthy();
  });

  it("surfaces a log stream error", async () => {
    mockGetDispatch.mockResolvedValue(dispatch("running", [run({ id: 1 })]));
    mockStream.mockRejectedValue(new ApiError("boom", 500));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});

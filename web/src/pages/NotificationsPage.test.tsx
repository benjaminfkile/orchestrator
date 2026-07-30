import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  subscribeNotificationStream,
  type NotificationRecord,
} from "../notifications";
import { getEvent } from "../dispatches";
import { ApiError } from "../api";
import { NotificationsProvider } from "../components/NotificationsProvider";
import { NotificationsPage } from "./NotificationsPage";

// Mock the data + stream layer wholesale; the page and its provider read only
// from these calls.
vi.mock("../notifications", () => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  getUnreadCount: vi.fn(),
  subscribeNotificationStream: vi.fn(),
}));

// The click handler resolves the triggering event through this single call.
vi.mock("../dispatches", () => ({
  getEvent: vi.fn(),
}));

const mockList = vi.mocked(listNotifications);
const mockMarkRead = vi.mocked(markNotificationRead);
const mockMarkAll = vi.mocked(markAllNotificationsRead);
const mockUnreadCount = vi.mocked(getUnreadCount);
const mockSubscribe = vi.mocked(subscribeNotificationStream);
const mockGetEvent = vi.mocked(getEvent);

function record(
  overrides: Partial<NotificationRecord> & Pick<NotificationRecord, "id">,
): NotificationRecord {
  return {
    notifier_id: 1,
    event_id: 1,
    title: `Notification ${overrides.id}`,
    body: "body text",
    status: "delivered",
    error: null,
    read_at: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

const NOTIFICATIONS: NotificationRecord[] = [
  record({ id: 3, title: "Newest", read_at: null }),
  record({ id: 2, title: "Read one", read_at: 1_700_000_100_000 }),
  record({
    id: 1,
    title: "Plain entry",
    body: "Some rendered body text",
    read_at: null,
  }),
];

beforeEach(() => {
  mockList.mockResolvedValue(NOTIFICATIONS);
  mockMarkRead.mockImplementation((id) =>
    Promise.resolve(record({ id, read_at: 1_700_000_200_000 })),
  );
  mockMarkAll.mockResolvedValue(2);
  mockUnreadCount.mockResolvedValue(2);
  mockSubscribe.mockReturnValue(() => {});
  // Default: the triggering event carries neither a dispatch id nor a url, so
  // clicks fall through to event focus unless a test overrides this.
  mockGetEvent.mockResolvedValue({
    id: 1,
    source: "s",
    type: "t",
    subject_kind: "k",
    subject_ref: "r",
    payload: {},
    ts: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Surfaces the router's current path + query so navigation can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/notifications"]}>
      <FluentProvider theme={webLightTheme}>
        <NotificationsProvider>
          <NotificationsPage />
        </NotificationsProvider>
        <LocationProbe />
      </FluentProvider>
    </MemoryRouter>,
  );
}

function currentLocation(): string {
  return screen.getByTestId("location").textContent ?? "";
}

describe("NotificationsPage", () => {
  it("renders a row per notification, newest-first", async () => {
    renderPage();
    const table = await screen.findByRole("table", { name: "Notifications" });
    const rows = within(table).getAllByRole("row");
    // Header + 3 data rows.
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByText("Newest")).toBeTruthy();
  });

  it("marks a single row read via the API and reconciles the unread count", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Notifications" });
    // The provider seeded the unread count once on mount.
    await waitFor(() => expect(mockUnreadCount).toHaveBeenCalledTimes(1));

    // The first unread row's mark-read button (row 3 is the newest, unread).
    const buttons = screen.getAllByRole("button", { name: "Mark read" });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(3));
    // refreshUnread re-reads the count after the mark.
    await waitFor(() => expect(mockUnreadCount).toHaveBeenCalledTimes(2));
  });

  it("marks all rows read and reloads the list", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Notifications" });

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(mockMarkAll).toHaveBeenCalledTimes(1));
    // A reload re-fetches the first page after the bulk mark.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("clicking a row marks it read and navigates to the run detail when the payload carries a dispatch id", async () => {
    mockGetEvent.mockResolvedValue({
      id: 1,
      source: "s",
      type: "run.completed",
      subject_kind: "k",
      subject_ref: "r",
      payload: { dispatch_id: 55, run_id: 9, url: "https://x/y" },
      ts: 0,
    });
    renderPage();
    const table = await screen.findByRole("table", { name: "Notifications" });

    const row = within(table).getByText("Newest").closest("tr");
    fireEvent.click(row as HTMLElement);

    await waitFor(() => expect(mockGetEvent).toHaveBeenCalledWith(1));
    // The run detail route resolves the id as a dispatch.
    await waitFor(() => expect(currentLocation()).toBe("/runs/55"));
    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(3));
  });

  it("clicking a row opens the payload url when there is no dispatch id", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mockGetEvent.mockResolvedValue({
      id: 1,
      source: "s",
      type: "t",
      subject_kind: "k",
      subject_ref: "r",
      payload: { url: "https://dev.azure.com/item/1" },
      ts: 0,
    });
    renderPage();
    const table = await screen.findByRole("table", { name: "Notifications" });

    const row = within(table).getByText("Plain entry").closest("tr");
    fireEvent.click(row as HTMLElement);

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://dev.azure.com/item/1",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(currentLocation()).toBe("/notifications");
    open.mockRestore();
  });

  it("clicking a row focuses the event when the payload carries neither field", async () => {
    // The beforeEach default payload is {} → event focus.
    renderPage();
    const table = await screen.findByRole("table", { name: "Notifications" });

    const row = within(table).getByText("Plain entry").closest("tr");
    fireEvent.click(row as HTMLElement);

    await waitFor(() => expect(currentLocation()).toBe("/events?id=1"));
  });

  it("clicking a row with a null event_id marks read but navigates nowhere", async () => {
    mockList.mockResolvedValue([
      record({ id: 7, title: "No trigger", event_id: null, read_at: null }),
    ]);
    renderPage();
    const table = await screen.findByRole("table", { name: "Notifications" });

    const row = within(table).getByText("No trigger").closest("tr");
    fireEvent.click(row as HTMLElement);

    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(7));
    expect(mockGetEvent).not.toHaveBeenCalled();
    expect(currentLocation()).toBe("/notifications");
  });

  it("clicking a row whose event 404s marks read but navigates nowhere", async () => {
    mockGetEvent.mockRejectedValue(new ApiError("event not found", 404));
    renderPage();
    const table = await screen.findByRole("table", { name: "Notifications" });

    const row = within(table).getByText("Newest").closest("tr");
    fireEvent.click(row as HTMLElement);

    await waitFor(() => expect(mockGetEvent).toHaveBeenCalledWith(1));
    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(3));
    expect(currentLocation()).toBe("/notifications");
  });

  it("the explicit mark-read button marks read without navigating", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Notifications" });

    const buttons = screen.getAllByRole("button", { name: "Mark read" });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(mockMarkRead).toHaveBeenCalledWith(3));
    expect(mockGetEvent).not.toHaveBeenCalled();
    expect(currentLocation()).toBe("/notifications");
  });

  it("disables mark-all-read when nothing is unread", async () => {
    mockList.mockResolvedValue([
      record({ id: 9, read_at: 1_700_000_300_000 }),
    ]);
    renderPage();
    await screen.findByRole("table", { name: "Notifications" });
    expect(
      (screen.getByRole("button", {
        name: "Mark all read",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows an empty state when there are no notifications", async () => {
    mockList.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("No notifications yet.")).toBeTruthy();
  });

  it("surfaces a load error", async () => {
    mockList.mockReset();
    mockList.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});

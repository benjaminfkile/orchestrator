import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getUnreadCount,
  subscribeNotificationStream,
  type NotificationRecord,
  type NotificationStreamHandlers,
} from "../notifications";
import { NotificationBell } from "./NotificationBell";
import { NotificationsProvider } from "./NotificationsProvider";

// The bell reads its count from the provider, which is driven entirely by these
// two calls; mock them so the tests are hermetic and can drive the stream.
vi.mock("../notifications", () => ({
  getUnreadCount: vi.fn(),
  subscribeNotificationStream: vi.fn(),
}));

const mockGetUnreadCount = vi.mocked(getUnreadCount);
const mockSubscribe = vi.mocked(subscribeNotificationStream);

/** Captured stream handlers so a test can simulate a pushed notification. */
let handlers: NotificationStreamHandlers | null = null;
const unsubscribe = vi.fn();

function record(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  return {
    id: 1,
    notifier_id: 1,
    event_id: 1,
    title: "Build failed",
    body: "See the run logs",
    status: "delivered",
    error: null,
    read_at: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  handlers = null;
  mockGetUnreadCount.mockResolvedValue(0);
  mockSubscribe.mockImplementation((h) => {
    handlers = h;
    return unsubscribe;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderBell() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <MemoryRouter initialEntries={["/"]}>
        <NotificationsProvider>
          <NotificationBell />
          <Routes>
            <Route path="/" element={<div>home page</div>} />
            <Route path="/notifications" element={<div>inbox page</div>} />
          </Routes>
        </NotificationsProvider>
      </MemoryRouter>
    </FluentProvider>,
  );
}

/** Push a notification through the captured stream handler, inside act(). */
function pushNotification(overrides: Partial<NotificationRecord> = {}) {
  act(() => {
    handlers?.onNotification(record(overrides));
  });
}

describe("NotificationBell", () => {
  it("shows no unread badge when the count is zero", async () => {
    renderBell();
    await waitFor(() => expect(mockGetUnreadCount).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeTruthy();
  });

  it("seeds the badge from the unread count", async () => {
    mockGetUnreadCount.mockResolvedValue(3);
    renderBell();
    await screen.findByRole("button", { name: "Notifications, 3 unread" });
  });

  it("increments the badge live when the stream pushes a notification", async () => {
    renderBell();
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());

    pushNotification();
    await screen.findByRole("button", { name: "Notifications, 1 unread" });

    pushNotification({ id: 2 });
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
  });

  it("raises a toast for each pushed notification", async () => {
    renderBell();
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());

    pushNotification();
    expect(await screen.findByText("Build failed")).toBeTruthy();
    expect(await screen.findByText("See the run logs")).toBeTruthy();
  });

  it("navigates to the inbox when clicked", async () => {
    renderBell();
    await waitFor(() => expect(mockGetUnreadCount).toHaveBeenCalled());
    expect(screen.getByText("home page")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("inbox page")).toBeTruthy();
  });

  it("unsubscribes from the stream on unmount", async () => {
    const { unmount } = renderBell();
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
